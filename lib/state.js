import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export async function acquireCandleLock(candleTime) {
  try {
    // Attempt to set a lock key strictly if it does not already exist. 
    // Expires automatically in slightly less than 5 minutes (240s) to prevent overlap edge-cases on lag.
    const key = `lock:candle:${candleTime}`;
    const result = await redis.set(key, `locked:${Date.now()}`, { nx: true, ex: 240 });
    return result === 'OK'; // Upstash returns 'OK' if the lock was acquired
  } catch (err) {
    console.error('Redis lock error:', err.message);
    return false; // Fail-closed: assume locked if we can't verify
  }
}

// candles5m is intentionally NOT in DEFAULT_STATE — it is never saved to KV.
// Vercel is stateless; candles are fetched fresh from Capital.com each invocation.
const DEFAULT_STATE = {
  lastProcessedCandle:     0,
  previousProcessedCandle: 0,
  openTrades:              [],
  dailyLoss:               0,
  dailyTrades:             0,
  totalDrawdown:           0,
  peakBalance:             0,      // 0 = not yet synced; syncBalance() sets real value
  balance:                 0,      // 0 = not yet synced; prevents trading before first sync
  availableMargin:         0,      // Capital.com free margin — updated by syncBalance()
  startOfDayBalance:       0,
  lastTradingDay:          '',
  lastHeartbeat:           0,
  botEnabled:              true,
  recentTradeIds:          [],
  lastOrderTimestamp:      0,
  brokerGrossProfit:       0,
  brokerGrossLoss:         0,
  peakBrokerPnl:           0,
  strategyVersion:         'v1.1',
};

export async function loadState() {
  try {
    const saved = await redis.get('bot_state');
    if (!saved) return { ...DEFAULT_STATE };

    return {
      ...DEFAULT_STATE,
      ...saved,

      // Use ?? (nullish coalescing) so saved value of 0 is respected, not treated as falsy.
      // Using || would incorrectly return the default when the saved value is legitimately 0.
      dailyLoss:           parseFloat(saved.dailyLoss          ?? 0),
      balance:             parseFloat(saved.balance            ?? 0),
      availableMargin:     parseFloat(saved.availableMargin    ?? 0),
      dailyTrades:         parseInt(saved.dailyTrades          ?? 0),
      totalDrawdown:       parseFloat(saved.totalDrawdown      ?? 0),
      peakBalance:         parseFloat(saved.peakBalance        ?? 0),
      startOfDayBalance:   parseFloat(saved.startOfDayBalance  ?? 0),
      lastOrderTimestamp:  parseInt(saved.lastOrderTimestamp   ?? 0),
      brokerGrossProfit:   parseFloat(saved.brokerGrossProfit   ?? 0),
      brokerGrossLoss:     parseFloat(saved.brokerGrossLoss     ?? 0),
      lastProcessedCandle: Number(saved.lastProcessedCandle  || 0),

      openTrades:          Array.isArray(saved.openTrades)     ? saved.openTrades     : [],
      recentTradeIds:      Array.isArray(saved.recentTradeIds) ? saved.recentTradeIds : [],

      // candles5m is NEVER loaded from KV — always start empty, fetch fresh each invocation
      candles5m:           [],

      // botEnabled: explicitly check for false so missing key defaults to true
      botEnabled:          saved.botEnabled !== false,
    };
  } catch (err) {
    console.error('Load state error:', err.message);
    return { ...DEFAULT_STATE };
  }
}

export async function saveState(botState) {
  try {
    // CRITICAL: Strip candles5m before saving.
    // 100 candles of OHLC data is a large payload — storing it in Upstash KV
    // wastes space, slows reads/writes, and risks hitting size limits.
    // Candles are fetched fresh from Capital.com each invocation anyway.
    const { candles5m, ...stateToSave } = botState;

    await redis.set('bot_state', stateToSave);
    return true;
  } catch (err) {
    console.error('Save state error:', err.message);
    return false;
  }
}

export function dailyReset(botState) {
  // Use UAE time (UTC+4) for reset logic. UAE time is the bot's standard
  // for Golden Hour and weekend gap rules. UTC-only reset causes a delay
  // for users in UAE (at 01:00 UAE, it's still 21:00 previous day UTC).
  const uaeDate = new Date(new Date().getTime() + (4 * 60 * 60 * 1000));
  const today = uaeDate.toISOString().slice(0, 10);
  
  if (botState.lastTradingDay !== today) {
    botState.dailyLoss      = 0;
    botState.dailyTrades    = 0;
    botState.lastTradingDay = today;
    botState.startOfDayBalance = parseFloat(botState.balance) || 0;
    console.log(`Daily reset applied for ${today} (UAE Time)`);
  }
  return botState;
}

export async function saveAudit(data) {
  try {
    await redis.set('last_audit', data);
    return true;
  } catch (err) {
    console.error('Save audit error:', err.message);
    return false;
  }
}

// API route handler (api/state.js imports from here)
export default async function handler(req, res) {
  const state = await loadState();
  return res.json(state);
}
