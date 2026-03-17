export function calculateIndicators(candles5m, candles1h) {
  try {
    const closes = candles5m.map(c => c.close);
    const highs = candles5m.map(c => c.high);
    const lows = candles5m.map(c => c.low);

    function ema(data, period) {
      const k = 2 / (period + 1);
      let emaVal = data[0];
      const result = [emaVal];
      for (let i = 1; i < data.length; i++) {
        emaVal = data[i] * k + emaVal * (1 - k);
        result.push(emaVal);
      }
      return result;
    }

    function atr(period) {
      const trs = [];
      for (let i = 1; i < candles5m.length; i++) {
        const tr = Math.max(
          highs[i] - lows[i],
          Math.abs(highs[i] - closes[i - 1]),
          Math.abs(lows[i] - closes[i - 1])
        );
        trs.push(tr);
      }
      const recent = trs.slice(-period);
      return recent.reduce((a, b) => a + b, 0) / recent.length;
    }

    function rsi(period) {
      let gains = 0, losses = 0;
      for (let i = closes.length - period; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) gains += diff;
        else losses += Math.abs(diff);
      }
      const rs = gains / losses;
      return 100 - (100 / (1 + rs));
    }

    const ema20arr = ema(closes, 20);
    const ema50arr = ema(closes, 50);
    const currEMA20 = ema20arr[ema20arr.length - 1];
    const currEMA50 = ema50arr[ema50arr.length - 1];
    const prevEMA20 = ema20arr[ema20arr.length - 2];
    const prevEMA50 = ema50arr[ema50arr.length - 2];
    const ema50_10ago = ema50arr[ema50arr.length - 11];
    const slopePercent = (currEMA50 - ema50_10ago) / currEMA50 * 100;

    const currentATR = atr(14);
    const atrValues = [];
    for (let i = 0; i < 50; i++) {
      const slice = candles5m.slice(i, i + 14);
      if (slice.length === 14) {
        const trs = [];
        for (let j = 1; j < slice.length; j++) {
          trs.push(Math.max(
            slice[j].high - slice[j].low,
            Math.abs(slice[j].high - slice[j - 1].close),
            Math.abs(slice[j].low - slice[j - 1].close)
          ));
        }
        atrValues.push(trs.reduce((a, b) => a + b, 0) / trs.length);
      }
    }
    const atrAverage = atrValues.reduce((a, b) => a + b, 0) / atrValues.length;

    const last50 = candles5m.slice(-50);
    const resistance = Math.max(...last50.map(c => c.high));
    const support = Math.min(...last50.map(c => c.low));

    const closes1h = candles1h.map(c => c.close);
    const ema50_1h = closes1h.reduce((a, b) => a + b, 0) / closes1h.length;
    const trend1h = closes1h[closes1h.length - 1] > ema50_1h ? 'UP' : 'DOWN';
    const currentRSI = rsi(14);
    const lastCandle = candles5m[candles5m.length - 1];

    // ✅ Build full indicator object first
    const indicatorData = {
      currEMA20, currEMA50, prevEMA20, prevEMA50,
      slopePercent, atr: currentATR, atrAverage,
      rsi: currentRSI, resistance, support,
      trend1h, lastCandle,
    };

    // ✅ Now check skips — but include indicator values so dashboard shows them
    if (Math.abs(slopePercent) < 0.02) {
      return { skip: true, reason: 'SKIP: Weak trend - sideways market', ...indicatorData };
    }
    if (currentATR > atrAverage * 2) {
      return { skip: true, reason: 'SKIP: Abnormal volatility - news event', ...indicatorData };
    }
    if (currentATR < 1 || currentATR > 8) {
      return { skip: true, reason: 'SKIP: ATR out of normal range', ...indicatorData };
    }

    return { skip: false, ...indicatorData };

  } catch (err) {
    return { skip: true, reason: `SKIP: Indicator error - ${err.message}` };
  }
}
