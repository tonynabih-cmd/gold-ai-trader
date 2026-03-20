// logger.js — Save every bot decision to Upstash KV, including all skips.
// Every single cron invocation is logged — this is the source of truth for audit and analysis.

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export async function saveLog(data) {
  try {
    const log = {
      // ── Identity ────────────────────────────────────────────────────────────
      tradeId:         data.signal?.id              || 'NO_SIGNAL',
      strategyVersion: data.signal?.strategyVersion || 'v1.1',
      entryType:       data.signal?.entryType       || null, // 'crossover' or 'pullback'

      // ── Timing (always store UTC; UAE shown for human readability) ──────────
      time:    new Date().toISOString(),
      timeUAE: new Date().toLocaleString('en-US', { timeZone: 'Asia/Dubai' }),

      // ── Decision ────────────────────────────────────────────────────────────
      signalDetected: data.signal?.action   || 'NONE',
      tradeExecuted:  data.tradeExecuted    || false,
      reason:         data.reason           || null,

      // ── Trade details (null if not executed) ────────────────────────────────
      entryPrice:    data.signal?.entryPrice   ?? null,
      stopLoss:      data.signal?.stopLoss     ?? null,
      takeProfit:    data.signal?.takeProfit   ?? null,
      size:          data.result?.size         ?? null,
      dealReference: data.result?.dealReference ?? null,

      // ── Indicators (null if indicators were skipped) ─────────────────────────
      ema20:      data.indicators?.currEMA20    ?? null,
      ema50:      data.indicators?.currEMA50    ?? null,
      emaSlope:   data.indicators?.slopePercent ?? null,
      atr:        data.indicators?.atr          ?? null,
      atrAverage: data.indicators?.atrAverage   ?? null,
      rsi:        data.indicators?.rsi          ?? null,
      score:      data.signal?.score            ?? null,
      resistance: data.indicators?.resistance   ?? null,
      support:    data.indicators?.support      ?? null,
      trend1h:    data.indicators?.trend1h      ?? null,
      spread:     data.indicators?.spread       ?? null,

      // ── Risk state at time of decision ──────────────────────────────────────
      // Use ?? (not ||) so that 0 values are preserved correctly.
      // Example: dailyLoss of 0 must be logged as 0, not replaced by null.
      balance:       data.botState?.balance              ?? null,
      dailyTrades:   data.botState?.dailyTrades          ?? null,
      dailyLoss:     data.botState?.dailyLoss            ?? null,
      openPositions: data.botState?.openTrades?.length   ?? 0,
      totalDrawdown: data.botState?.totalDrawdown        ?? null,
    };

    // Read → append → write (atomic enough at this scale)
    const logs = await redis.get('trade_logs') || [];
    if (!Array.isArray(logs)) {
      console.error('trade_logs in Redis is not an array — resetting');
      await redis.set('trade_logs', [log]);
      return log;
    }

    logs.push(log);

    // Keep last 500 logs — splice from start to remove oldest entries
    if (logs.length > 500) logs.splice(0, logs.length - 500);

    await redis.set('trade_logs', logs);
    return log;

  } catch (err) {
    console.error('saveLog error:', err.message);
    // Non-fatal — never crash the bot over a logging failure
  }
}

export async function getLogs() {
  try {
    const logs = await redis.get('trade_logs');
    if (!Array.isArray(logs)) return [];
    return logs;
  } catch (err) {
    console.error('getLogs error:', err.message);
    return [];
  }
}
