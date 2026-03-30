import { getCapitalSession }               from '../lib/session.js';
import { getMarketData }                   from '../lib/market_data.js';
import { calculateIndicators }             from '../lib/indicators.js';
import { generateSignal }                  from '../lib/strategy.js';
import { checkRisk }                       from '../lib/risk.js';
import { placeTrade, syncBalance, fetchClosedTradePnl, fetchBrokerTradeStats, fetchBrokerPositions } from '../lib/execution.js';
import { saveLog, getLogs }                from '../lib/logger.js';
import { loadState, saveState, saveStateCritical, dailyReset, acquireCandleLock } from '../lib/state.js';
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
      console.warn('[SYNC] Could not fetch broker positions — keeping existing local state');
      return botState;
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

    // ── Phase 1: Check which local trades are still open on broker ────────────
    for (const trade of localTrades) {
      if (trade.dealReference && liveDealRefs.has(trade.dealReference)) {
        stillOpen.push(trade);
        // Remove from live map so Phase 2 only contains truly untracked positions
        liveDealRefs.delete(trade.dealReference);
      } else {
        justClosed.push(trade);
      }
    }

    // ── Phase 2: Process detected closures ────────────────────────────────────
    for (const closedTrade of justClosed) {
      console.log(`[SYNC] ❌ TRADE CLOSED: ${closedTrade.action} ${closedTrade.size}oz GOLD | ref=${closedTrade.dealReference} | entry=${closedTrade.entry}`);
      
      let realizedPnl = await fetchClosedTradePnl(session, closedTrade.dealReference, closedTrade.openedAt);
      
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

    // ── Phase 3: Adopt any broker positions missing from local state ──────────
    // This replaces the old "discovered" logic — positions are ADOPTED, not discovered.
    // They become fully managed with proper tracking from this point forward.
    const adoptedPositions = [];
    for (const [ref, pos] of liveDealRefs) {
      const posData = pos.position;
      if (!posData) continue;

      const adopted = {
        tradeId:         `adopted_${ref}_${Date.now()}`,
        dealReference:   ref,
        pair:            'GOLD',
        action:          posData.direction,
        entry:           parseFloat(posData.level),
        size:            parseFloat(posData.size),
        stopLoss:        parseFloat(posData.stopLevel || 0),
        takeProfit:      parseFloat(posData.limitLevel || 0),
        openedAt:        posData.createdDate ? new Date(posData.createdDate).getTime() : Date.now(),
        strategyVersion: 'v1.1 (adopted)',
        adoptedAt:       Date.now(),
      };

      adoptedPositions.push(adopted);
      console.log(
        `[SYNC] ⚠️ ADOPTED position from broker: ${adopted.action} ${adopted.size}oz @ ${adopted.entry} | ref=${ref} | ` +
        `SL=${adopted.stopLoss} TP=${adopted.takeProfit}`
      );

      await sendAlert(
        `⚠️ Adopted untracked position:\n` +
        `${adopted.action} ${adopted.size}oz GOLD @ $${adopted.entry.toFixed(2)}\n` +
        `Ref: ${ref}\n` +
        `This position was on broker but missing locally. Now tracked.`
      );
    }

    // ── Phase 4: Rebuild openTrades from reconciled data ──────────────────────
    botState.openTrades = [...stillOpen, ...adoptedPositions];
    botState.lastStateSyncAt = Date.now();

    // Log summary
    const summary = {
      localBefore: localTrades.length,
      brokerPositions: livePositions.length,
      stillOpen: stillOpen.length,
      closed: justClosed.length,
      adopted: adoptedPositions.length,
      localAfter: botState.openTrades.length,
    };
    console.log(`[SYNC] Reconciliation complete: ${JSON.stringify(summary)}`);

    // ── CRITICAL SAVE if any state changed ────────────────────────────────────
    if (justClosed.length > 0 || adoptedPositions.length > 0) {
      await saveStateCritical(botState, `reconcile:closed=${justClosed.length},adopted=${adoptedPositions.length}`);
    }

    return botState;
  } catch (err) {
    console.error('[SYNC] reconcilePositions error:', err.message);
    return botState;
  }
}

export default async function handler(req, res) {
  let botState;

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
    if (botState.balance > botState.peakBalance) {
      botState.peakBalance = botState.balance;
    }

    // ── Step 4: Reconcile positions (replaces old syncOpenTrades) ─────────────
    // This is the CORE fix for "discovered" trades.
    // - Detects closures → logs P&L → removes from local state → saves immediately
    // - Detects untracked broker positions → adopts them → saves immediately
    // - Zero tolerance for unmanaged positions
    botState = await reconcilePositions(session, botState);

    // ── Sync actual trade stats from broker ─────────────────────────────────
    const brokerStats = await fetchBrokerTradeStats(session);
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
      
      console.log(`[CRON] Risk Sync: DailyLoss AED ${botState.dailyLoss.toFixed(2)}, TotalDrawdown ${botState.totalDrawdown}%`);
    }

    // ── Step 5 & 6: Fetch market data and Indicators ─────────────────────────
    const marketData = await getMarketData(session, botState);

    let indicators = null;
    if (marketData.candles5m && marketData.candles1h) {
      botState.candles5m = marketData.candles5m;
      // Only advance the processed candle time if we are not skipping due to duplicate
      if (!marketData.skip) {
        // Concurrency lock: Ensure only ONE invocation processes this specific candle entirely
        const locked = await acquireCandleLock(marketData.latestCandleTime);
        if (!locked) {
           console.warn(`[CRON] Concurrency block: Candle ${marketData.latestCandleTime} already locked`);
           marketData.skip = true;
           marketData.reason = `SKIP: Concurrency lock active for candle ${marketData.latestCandleTime} - preventing duplicate trades`;
        } else {
           botState.lastProcessedCandle = marketData.latestCandleTime;
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

    // ── Step 9: Place trade ───────────────────────────────────────────────────
    // placeTrade() now calls saveStateCritical() internally right after trade opens.
    // This means if the Vercel function times out AFTER the trade is placed but
    // BEFORE we reach Step 10, the trade is STILL saved to Redis.
    const tradeResult = await placeTrade(session, signal, botState);

    if (!tradeResult.success) {
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
      try { await saveState(botState); } catch (_) {}
    }
    await sendAlert(`🚨 Bot pipeline error: ${err.message}`).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
}
