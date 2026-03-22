// cron.js — Main trading pipeline. Triggered every 5 minutes by cron-job.org.
// GitHub Actions fires every 10 minutes as a backup trigger.
// Duplicate candle guard in market_data.js prevents double-trading if both fire together.

import { getCapitalSession }               from '../lib/session.js';
import { getMarketData }                   from '../lib/market_data.js';
import { calculateIndicators }             from '../lib/indicators.js';
import { generateSignal }                  from '../lib/strategy.js';
import { checkRisk }                       from '../lib/risk.js';
import { placeTrade, syncBalance }         from '../lib/execution.js';
import { saveLog, getLogs }                from '../lib/logger.js';
import { loadState, saveState, dailyReset } from '../lib/state.js';
import { heartbeat, sendAlert, checkPerformance } from '../lib/monitor.js';

const FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Sync open trades against live Capital.com positions.
// Removes any trades from botState that have been closed (SL/TP hit or manual close).
// Uses dealReference — Capital.com includes this in both the order confirmation
// and the GET /positions response, allowing reliable cross-referencing.
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
      // Non-fatal — if positions fetch fails, keep existing state rather than wiping it
      console.warn(`syncOpenTrades: positions fetch failed (HTTP ${res.status}) — keeping existing state`);
      return botState;
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      console.warn(`syncOpenTrades: positions fetch returned invalid JSON (HTTP ${res.status})`);
      return botState;
    }
    const livePositions = data.positions || [];

    // Capital.com GET /positions returns position.dealReference (same string as order confirmation)
    const liveDealRefs = new Set(
      livePositions
        .map(p => p.position?.dealReference)
        .filter(Boolean) // remove undefined/null entries
    );

    const before = botState.openTrades.length;
    botState.openTrades = botState.openTrades.filter(t => {
      // Keep trade if it has a dealReference AND Capital.com still shows it open
      if (!t.dealReference) {
        console.warn(`Trade ${t.tradeId} has no dealReference — removing from state`);
        return false;
      }
      return liveDealRefs.has(t.dealReference);
    });

    const closed = before - botState.openTrades.length;
    if (closed > 0) {
      console.log(`syncOpenTrades: removed ${closed} closed position(s). Open: ${botState.openTrades.length}`);
    }

    return botState;
  } catch (err) {
    console.error('syncOpenTrades error:', err.message);
    return botState; // Non-fatal — always return current state
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

  try {
    // ── Step 1: Load state + daily reset ─────────────────────────────────────
    botState = await loadState();
    botState = dailyReset(botState);

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
        botState.lastProcessedCandle = marketData.latestCandleTime;
      }

      // Calculate indicators even on skips (e.g. duplicate candles or weekends)
      // so the dashboard always has the latest live values for UI display.
      indicators = calculateIndicators(marketData.candles5m, marketData.candles1h);
      indicators.spread = marketData.spread ?? null;
    }

    // If market data skipped OR indicators skipped:
    if (marketData.skip || (indicators && indicators.skip)) {
      const reason = marketData.skip ? marketData.reason : indicators.reason;
      await heartbeat(botState);
      // Pass the fully populated indicators object to saveLog so the dashboard never goes blank
      await saveLog({ signal: null, indicators, botState, tradeExecuted: false, reason });
      await saveState(botState);
      return res.json({ skipped: reason });
    }

    // ── Step 7: Generate signal ───────────────────────────────────────────────
    const signal = generateSignal(indicators, marketData.candles1m);

    // ── Step 8: Risk checks ───────────────────────────────────────────────────
    const riskResult = checkRisk(signal, botState, indicators);

    if (riskResult !== 'APPROVED') {
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: riskResult });
      await saveState(botState);
      await heartbeat(botState);
      return res.json({ skipped: riskResult });
    }

    // ── Step 9: Place trade ───────────────────────────────────────────────────
    const tradeResult = await placeTrade(session, signal, botState);

    if (!tradeResult.success) {
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: tradeResult.reason });
      await saveState(botState);
      await heartbeat(botState);
      return res.json({ skipped: tradeResult.reason });
    }

    // ── Step 10: Log success ──────────────────────────────────────────────────
    await saveLog({ signal, indicators, botState, tradeExecuted: true, result: tradeResult, reason: null });
    await saveState(botState);
    await heartbeat(botState);

    // ── Step 11: Performance check (fires every 50 executed trades) ───────────
    const logs = await getLogs();
    await checkPerformance(logs, botState);

    // ── Step 12: Trade alert ──────────────────────────────────────────────────
    await sendAlert(
      `✅ ${signal.action} GOLD [${signal.entryType}]\n` +
      `Entry: $${signal.entryPrice.toFixed(2)}\n` +
      `SL: $${signal.stopLoss.toFixed(2)} | TP: $${signal.takeProfit.toFixed(2)}\n` +
      `Size: ${tradeResult.size}oz | Score: ${signal.score} | ATR: ${signal.atr.toFixed(2)}\n` +
      `Balance: $${parseFloat(botState.balance).toFixed(2)} | Daily trades: ${botState.dailyTrades}/5`
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
