import { getCapitalSession }               from '../lib/session.js';
import { getMarketData }                   from '../lib/market_data.js';
import { calculateIndicators }             from '../lib/indicators.js';
import { generateSignal }                  from '../lib/strategy.js';
import { checkRisk }                       from '../lib/risk.js';
import { placeTrade, syncBalance, fetchClosedTradePnl, fetchBrokerTradeStats, fetchBrokerPositions, verifyExecutionCertainty } from '../lib/execution.js';
import { saveLog, getLogs }                from '../lib/logger.js';
import { loadState, saveState, saveStateCritical, dailyReset, acquireCandleLock, validateStateIntegrity, createLockOwnerToken, verifyCandleLockOwnership, renewCandleLock, releaseCandleLock } from '../lib/state.js';
import { sendAlert, checkPerformance }     from '../lib/monitor.js';
import { fetchWithTimeout }                from '../lib/fetch.js';


/**
 * Reconciles local openTrades with broker's actual open positions.
 * 
 * DESIGN PRINCIPLES:
 * 1. Broker is the source of truth — if it's not on the broker, it's closed.
 * 2. If a position exists on broker but NOT locally, ADOPT it (not "discover" it).
 *    This means rebuilding local state from broker data so it's properly tracked.
 * 3. Every state change (close detected, position adopted) triggers an immediate save.
 * 4. All transitions are logged with structured [SYNC] prefix.
 */
async function reconcilePositions(session, botState) {
  try {
    const livePositions = await fetchBrokerPositions(session);

    if (livePositions === null) {
      return {
        botState,
        haltReason: 'BROKER_STATE_UNAVAILABLE',
      };
    }

    // Build lookup of live deal references
    const liveDealRefs = new Map();
    for (const pos of livePositions) {
      const ref = pos.position?.dealReference;
      if (ref) liveDealRefs.set(ref, pos);
    }

    const localTrades = Array.isArray(botState.openTrades) ? botState.openTrades : [];
    const stillOpen = [];
    const justClosed = [];

    for (const trade of localTrades) {
      if (trade.dealReference && liveDealRefs.has(trade.dealReference)) {
        trade.missingCount = 0;
        stillOpen.push(trade);
        liveDealRefs.delete(trade.dealReference);
      } else {
        let realizedPnl = await fetchClosedTradePnl(session, trade.dealReference, trade.openedAt);

        if (realizedPnl !== null) {
          trade.realizedPnl = realizedPnl;
          justClosed.push(trade);
        } else {
          return {
            botState,
            haltReason: `RECONCILIATION_UNCERTAIN_MISSING_TRADE:${trade.dealReference || 'unknown'}`,
          };
        }
      }
    }

    // ── Phase 2: Process confirmed closures ────────────────────────────────────
    for (const closedTrade of justClosed) {
      console.log(`[SYNC] ❌ TRADE CLOSED: ${closedTrade.action} ${closedTrade.size}oz GOLD | ref=${closedTrade.dealReference} | entry=${closedTrade.entry}`);
      
      const realizedPnl = closedTrade.realizedPnl;
      const pnlStr = realizedPnl != null ? `$${realizedPnl.toFixed(2)}` : 'Unknown';
      console.log(`[SYNC] P&L for ${closedTrade.dealReference}: ${pnlStr}`);

      await saveLog({
        signal: {
          id: closedTrade.tradeId,
          action: closedTrade.action === 'BUY' ? 'SELL' : 'BUY',
          entryType: 'closure',
          entryPrice: null,
          strategyVersion: closedTrade.strategyVersion || 'v1.1'
        },
        indicators: null,
        botState: { ...botState },
        tradeExecuted: false,
        reason: `CLOSED: Realized P&L: ${pnlStr} | entry=${closedTrade.entry} | ref=${closedTrade.dealReference}`,
        result: { realizedPnl }
      });

      if (realizedPnl != null) {
        await sendAlert(
          `📉 Trade CLOSED: ${closedTrade.action} Gold\n` +
          `Entry: $${closedTrade.entry?.toFixed(2) ?? '?'}\n` +
          `P&L: ${pnlStr}\n` +
          `Ref: ${closedTrade.dealReference}`
        );
      }
    }

    // Any broker positions not tracked locally are uncertainty, not auto-adoption.
    if (liveDealRefs.size > 0) {
      const unknownRef = Array.from(liveDealRefs.keys())[0];
      return {
        botState,
        haltReason: `RECONCILIATION_UNCERTAIN_UNKNOWN_BROKER_POSITION:${unknownRef}`,
      };
    }

    botState.openTrades = [...stillOpen];
    botState.lastStateSyncAt = Date.now();

    if (justClosed.length > 0) {
      const losses = justClosed
        .filter(t => typeof t.realizedPnl === 'number' && t.realizedPnl < 0)
        .map(t => ({ pnl: t.realizedPnl, action: t.action, closedAt: Date.now(), ref: t.dealReference }));
      if (losses.length > 0) {
        botState.recentOutcomes = Array.isArray(botState.recentOutcomes) ? botState.recentOutcomes : [];
        botState.recentOutcomes.push(...losses);
        botState.recentOutcomes = botState.recentOutcomes.slice(-20);
      }

      const saved = await saveStateCritical(botState, `reconcile:closed=${justClosed.length}`);
      if (!saved) {
        return {
          botState,
          haltReason: 'CRITICAL_FAILURE:RECONCILIATION_SAVE_FAILED',
        };
      }
    }

    return { botState, haltReason: null };
  } catch (err) {
    return {
      botState,
      haltReason: `RECONCILIATION_ERROR:${err.message}`,
    };
  }
}

