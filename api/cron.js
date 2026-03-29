import { getCapitalSession }               from '../lib/session.js';
import { getMarketData }                   from '../lib/market_data.js';
import { calculateIndicators }             from '../lib/indicators.js';
import { generateSignal }                  from '../lib/strategy.js';
import { checkRisk }                       from '../lib/risk.js';
import { placeTrade, syncBalance, fetchClosedTradePnl, fetchBrokerTradeStats } from '../lib/execution.js';
import { saveLog, getLogs }                from '../lib/logger.js';
import { loadState, saveState, dailyReset, acquireCandleLock } from '../lib/state.js';
import { sendAlert, checkPerformance }     from '../lib/monitor.js';
import { fetchWithTimeout }                from '../lib/fetch.js';


/**
 * Syncs the bot's internal openTrades list with the actual positions on Capital.com.
 * If a trade is found locally but is missing on the broker, it's considered CLOSED.
 * We then fetch the actual realized P&L and log it.
 */
async function syncOpenTrades(session, botState) {
  try {
    const { baseUrl, cst, securityToken } = session;
    const res = await fetchWithTimeout(`${baseUrl}/api/v1/positions`, {
      headers: {
        'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
        'CST':              cst,
        'X-SECURITY-TOKEN': securityToken,
      },
    });

    if (!res.ok) {
      console.warn(`syncOpenTrades: positions fetch failed (HTTP ${res.status}) — keeping existing state`);
      return botState;
    }

    let data;
    try { data = await res.json(); } catch (e) { return botState; }
    const livePositions = data.positions || [];
    const liveDealRefs  = new Set(livePositions.map(p => p.position?.dealReference).filter(Boolean));

    const stillOpen = [];
    const justClosed = [];

    // Track what we managed to sync from existing botState
    for (const trade of (botState.openTrades || [])) {
      if (trade.dealReference && liveDealRefs.has(trade.dealReference)) {
        stillOpen.push(trade);
      } else {
        justClosed.push(trade);
      }
    }

    // Process closed trades
    for (const closedTrade of justClosed) {
      console.log(`syncOpenTrades: detected closure of trade ${closedTrade.tradeId} (ref: ${closedTrade.dealReference})`);
      let realizedPnl = await fetchClosedTradePnl(session, closedTrade.dealReference, closedTrade.openedAt);
      
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
        reason: `CLOSED: Realized P&L: ${realizedPnl != null ? '$' + realizedPnl.toFixed(2) : 'Unknown'}`,
        result: { realizedPnl }
      });

      if (realizedPnl != null) {
        await sendAlert(`📉 Trade CLOSED: ${closedTrade.action} Gold\nP&L: $${realizedPnl.toFixed(2)}`);
      }
    }

    // DISCOVERY: Find trades on broker that are missing locally
    const finalOpen = [...stillOpen];
    for (const pos of livePositions) {
      const liveRef = pos.position?.dealReference;
      if (!liveRef) continue;
      
      const existsLocally = stillOpen.some(t => t.dealReference === liveRef);
      if (!existsLocally) {
        console.log(`syncOpenTrades: discovered trade on broker: ref ${liveRef}`);
        finalOpen.push({
          tradeId:         `discovered_${liveRef}`,
          dealReference:   liveRef,
          pair:            'GOLD',
          action:          pos.position?.direction,
          entry:           parseFloat(pos.position?.level),
          size:            parseFloat(pos.position?.size),
          stopLoss:        parseFloat(pos.position?.stopLevel || 0),
          takeProfit:      parseFloat(pos.position?.limitLevel || 0),
          openedAt:        new Date(pos.position?.createdDate).getTime(),
          strategyVersion: 'v1.1 (discovered)',
        });
      }
    }

    botState.openTrades = finalOpen;
    return botState;
  } catch (err) {
    console.error('syncOpenTrades error:', err.message);
    return botState;
  }
}

