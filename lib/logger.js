import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export async function saveLog(data) {
  try {
    const log = {
      // Identity
      tradeId: data.signal?.id || 'NO_SIGNAL',
      strategyVersion: data.signal?.strategyVersion || 'v1.1', // FIX 3: read from signal

      // Timing
      time: new Date().toISOString(),
      timeUAE: new Date().toLocaleString('en-US', { timeZone: 'Asia/Dubai' }),

      // Decision
      signalDetected: data.signal?.action || 'NONE',
      tradeExecuted: data.tradeExecuted || false,
      reason: data.reason || null,

      // Trade details
      entryPrice: data.signal?.entryPrice || null,
      stopLoss: data.signal?.stopLoss || null,
      takeProfit: data.signal?.takeProfit || null,
      size: data.result?.size || null,
      dealReference: data.result?.dealReference || null,

      // Indicators
      ema20: data.indicators?.currEMA20 || null,
      ema50: data.indicators?.currEMA50 || null,
      emaSlope: data.indicators?.slopePercent || null,
      atr: data.indicators?.atr || null,
      atrAverage: data.indicators?.atrAverage || null,
      rsi: data.indicators?.rsi || null,
      score: data.signal?.score || null,
      resistance: data.indicators?.resistance || null,
      support: data.indicators?.support || null,
      trend1h: data.indicators?.trend1h || null,

      // Risk state - FIX 1: use ?? instead of || so 0 is preserved
      balance: data.botState?.balance ?? null,
      dailyTrades: data.botState?.dailyTrades ?? null,
      dailyLoss: data.botState?.dailyLoss ?? null,
      openPositions: data.botState?.openTrades?.length ?? 0,
    };

    const logs = await redis.get('trade_logs') || [];
    logs.push(log);
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    await redis.set('trade_logs', logs);

    return log;

  } catch (err) {
    console.error('Logger error:', err.message);
  }
}

export async function getLogs() {
  try {
    return await redis.get('trade_logs') || [];
  } catch (err) {
    return [];
  }
}

export default async function handler(req, res) {
  const logs = await getLogs();
  return res.json(logs);
}
