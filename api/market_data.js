// All candle data now fetched from Capital.com directly
// This ensures price data matches exactly what orders are placed against

async function getCapitalSession() {
  const baseUrl = process.env.CAPITAL_ENV === 'demo'
    ? 'https://demo-api-capital.backend-capital.com'
    : 'https://api-capital.backend-capital.com';

  const res = await fetch(`${baseUrl}/api/v1/session`, {
    method: 'POST',
    headers: {
      'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      identifier: process.env.CAPITAL_EMAIL,
      password: process.env.CAPITAL_PASSWORD,
    }),
  });

  if (!res.ok) throw new Error(`Capital.com auth failed: ${await res.text()}`);
  const cst = res.headers.get('CST');
  const securityToken = res.headers.get('X-SECURITY-TOKEN');
  if (!cst || !securityToken) throw new Error('Capital.com session tokens missing');

  const baseUrlFinal = process.env.CAPITAL_ENV === 'demo'
    ? 'https://demo-api-capital.backend-capital.com'
    : 'https://api-capital.backend-capital.com';

  return { baseUrl: baseUrlFinal, cst, securityToken };
}

// Capital.com resolution strings: MINUTE, MINUTE_5, HOUR
async function fetchCandles(session, resolution, count) {
  const { baseUrl, cst, securityToken } = session;
  const res = await fetch(
    `${baseUrl}/api/v1/prices/XAUUSD?resolution=${resolution}&max=${count}`,
    {
      headers: {
        'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
        'CST': cst,
        'X-SECURITY-TOKEN': securityToken,
      },
    }
  );

  if (!res.ok) throw new Error(`Failed to fetch ${resolution} candles: ${await res.text()}`);
  const data = await res.json();

  if (!data.prices || data.prices.length === 0) return null;

  return data.prices.map(p => ({
    time: new Date(p.snapshotTime).getTime(),
    open:  (p.openPrice.bid  + p.openPrice.ask)  / 2,
    high:  (p.highPrice.bid  + p.highPrice.ask)  / 2,
    low:   (p.lowPrice.bid   + p.lowPrice.ask)   / 2,
    close: (p.closePrice.bid + p.closePrice.ask) / 2,
  }));
}

export async function getMarketData(botState) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const isFirstRunOfDay = botState.lastTradingDay !== today;

    // Single session for all fetches
    const session = await getCapitalSession();

    // 1h candles for trend detection (60 candles)
    const candles1h = await fetchCandles(session, 'HOUR', 60);
    if (!candles1h) return { skip: true, reason: 'SKIP: Failed to fetch 1h candles' };

    // 5m candles — full fetch on first run of day, otherwise append latest
    let candles5m;
    if (isFirstRunOfDay || !botState.candles5m || botState.candles5m.length < 100) {
      candles5m = await fetchCandles(session, 'MINUTE_5', 110);
      if (!candles5m) return { skip: true, reason: 'SKIP: Failed to fetch 5m candles' };
    } else {
      const latest = await fetchCandles(session, 'MINUTE_5', 3); // fetch last 3 to avoid gaps
      if (!latest) return { skip: true, reason: 'SKIP: Failed to fetch latest 5m candle' };
      candles5m = [...botState.candles5m, ...latest];
    }

    // 1m candles for momentum confirmation (last 5)
    const candles1m = await fetchCandles(session, 'MINUTE', 5);
    if (!candles1m) return { skip: true, reason: 'SKIP: Failed to fetch 1m candles' };

    // Deduplicate by timestamp
    const seen = new Set();
    candles5m = candles5m.filter(c => {
      if (seen.has(c.time)) return false;
      seen.add(c.time);
      return true;
    });

    // Keep last 100
    if (candles5m.length > 100) candles5m = candles5m.slice(-100);

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
