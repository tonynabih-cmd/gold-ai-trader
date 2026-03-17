import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const TWELVE_DATA_KEY = process.env.TWELVE_DATA_API_KEY;

async function fetchCandles(timeframe, outputsize = 1) {
  const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${timeframe}&outputsize=${outputsize}&apikey=${TWELVE_DATA_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.values || data.values.length === 0) return null;
  return data.values.map(c => ({
    time: new Date(c.datetime).getTime(),
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
  })).reverse();
}

export async function getMarketData(botState) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const isFirstRunOfDay = botState.lastTradingDay !== today;

    // Fetch 1h candles for trend
    const candles1h = await fetchCandles('1h', 60);
    if (!candles1h) return { skip: true, reason: 'SKIP: Failed to fetch 1h candles' };

    // Fetch 5m candles
    let candles5m;
    if (isFirstRunOfDay || !botState.candles5m || botState.candles5m.length < 100) {
      candles5m = await fetchCandles('5min', 100);
      if (!candles5m) return { skip: true, reason: 'SKIP: Failed to fetch 5m candles' };
    } else {
      const latest = await fetchCandles('5min', 1);
      if (!latest) return { skip: true, reason: 'SKIP: Failed to fetch latest 5m candle' };
      candles5m = [...botState.candles5m, ...latest];
      if (candles5m.length > 100) candles5m = candles5m.slice(-100);
    }

    // Fetch 1m candles for confirmation
    const candles1m = await fetchCandles('1min', 5);
    if (!candles1m) return { skip: true, reason: 'SKIP: Failed to fetch 1m candles' };

    // Warmup check
    if (candles5m.length < 100) {
      return { skip: true, reason: `SKIP: Warming up - ${candles5m.length}/100 candles` };
    }

    // Duplicate candle guard
    const latestCandleTime = candles5m[candles5m.length - 1].time;
    if (latestCandleTime <= botState.lastProcessedCandle) {
      return { skip: true, reason: 'SKIP: Duplicate candle - already processed' };
    }

    return {
      skip: false,
      candles5m,
      candles1h,
      candles1m,
      latestCandleTime,
    };

  } catch (err) {
    return { skip: true, reason: `SKIP: Market data error - ${err.message}` };
  }
}
