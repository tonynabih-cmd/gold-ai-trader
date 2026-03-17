import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const DEFAULT_STATE = {
  lastProcessedCandle: 0,
  previousProcessedCandle: 0,
  candles5m: [],
  openTrades: [],
  dailyLoss: 0,
  dailyTrades: 0,
  totalDrawdown: 0,
  peakBalance: 100.00,
  balance: 100.00,
  lastTradingDay: '',
  lastHeartbeat: Date.now(),
  botEnabled: true,
  recentTradeIds: [],
  lastOrderTimestamp: 0,
  strategyVersion: 'v1.0',
};

export async function loadState() {
  try {
    const saved = await redis.get('bot_state');
    if (!saved) return { ...DEFAULT_STATE };

    return {
      ...DEFAULT_STATE,
      ...saved,
      // Always parse numbers from Upstash strings
      dailyLoss: parseFloat(saved.dailyLoss || 0),
      balance: parseFloat(saved.balance || 100),
      dailyTrades: parseInt(saved.dailyTrades || 0),
      totalDrawdown: parseFloat(saved.totalDrawdown || 0),
      peakBalance: parseFloat(saved.peakBalance || 100),
      lastOrderTimestamp: parseInt(saved.lastOrderTimestamp || 0),
      lastProcessedCandle: parseInt(saved.lastProcessedCandle || 0),
      openTrades: saved.openTrades || [],
      recentTradeIds: saved.recentTradeIds || [],
      candles5m: saved.candles5m || [],
    };
  } catch (err) {
    console.error('Load state error:', err.message);
    return { ...DEFAULT_STATE };
  }
}

export async function saveState(botState) {
  try {
    await redis.set('bot_state', botState);
    return true;
  } catch (err) {
    console.error('Save state error:', err.message);
    return false;
  }
}

export function dailyReset(botState) {
  const today = new Date().toISOString().slice(0, 10);
  if (botState.lastTradingDay !== today) {
    botState.dailyLoss = 0;
    botState.dailyTrades = 0;
    botState.lastTradingDay = today;
  }
  return botState;
}
