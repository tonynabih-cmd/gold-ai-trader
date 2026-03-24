import { getCapitalSession }               from '../lib/session.js';
import { getMarketData }                   from '../lib/market_data.js';
import { calculateIndicators }             from '../lib/indicators.js';
import { generateSignal }                  from '../lib/strategy.js';
import { checkRisk }                       from '../lib/risk.js';
import { placeTrade, syncBalance, fetchClosedTradePnl } from '../lib/execution.js';
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
    if (!botState.openTrades || botState.openTrades.length === 0) return botState;

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

    for (const trade of botState.openTrades) {
      if (trade.dealReference && liveDealRefs.has(trade.dealReference)) {
        stillOpen.push(trade);
      } else {
        justClosed.push(trade);
      }
    }

    // Process closed trades
    for (const closedTrade of justClosed) {
      console.log(`syncOpenTrades: detected closure of trade ${closedTrade.tradeId} (ref: ${closedTrade.dealReference})`);
      
      // Fetch actual P&L if possible
      const realizedPnl = await fetchClosedTradePnl(session, closedTrade.dealReference);
      
      // Log the closure event
      await saveLog({
        signal: {
          id: closedTrade.tradeId,
          action: closedTrade.action === 'BUY' ? 'SELL' : 'BUY', // "Closing" action
          entryType: 'closure',
          entryPrice: null, // we'll use realized P&L instead
          strategyVersion: closedTrade.strategyVersion || 'v1.1'
        },
        indicators: null,
        botState,
        tradeExecuted: false, // technically the execution happened on the broker's side (SL/TP)
        reason: `CLOSED: Realized P&L: ${realizedPnl != null ? '$' + realizedPnl.toFixed(2) : 'Unknown (Not in last 24h history)'}`,
        result: {
          realizedPnl: realizedPnl
        }
      });

      if (realizedPnl != null) {
        await sendAlert(`📉 Trade CLOSED: ${closedTrade.action} Gold\nP&L: $${realizedPnl.toFixed(2)}`);
      } else {
        await sendAlert(`📉 Trade CLOSED: ${closedTrade.action} Gold (P&L lookup failed)`);
      }
    }

    botState.openTrades = stillOpen;
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

    // ── Step 4: Sync open trade positions ────────────────────────────────────
    // Removes trades that have been closed by SL/TP or manually on Capital.com.
    botState = await syncOpenTrades(session, botState);

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