export default async function handler(req, res) {
  let botState;
  let lockHandle = null;

  // ── Security: Validate CRON_SECRET strength ───────────────────────────────
  if (process.env.CRON_SECRET) {
    if (process.env.CRON_SECRET.length < 16) {
      const msg = '⚠️ CRON_SECRET is too weak (less than 16 chars). Use 32+ random characters.';
      console.error(msg);
      return res.status(500).json({ error: msg });
    }
    // Check if it looks like a predictable string (e.g., 'goldbot2026', 'password123')
    if (/^[a-z0-9]{1,20}$/i.test(process.env.CRON_SECRET)) {
      const msg = '⚠️ CRON_SECRET looks too simple (lowercase/numbers only). Use complex random string.';
      console.error(msg);
      return res.status(500).json({ error: msg });
    }
  }

  // ── CRITICAL: Enforce live trading safety flag ──────────────────────────
  const isLiveMode = process.env.CAPITAL_ENV === 'live';
  const liveTradeConfirmed = process.env.LIVE_TRADING_MODE === 'CONFIRMED_REAL_MONEY';
  
  if (isLiveMode && !liveTradeConfirmed) {
    const msg = '⚠️ LIVE MODE DISABLED: Set LIVE_TRADING_MODE=CONFIRMED_REAL_MONEY to enable live trading. Set CAPITAL_ENV=demo to use paper trading.';
    console.error(msg);
    return res.status(403).json({ error: msg });
  }

  if (isLiveMode && liveTradeConfirmed) {
    console.warn('🔴 === LIVE TRADING MODE ACTIVE === REAL MONEY AT RISK === 🔴');
  }

  // ── Authorization ─────────────────────────────────────────────────────────
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  const providedAuth = req.headers['authorization'] || req.headers['Authorization'];
  if (process.env.CRON_SECRET && providedAuth !== expectedAuth) {
    console.warn('Unauthorized cron trigger attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── Kill switch (fast path) ──────────────────────────────────────────────
  if (process.env.BOT_ENABLED !== 'true') {
    return res.json({ skipped: 'Bot disabled via BOT_ENABLED env variable' });
  }

  try {
    // ── Step 1: Load state + daily reset ─────────────────────────────────────
    botState = await loadState();
    botState = dailyReset(botState);

    // ── State integrity check ─────────────────────────────────────────────────
    if (botState.stateIntegrityOk === false) {
      console.error('[CRON] ⚠️ State integrity compromised — halting until manual review');
      await sendAlert('🚨 Bot halted: State integrity compromised. Check Upstash and reset stateIntegrityOk=true after review.').catch(() => {});
      return res.json({ skipped: 'State integrity compromised — manual review required' });
    }

    // ── State kill switch (fast path) ────────────────────────────────────────
    if (botState.botEnabled === false) {
      return res.json({ skipped: 'Bot disabled via state (drawdown or performance threshold)' });
    }

    if (botState.criticalFailure === true) {
      return res.json({ skipped: `Critical failure active: ${botState.criticalFailureReason || 'manual review required'}` });
    }

    // ── Step 2: Authenticate with Capital.com ─────────────────────────────────
    let session;
    try {
      session = await getCapitalSession();
    } catch (err) {
      const reason = `SKIP: Capital.com auth failed - ${err.message}`;
      await saveLog({ signal: null, indicators: null, botState, tradeExecuted: false, reason });
      await saveState(botState);
      return res.json({ skipped: reason });
    }

    // ── Step 3: Sync real balance AND equity from Capital.com ─────────────────
    botState = await syncBalance(session, botState);
    if (!Number.isFinite(botState.balance) || !Number.isFinite(botState.equity) || !Number.isFinite(botState.availableMargin)) {
      botState.stateIntegrityOk = false;
      botState.botEnabled = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = 'ACCOUNT_STATE_UNAVAILABLE';
      await saveStateCritical(botState, 'account_state_unavailable');
      return res.json({ skipped: 'BROKER_STATE_UNAVAILABLE' });
    }
    if (botState.balance > botState.peakBalance) {
      botState.peakBalance = botState.balance;
    }

    // ── Step 4: Reconcile positions (replaces old syncOpenTrades) ─────────────
    const reconcileResult = await reconcilePositions(session, botState);
    botState = reconcileResult.botState;
    if (reconcileResult.haltReason) {
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = reconcileResult.haltReason;
      await saveStateCritical(botState, `reconcile_halt:${reconcileResult.haltReason}`);
      return res.json({ skipped: reconcileResult.haltReason });
    }

    // ── STATE INTEGRITY CHECK: Validate after reconciliation ──────────────────
    if (!validateStateIntegrity(botState, 'post-reconciliation')) {
      console.error('[CRON] ⚠️ State integrity compromised after reconciliation — halting');
      await saveState(botState); // Save the corrupted state flag
      await sendAlert('🚨 Bot halted: State integrity check failed after position reconciliation. Manual review required.').catch(() => {});
      return res.json({ error: 'State integrity failed after reconciliation' });
    }

    // ── Sync actual trade stats from broker ─────────────────────────────────
    const brokerStats = await fetchBrokerTradeStats(session);
    if (!brokerStats) {
      botState.riskDataFresh = false;
      botState.lastRiskSyncAt = 0;
      await saveState(botState);
      return res.json({ skipped: 'BROKER_STATS_UNAVAILABLE' });
    }

    if (brokerStats) {
      console.log(`[CRON] Broker Sync: Today ${brokerStats.todayTrades}, Win rate ${brokerStats.todayWinRate}%`);
      botState.dailyTrades        = brokerStats.todayTrades;
      botState.todayTrades        = brokerStats.todayTrades;
      botState.todayBuys          = brokerStats.todayBuys;
      botState.todaySells         = brokerStats.todaySells;
      botState.todayWinRate       = brokerStats.todayWinRate;
      botState.todayBest          = brokerStats.todayBest;
      botState.todayWorst         = brokerStats.todayWorst;

      botState.brokerTotalTrades  = brokerStats.totalTrades;
      botState.brokerTotalPnl     = brokerStats.totalPnl;
      botState.brokerWins         = brokerStats.wins;
      botState.brokerLosses       = brokerStats.losses;
      botState.brokerWinRate      = brokerStats.winRate;
      botState.brokerBestTrade    = brokerStats.bestTrade;
      botState.brokerWorstTrade   = brokerStats.worstTrade;
      botState.brokerGrossProfit  = brokerStats.grossProfit;
      botState.brokerGrossLoss    = brokerStats.grossLoss;
      botState.lastBrokerSync     = brokerStats.syncedAt;

      // ── Broker-Based Risk Metrics ────────────────────────────────────────────
      const todayPnlAED = brokerStats.todayNetPnl;
      botState.dailyLoss = todayPnlAED < 0 ? Math.abs(todayPnlAED) : 0;

      const currentTotalPnl = brokerStats.totalPnl;
      const peakPnl = parseFloat(botState.peakBrokerPnl) || 0;
      if (currentTotalPnl > peakPnl) botState.peakBrokerPnl = currentTotalPnl;
      
      const pnlDrawdownAED = (peakPnl > currentTotalPnl) ? (peakPnl - currentTotalPnl) : 0;
      const currentBalanceAED = parseFloat(botState.balance) || 1;
      botState.totalDrawdown = parseFloat(((pnlDrawdownAED / currentBalanceAED) * 100).toFixed(2));
      botState.riskDataFresh = true;
      botState.lastRiskSyncAt = Date.now();
      
      console.log(`[CRON] Risk Sync: DailyLoss AED ${botState.dailyLoss.toFixed(2)}, TotalDrawdown ${botState.totalDrawdown}%`);
    }

    // ── Step 5 & 6: Fetch market data and Indicators ─────────────────────────
    const marketData = await getMarketData(session, botState);

    let indicators = null;
    if (marketData.candles5m && marketData.candles1h) {
      botState.candles5m = marketData.candles5m;
      // Only advance the processed candle time if we are not skipping due to duplicate
      if (!marketData.skip) {
        const ownerToken = createLockOwnerToken();
        lockHandle = await acquireCandleLock(marketData.latestCandleTime, ownerToken);
        if (!lockHandle) {
           console.warn(`[CRON] ⚠️ Concurrency lock FAILED for candle ${marketData.latestCandleTime}`);
           console.warn(`[CRON]    → Another invocation is already processing this candle`);
           console.warn(`[CRON]    → This prevents duplicate trades on the same signal`);
           marketData.skip = true;
           marketData.reason = `SKIP: Concurrency lock blocked this invocation (candle ${marketData.latestCandleTime} already being processed by another instance)`;
        } else {
           botState.lastProcessedCandle = marketData.latestCandleTime;
           console.log(`[CRON] ✓ Candle lock acquired for ${marketData.latestCandleTime} — this invocation will process signals`);
        }
      }

      // Calculate indicators even on skips for dashboard live values
      indicators = calculateIndicators(marketData.candles5m, marketData.candles1h);
      indicators.spread = marketData.spread ?? null;
    }

    // If market data skipped OR indicators skipped:
    if (marketData.skip || (indicators && indicators.skip)) {
      const reason = marketData.skip ? marketData.reason : indicators.reason;
      
      let signalDebug = undefined;
      // Evaluate strategy purely for debug telemetry even if this cycle is skipping
      if (indicators && !indicators.skip && marketData.candles1m) {
        const generated = generateSignal(indicators, marketData.candles1m);
        signalDebug = generated.debug;
      }

      botState.lastHeartbeat = Date.now();
      await saveLog({ signal: null, indicators, botState, tradeExecuted: false, reason, signalDebug });
      await saveState(botState);
      return res.json({ skipped: reason });
    }

    // ── Step 7: Generate signal ───────────────────────────────────────────────
    const { signal, debug: signalDebug } = generateSignal(indicators, marketData.candles1m);

    // ── Step 8: Risk checks ───────────────────────────────────────────────────
    const riskResult = checkRisk(signal, botState, indicators);

    if (riskResult !== 'APPROVED') {
      if (riskResult.startsWith('STOP:') || riskResult.startsWith('DISABLE:')) {
        await sendAlert(`🚨 ${riskResult}`).catch(() => {});
      }
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: riskResult, signalDebug });
      await saveState(botState);
      return res.json({ skipped: riskResult });
    }

    if (!lockHandle) {
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: 'SKIP: Missing execution lock handle', signalDebug });
      await saveState(botState);
      return res.json({ skipped: 'SKIP: Missing execution lock handle' });
    }

    const lockOwnedBeforeExecution = await verifyCandleLockOwnership(lockHandle);
    if (!lockOwnedBeforeExecution) {
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: 'SKIP: Lock ownership lost before execution', signalDebug });
      await saveState(botState);
      return res.json({ skipped: 'SKIP: Lock ownership lost before execution' });
    }

    await renewCandleLock(lockHandle, 120);

    const certainty = await verifyExecutionCertainty(session, botState);
    if (!certainty.ok) {
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = certainty.reason;
      await saveStateCritical(botState, `execution_barrier:${certainty.reason}`);
      return res.json({ skipped: certainty.reason });
    }

    // ── Step 9: Place trade ───────────────────────────────────────────────────
    const tradeResult = await placeTrade(session, signal, botState);

    if (!tradeResult.success) {
      if (String(tradeResult.reason || '').startsWith('CRITICAL_FAILURE')) {
        botState.botEnabled = false;
        botState.stateIntegrityOk = false;
        botState.criticalFailure = true;
        botState.criticalFailureReason = tradeResult.reason;
      }
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: tradeResult.reason, signalDebug });
      await saveState(botState);
      return res.json({ skipped: tradeResult.reason });
    }

    // ── Step 10: Log success ──────────────────────────────────────────────────
    botState.lastHeartbeat = Date.now();
    await saveLog({ signal, indicators, botState, tradeExecuted: true, result: tradeResult, reason: null, signalDebug });
    await saveState(botState);

    // ── Step 11: Performance check (fires every 50 executed trades) ───────────
    const logs = await getLogs();
    await checkPerformance(logs, botState);

    // ── Step 12: Trade alert ──────────────────────────────────────────────────
    await sendAlert(
      `✅ ${signal.action} GOLD [${signal.entryType}]\n` +
      `Entry: $${signal.entryPrice.toFixed(2)}\n` +
      `SL: $${signal.stopLoss.toFixed(2)} | TP: $${signal.takeProfit.toFixed(2)}\n` +
      `Size: ${tradeResult.size}oz | Score: ${signal.score} | ATR: ${signal.atr.toFixed(2)}\n` +
      `Balance: AED ${parseFloat(botState.balance).toFixed(2)} | Equity: AED ${parseFloat(botState.equity || botState.balance).toFixed(2)} | Daily trades: ${botState.dailyTrades}/10`
    );

    return res.json({
      success:      true,
      action:       signal.action,
      entryType:    signal.entryType,
      entry:        signal.entryPrice,
      stopLoss:     signal.stopLoss,
      takeProfit:   signal.takeProfit,
      size:         tradeResult.size,
      score:        signal.score,
      dealReference: tradeResult.dealReference,
    });

  } catch (err) {
    // Catastrophic error — log, alert, save state if possible
    console.error('[CRON] Pipeline error:', err.message, err.stack);
    if (botState) {
      if (err?.code === 'FETCH_TIMEOUT') {
        botState.botEnabled = false;
        botState.stateIntegrityOk = false;
        botState.criticalFailure = true;
        botState.criticalFailureReason = 'CRITICAL_TIMEOUT';
      }
      try { await saveState(botState); } catch (_) {}
    }
    await sendAlert(`🚨 Bot pipeline error: ${err.message}`).catch(() => {});
    return res.status(500).json({ error: err.message });
  } finally {
    if (lockHandle) {
      await releaseCandleLock(lockHandle).catch(() => {});
    }
  }
}
