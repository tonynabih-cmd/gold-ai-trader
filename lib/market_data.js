// Session is created once in cron.js and passed in — no auth calls here

async function fetchCandles(session, resolution, count) {
  const { baseUrl, cst, securityToken } = session;
  const res = await fetch(
    `${baseUrl}/api/v1/prices/GOLD?resolution=${resolution}&max=${count}`,
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

export async function getMarketData(session, botState) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const isFirstRunOfDay = botState.lastTradingDay !== today;

    const candles1h = await fetchCandles(session, 'HOUR', 60);
    if (!candles1h) return { skip: true, reason: 'SKIP: Failed to fetch 1h candles' };

    let candles5m;
    if (isFirstRunOfDay || !botState.candles5m || botState.candles5m.length < 100) {
      candles5m = await fetchCandles(session, 'MINUTE_5', 110);
      if (!candles5m) return { skip: true, reason: 'SKIP: Failed to fetch 5m candles' };
    } else {
      const latest = await fetchCandles(session, 'MINUTE_5', 3);
      if (!latest) return { skip: true, reason: 'SKIP: Failed to fetch latest 5m candle' };
      candles5m = [...botState.candles5m, ...latest];
    }

    const candles1m = await fetchCandles(session, 'MINUTE', 5);
    if (!candles1m) return { skip: true, reason: 'SKIP: Failed to fetch 1m candles' };

    const seen = new Set();
    candles5m = candles5m.filter(c => {
      if (seen.has(c.time)) return false;
      seen.add(c.time);
      return true;
    });

    if (candles5m.length > 100) candles5m = candles5m.slice(-100);

    if (candles5m.length < 100) {
      return { skip: true, reason: `SKIP: Warming up - ${candles5m.length}/100 candles` };
    }

    const latestCandleTime = candles5m[candles5m.length - 1].time;
    if (latestCandleTime <= botState.lastProcessedCandle) {
      return { skip: true, reason: 'SKIP: Duplicate candle - already processed' };
    }

    return { skip: false, candles5m, candles1h, candles1m, latestCandleTime };

  } catch (err) {
    return { skip: true, reason: `SKIP: Market data error - ${err.message}` };
  }
}
