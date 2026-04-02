import { getCapitalSession }               from '../lib/session.js';
import { getMarketData }                   from '../lib/market_data.js';
import { calculateIndicators }             from '../lib/indicators.js';
import { generateSignal }                  from '../lib/strategy.js';
import { checkRisk, calculateDrawdown }              from '../lib/risk.js';
import { placeTrade, syncBalance, fetchClosedTradePnl, fetchBrokerTradeStats, fetchBrokerPositions, verifyExecutionCertainty, SYNC_WINDOW_MS, fetchCurrentGoldPrice } from '../lib/execution.js';
import { saveLog, getLogs }                from '../lib/logger.js';
import { loadState, saveState, saveStateWithOptions, saveStateCritical, dailyReset, acquireCandleLock, validateStateIntegrity, createLockOwnerToken, verifyCandleLockOwnership, renewCandleLock, releaseCandleLock } from '../lib/state.js';
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
      return { botState, haltReason: 'BROKER_STATE_UNAVAILABLE' };
    }

    // Build lookup of live positions STRICTLY by dealId
    const liveByDealId = new Map();
    for (const pos of livePositions) {
      const dealId = pos.position?.dealId;
      if (dealId) {
        liveByDealId.set(String(dealId), pos);
      } else {
        console.error('[SYNC] Broker position missing dealId', pos.position);
      }
    }

    const localTrades = Array.isArray(botState.openTrades) ? botState.openTrades : [];
    const stillOpen = [];
    const justClosed = [];

    // --- Phase 1: Reconcile existing local trades ---
    for (const trade of localTrades) {
      const dealId = trade.dealId ? String(trade.dealId) : null;
      
      if (!dealId) {
        console.error('[SYNC] Local trade missing dealId — this is a critical state error', trade);
        return {
          botState,
          haltReason: `LOCAL_TRADE_MISSING_DEAL_ID:${trade.tradeId || 'unknown'}`,
        };
      }

      const livePos = liveByDealId.get(dealId);

      if (livePos) {
        // Trade is still open on broker — reset sync-tracking fields
        trade.missingCount  = 0;
        trade.firstMissingAt = null;
        stillOpen.push(trade);
        // Remove from lookup to mark as "already tracked"
        liveByDealId.delete(dealId);
      } else {
        // Trade not found in live positions — check transaction history.
        // Set firstMissingAt on the very first cycle it disappears so we can
        // track elapsed time (wall-clock, not cycle count) for the sync window.
        if (!trade.firstMissingAt) {
          trade.firstMissingAt = Date.now();
          console.warn(`[SYNC] Trade ${dealId} first disappeared from active positions at ${new Date(trade.firstMissingAt).toISOString()}.`);
          await saveLog({
            signal: { id: trade.tradeId, action: trade.action, entryType: 'sync_event', entryPrice: null, strategyVersion: trade.strategyVersion || 'v1.1' },
            indicators: null,
            botState: { ...botState },
            tradeExecuted: false,
            reason: `SYNC_DISAPPEAR: dealId=${dealId} not found in active positions. firstMissingAt=${new Date(trade.firstMissingAt).toISOString()} | entry=${trade.entry}`,
            result: null,
          }).catch(() => {});
        }

        const elapsedMs  = Date.now() - trade.firstMissingAt;
        const elapsedMin = Math.floor(elapsedMs / 60000);

        // Check transaction history (internal retry handles transient API delays)
        const realizedPnl = await fetchClosedTradePnl(session, dealId, trade.openedAt);

        if (realizedPnl !== null) {
          trade.realizedPnl = realizedPnl;
          justClosed.push(trade);
          console.log(`[SYNC] ✅ Confirmed closure for dealId ${dealId} | P&L ${realizedPnl} | elapsed ${elapsedMin}m`);
        } else if (elapsedMs < SYNC_WINDOW_MS) {
          // Within sync window — keep tracked, do NOT block new trades
          console.warn(`[SYNC] Trade ${dealId} still missing from history (${elapsedMin}m / ${Math.floor(SYNC_WINDOW_MS / 60000)}m). Awaiting broker sync.`);
          await saveLog({
            signal: { id: trade.tradeId, action: trade.action, entryType: 'sync_event', entryPrice: null, strategyVersion: trade.strategyVersion || 'v1.1' },
            indicators: null,
            botState: { ...botState },
            tradeExecuted: false,
            reason: `SYNC_RETRY: dealId=${dealId} still missing at ${elapsedMin}m. Awaiting transaction history (window: ${Math.floor(SYNC_WINDOW_MS / 60000)}m).`,
            result: null,
          }).catch(() => {});
          stillOpen.push(trade);
        } else {
          // Sync window exceeded — force-resolve as closed.
          // Attempt P&L estimation using a live GOLD price snapshot.
          // If estimation is impossible, realizedPnl is set to null (not $0) so that
          // anti-chop streak logic is NOT corrupted by a fake zero-P&L entry.
          let estimatedPnl = null;
          try {
            const priceSnapshot = await fetchCurrentGoldPrice(session);
            if (
              priceSnapshot &&
              Number.isFinite(trade.entry) && trade.entry > 0 &&
              Number.isFinite(trade.size)  && trade.size  > 0 &&
              (trade.action === 'BUY' || trade.action === 'SELL')
            ) {
              const currentPrice = trade.action === 'BUY' ? priceSnapshot.bid : priceSnapshot.offer;
              if (Number.isFinite(currentPrice) && currentPrice > 0) {
                estimatedPnl = parseFloat(
                  ((currentPrice - trade.entry) * (trade.action === 'BUY' ? 1 : -1) * trade.size).toFixed(2)
                );
              }
            }
          } catch (_) { /* estimatedPnl remains null */ }

          trade.realizedPnl  = estimatedPnl;
          trade.isMIA        = true;
          trade.fallbackUsed = true;
          justClosed.push(trade);

          const pnlDesc = estimatedPnl !== null
            ? `estimated $${estimatedPnl.toFixed(2)}`
            : 'unknown (null — excluded from performance metrics)';
          console.error(`[SYNC] ⚠️ FALLBACK_RESOLUTION_USED: dealId=${dealId} missing after ${elapsedMin}m. Forcing closure. P&L: ${pnlDesc}`);
          await sendAlert(
            `⚠️ FALLBACK RESOLUTION: Trade ${dealId} (${trade.action}) disappeared after ${elapsedMin}m without history.\n` +
            `P&L: ${pnlDesc}\nEntry: $${trade.entry?.toFixed(2) ?? '?'} | Size: ${trade.size}oz\n` +
            `Check broker for manual closure or liquidation.`
          ).catch(() => {});
        }
      }
    }

    // --- Phase 2: Process confirmed closures ---
    for (const closedTrade of justClosed) {
      const dealId      = closedTrade.dealId;
      const realizedPnl = closedTrade.realizedPnl;
      const pnlStr      = realizedPnl != null ? `$${realizedPnl.toFixed(2)}` : 'null (unknown)';
      const closureTag  = closedTrade.fallbackUsed ? 'FALLBACK_RESOLUTION_USED' : 'CONFIRMED';

      console.log(`[SYNC] ❌ TRADE CLOSED [${closureTag}]: ${closedTrade.action} ${closedTrade.size}oz GOLD | dealId=${dealId} | entry=${closedTrade.entry} | P&L=${pnlStr}`);

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
        reason: `CLOSED: ${closureTag} | Realized P&L: ${pnlStr} | entry=${closedTrade.entry} | dealId=${dealId}`,
        result: { realizedPnl, fallbackUsed: closedTrade.fallbackUsed || false }
      });

      // Only send a closure alert for confirmed closures — fallback closures already
      // sent an alert during Phase 1 when force-resolution was triggered.
      if (!closedTrade.fallbackUsed && realizedPnl != null) {
        await sendAlert(
          `📉 Trade CLOSED: ${closedTrade.action} Gold\n` +
          `Entry: $${closedTrade.entry?.toFixed(2) ?? '?'}\n` +
          `P&L: ${pnlStr}\n` +
          `dealId: ${dealId}`
        );
      }
    }

    // --- Phase 3: Adopt remaining broker positions ---
    // Any broker positions left in liveByDealId are NOT tracked locally.
    for (const [dealId, pos] of liveByDealId) {
      const brokerSize = Number(pos.position?.size ?? pos.position?.dealSize);
      const brokerDirection = String(pos.position?.direction || '').toUpperCase();
      const brokerEpic = pos.market?.epic || pos.position?.instrumentName || 'GOLD';

      if (!Number.isFinite(brokerSize) || brokerSize <= 0 || (brokerDirection !== 'BUY' && brokerDirection !== 'SELL')) {
        console.error(`[SYNC] Invalid broker position data for ${dealId}`, pos);
        continue;
      }

      // STRICT ANTI-DUPLICATION
      const alreadyTracked = stillOpen.some(t => String(t.dealId) === String(dealId));
      if (alreadyTracked) {
        console.warn(`[SYNC] Anti-duplication: Skipping adoption of ${dealId} as it is already tracked.`);
        continue;
      }

      const adoptedTrade = {
        tradeId:         `adopted_${dealId}`,
        dealId:          dealId,
        dealReference:   pos.position?.dealReference || null,
        pair:            brokerEpic,
        action:          brokerDirection,
        entry:           Number(pos.position?.openLevel ?? pos.position?.level ?? 0),
        size:            brokerSize,
        stopLoss:        Number(pos.position?.stopLevel ?? 0) || null,
        takeProfit:      Number(pos.position?.limitLevel ?? 0) || null,
        notionalValue:   null,
        marginRequired:  null,
        actualRiskDollars: null,
        openedAt:        pos.position?.createdDateUTC ? new Date(pos.position.createdDateUTC).getTime() : Date.now(),
        strategyVersion: 'adopted',
        missingCount:    0,
      };

      stillOpen.push(adoptedTrade);
      console.warn(`[SYNC] ⚠️ ADOPTED untracked broker position: ${brokerDirection} ${brokerSize}oz ${brokerEpic} | dealId=${dealId}`);
      await sendAlert(`⚠️ Bot adopted untracked broker position: ${brokerDirection} ${brokerSize}oz ${brokerEpic} | dealId=${dealId}`).catch(() => {});
    }

    botState.openTrades = [...stillOpen];
    botState.lastStateSyncAt = Date.now();

    if (justClosed.length > 0) {
      // Track ALL outcomes (wins AND losses) so that a win resets the anti-chop streak.
      // Previously only losses were pushed, which meant the anti-chop could never be
      // cleared once 2 consecutive losses accumulated — effectively disabling the bot
      // permanently after 2 losses until a manual Redis state reset.
      //
      // Idempotency: use dealId to prevent duplicate entries if the same trade is
      // processed more than once (e.g. after a retry cycle).
      // Null P&L (fallback-resolved MIA trades) is intentionally excluded so that a
      // forced $0 closure cannot corrupt the anti-chop loss-streak counter.
      botState.recentOutcomes = Array.isArray(botState.recentOutcomes) ? botState.recentOutcomes : [];
      const existingDealIds   = new Set(botState.recentOutcomes.map(o => o.dealId).filter(Boolean));
      const outcomes = justClosed
        .filter(t => typeof t.realizedPnl === 'number' && !existingDealIds.has(t.dealId))
        .map(t => ({
          pnl:      t.realizedPnl,
          action:   t.action,
          closedAt: Date.now(),
          ref:      t.dealReference,
          dealId:   t.dealId,
        }));
      if (outcomes.length > 0) {
        botState.recentOutcomes.push(...outcomes);
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
  // ── Authorization ─────────────────────────────────────────────────────────
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  const providedAuth = req.headers['authorization'] || req.headers['Authorization'];
  if (process.env.CRON_SECRET && providedAuth !== expectedAuth) {
    console.warn('Unauthorized cron trigger attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let botState;
  let lockHandle = null;
  let invocationStateVersion = 0;

  // ── Security: Validate CRON_SECRET strength ───────────────────────────────
  if (process.env.CRON_SECRET) {
    if (process.env.CRON_SECRET.length < 10) {
      const msg = '⚠️ CRON_SECRET is too weak (less than 10 chars). Use 32+ random characters.';
      console.error(msg);
      return res.status(500).json({ error: msg });
    }
    // Check if it looks like a predictably short string (e.g., 'goldbot2026', 'password123')
    if (/^[a-z0-9]{1,8}$/i.test(process.env.CRON_SECRET)) {
      const msg = '⚠️ CRON_SECRET looks too simple (too short/alphanumeric only). Use complex random string.';
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

  // ── Kill switch (fast path) ──────────────────────────────────────────────
  if (process.env.BOT_ENABLED !== 'true') {
    return res.json({ skipped: 'Bot disabled via BOT_ENABLED env variable' });
  }

  try {
    // ── Step 1: Load state + daily reset ─────────────────────────────────────
    botState = await loadState();
    botState = dailyReset(botState);
    invocationStateVersion = Number.isFinite(Number(botState.stateVersion))
      ? Number(botState.stateVersion)
      : 0;

    // ── State integrity check ─────────────────────────────────────────────────
    if (botState.stateIntegrityOk === false) {
      const msg = 'State integrity compromised — manual review required';
      console.error(`[CRON] ⚠️ ${msg}`);
      
      // Still log a heartbeat so the user knows why it's silent in the dashboard
      await saveLog({ 
        signal: null, 
        indicators: null, 
        botState, 
        tradeExecuted: false, 
        reason: `HALTED: ${botState.criticalFailureReason || msg}` 
      }).catch(() => {});

      await sendAlert(`🚨 Bot halted: State integrity compromised. Check Upstash and reset stateIntegrityOk=true after review.`).catch(() => {});
      return res.json({ skipped: msg });
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
      const reason = 'SKIP: BROKER_ACCOUNT_STATE_UNAVAILABLE';
      console.warn(`[CRON] ${reason}`);
      await saveLog({ signal: null, indicators: null, botState, tradeExecuted: false, reason });
      await saveState(botState);
      return res.json({ skipped: reason });
    }
    if (botState.balance > botState.peakBalance) {
      botState.peakBalance = botState.balance;
    }

    // ── Step 4: Reconcile positions (replaces old syncOpenTrades) ─────────────
    const reconcileResult = await reconcilePositions(session, botState);
    botState = reconcileResult.botState;
    if (reconcileResult.haltReason) {
      // Reconcile errors (e.g. network timeout) should be SKIPS, not permanent HALTS
      // to avoid manual resets on every minor broker lag.
      const reason = `SKIP: RECONCILIATION_FAILED:${reconcileResult.haltReason}`;
      console.warn(`[CRON] ${reason}`);
      await saveLog({ signal: null, indicators: null, botState, tradeExecuted: false, reason });
      await saveState(botState);
      return res.json({ skipped: reason });
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
    
    const equityDrawdown = calculateDrawdown(botState.peakBalance, botState.equity || botState.balance);
    botState.totalDrawdown = parseFloat(equityDrawdown.toFixed(2));
    botState.riskDataFresh = true;
    botState.lastRiskSyncAt = Date.now();
    
    console.log(`[CRON] Risk Sync: DailyLoss AED ${botState.dailyLoss.toFixed(2)}, TotalDrawdown ${botState.totalDrawdown}%`);

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
      await saveStateWithOptions(botState, { expectedVersion: invocationStateVersion });
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
      await saveStateWithOptions(botState, { expectedVersion: invocationStateVersion });
      return res.json({ skipped: 'SKIP: Missing execution lock handle' });
    }

    const lockOwnedBeforeExecution = await verifyCandleLockOwnership(lockHandle);
    if (!lockOwnedBeforeExecution) {
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: 'SKIP: Lock ownership lost before execution', signalDebug });
      await saveStateWithOptions(botState, { expectedVersion: invocationStateVersion });
      return res.json({ skipped: 'SKIP: Lock ownership lost before execution' });
    }

    const lockRenewedBeforeExecution = await renewCandleLock(lockHandle, 120);
    if (!lockRenewedBeforeExecution) {
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: 'SKIP: Lock renewal failed before execution', signalDebug });
      await saveStateWithOptions(botState, { expectedVersion: invocationStateVersion });
      return res.json({ skipped: 'SKIP: Lock renewal failed before execution' });
    }

    const certainty = await verifyExecutionCertainty(session, botState);
    if (!certainty.ok) {
      if (certainty.reason.includes('LOCAL_NOT_ON_BROKER') || certainty.reason.includes('BROKER_NOT_LOCAL')) {
        const skipReason = `SKIP: Race condition detected during execution gate (${certainty.reason})`;
        console.warn(`[CRON] ${skipReason}`);
        botState.lastHeartbeat = Date.now();
        await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: skipReason, signalDebug });
        await saveStateWithOptions(botState, { expectedVersion: invocationStateVersion });
        return res.json({ skipped: skipReason });
      }

      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = certainty.reason;
      await saveStateCritical(botState, `execution_barrier:${certainty.reason}`);
      return res.json({ skipped: certainty.reason });
    }

    const lockOwnedAtExecution = await verifyCandleLockOwnership(lockHandle);
    if (!lockOwnedAtExecution) {
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: 'SKIP: Lock ownership lost at execution gate', signalDebug });
      await saveStateWithOptions(botState, { expectedVersion: invocationStateVersion });
      return res.json({ skipped: 'SKIP: Lock ownership lost at execution gate' });
    }

    const lockRenewedAtExecution = await renewCandleLock(lockHandle, 120);
    if (!lockRenewedAtExecution) {
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: 'SKIP: Lock renewal failed at execution gate', signalDebug });
      await saveStateWithOptions(botState, { expectedVersion: invocationStateVersion });
      return res.json({ skipped: 'SKIP: Lock renewal failed at execution gate' });
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
      dealId:        tradeResult.dealId,
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