export default async function handler(req, res) {
  let botState;

  // ── Authorization ─────────────────────────────────────────────────────────
  // Prevents unauthorized parties from triggering the bot if the URL is discovered.
  // cron-job.org: set custom header Authorization: Bearer <your_secret>
  // GitHub Actions: stored in repository secrets as CRON_SECRET
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  const providedAuth = req.headers['authorization'] || req.headers['Authorization'];
  if (process.env.CRON_SECRET && providedAuth !== expectedAuth) {
    console.warn('Unauthorized cron trigger attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── Kill switch (fast path) ──────────────────────────────────────────────
  // Checked here so we never waste API calls when bot is disabled.
  if (process.env.BOT_ENABLED !== 'true') {
    return res.json({ skipped: 'Bot disabled via BOT_ENABLED env variable' });
  }

  try {
    // ── Step 1: Load state + daily reset ─────────────────────────────────────
    botState = await loadState();
    botState = dailyReset(botState);

    // ── State kill switch (fast path) ────────────────────────────────────────
    // Checked here so we never waste Capital.com API calls when bot is disabled
    // by drawdown or performance threshold (set by risk.js Rule 14 / monitor.js).
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

    // ── Step 3: Sync real balance from Capital.com ───────────────────────────
    // Must happen before risk checks so balance-based limits use real values.
    botState = await syncBalance(session, botState);
    if (botState.balance > botState.peakBalance) {
      botState.peakBalance = botState.balance;
    }

    // ── Step 4: Sync open trade positions ────────────────────────────────────
    // Removes trades that have been closed by SL/TP or manually on Capital.com.
    botState = await syncOpenTrades(session, botState);

    // ── Sync actual trade stats from broker ─────────────────────────────────
    // Single source of truth for win rate, best/worst trade, total P&L.
    // Fetches directly from Capital.com transaction history (30-day window).
    const brokerStats = await fetchBrokerTradeStats(session);
    if (brokerStats) {
      console.log(`Broker Sync: Today ${brokerStats.todayTrades}, Win rate ${brokerStats.todayWinRate}%`);
      botState.dailyTrades        = brokerStats.todayTrades;
      botState.todayTrades        = brokerStats.todayTrades; // Unify for stats.js
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

      // ── Broker-Based Risk Metrics (Manual Deposit/Withdrawal Proof) ────────────────
      // Daily loss based on today's realized broker PnL (already in account currency: AED)
      const todayPnlAED = brokerStats.todayNetPnl;
      botState.dailyLoss = todayPnlAED < 0 ? Math.abs(todayPnlAED) : 0;

      // Drawdown based on peak total PnL relative to current total PnL (AED vs AED)
      const currentTotalPnl = brokerStats.totalPnl;
      const peakPnl = parseFloat(botState.peakBrokerPnl) || 0;
      if (currentTotalPnl > peakPnl) botState.peakBrokerPnl = currentTotalPnl;
      
      const pnlDrawdownAED = (peakPnl > currentTotalPnl) ? (peakPnl - currentTotalPnl) : 0;
      const currentBalanceAED = parseFloat(botState.balance) || 1;
      botState.totalDrawdown = parseFloat(((pnlDrawdownAED / currentBalanceAED) * 100).toFixed(2));
      
      console.log(`Risk Sync: DailyLoss AED ${botState.dailyLoss.toFixed(2)}, TotalDrawdown ${botState.totalDrawdown}%`);
    }

    // ── Step 5 & 6: Fetch market data and Indicators ─────────────────────────
    const marketData = await getMarketData(session, botState);

    let indicators = null;
    if (marketData.candles5m && marketData.candles1h) {
      botState.candles5m = marketData.candles5m;
      // Only advance the processed candle time if we are not skipping due to duplicate
      if (!marketData.skip) {
        // Concurrency lock: Ensure only ONE invocations processes this specific candle entirely
        const locked = await acquireCandleLock(marketData.latestCandleTime);
        if (!locked) {
           console.warn(`Concurrency block: Candle ${marketData.latestCandleTime} is already locked by another instance.`);
           marketData.skip = true;
           marketData.reason = `SKIP: Concurrency lock active for candle ${marketData.latestCandleTime} - preventing duplicate trades`;
        } else {
           botState.lastProcessedCandle = marketData.latestCandleTime;
        }
      }

      // Calculate indicators even on skips (e.g. duplicate candles or weekends)
      // so the dashboard always has the latest live values for UI display.
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
      // Pass the fully populated indicators & debug object to saveLog so dashboard never goes blank
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
      `Balance: $${parseFloat(botState.balance).toFixed(2)} | Daily trades: ${botState.dailyTrades}/10`
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
    console.error('Cron pipeline error:', err.message, err.stack);
    if (botState) {
      try { await saveState(botState); } catch (_) {}
    }
    await sendAlert(`🚨 Bot pipeline error: ${err.message}`).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
}
