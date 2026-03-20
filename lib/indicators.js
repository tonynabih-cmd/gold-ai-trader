export function calculateIndicators(candles5m, candles1h) {
  try {
    const closes = candles5m.map(c => c.close);
    const highs  = candles5m.map(c => c.high);
    const lows   = candles5m.map(c => c.low);

    function emaArray(data, period) {
      const k = 2 / (period + 1);
      let val = data[0];
      const result = [val];
      for (let i = 1; i < data.length; i++) {
        val = data[i] * k + val * (1 - k);
        result.push(val);
      }
      return result;
    }

    function calcATR(period) {
      const trs = [];
      for (let i = 1; i < candles5m.length; i++) {
        trs.push(Math.max(
          highs[i] - lows[i],
          Math.abs(highs[i] - closes[i - 1]),
          Math.abs(lows[i]  - closes[i - 1])
        ));
      }
      const recent = trs.slice(-period);
      return recent.reduce((a, b) => a + b, 0) / recent.length;
    }

    // FIX 2: proper RSI with Wilder smoothing + divide-by-zero guard
    function calcRSI(period) {
      const slice = closes.slice(-(period + 1));
      let gains = 0, losses = 0;
      for (let i = 1; i < slice.length; i++) {
        const diff = slice[i] - slice[i - 1];
        if (diff > 0) gains += diff;
        else losses += Math.abs(diff);
      }
      const avgGain = gains / period;
      const avgLoss = losses / period;
      if (avgLoss === 0) return 100;  // all gains, no losses
      if (avgGain === 0) return 0;    // all losses, no gains
      const rs = avgGain / avgLoss;
      return Math.min(100, Math.max(0, 100 - (100 / (1 + rs))));
    }

    const ema20arr = emaArray(closes, 20);
    const ema50arr = emaArray(closes, 50);

    const currEMA20 = ema20arr[ema20arr.length - 1];
    const currEMA50 = ema50arr[ema50arr.length - 1];
    const prevEMA20 = ema20arr[ema20arr.length - 2];
    const prevEMA50 = ema50arr[ema50arr.length - 2];

    const ema50_10ago  = ema50arr[ema50arr.length - 11];
    const slopePercent = (currEMA50 - ema50_10ago) / currEMA50 * 100;

    const currentATR = calcATR(14);

    const atrValues = [];
    for (let i = 0; i < 50; i++) {
      const slice = candles5m.slice(i, i + 15);
      if (slice.length < 15) continue;
      const trs = [];
      for (let j = 1; j < slice.length; j++) {
        trs.push(Math.max(
          slice[j].high - slice[j].low,
          Math.abs(slice[j].high - slice[j - 1].close),
          Math.abs(slice[j].low  - slice[j - 1].close)
        ));
      }
      atrValues.push(trs.reduce((a, b) => a + b, 0) / trs.length);
    }
    const atrAverage = atrValues.length
      ? atrValues.reduce((a, b) => a + b, 0) / atrValues.length
      : currentATR;

    const last50     = candles5m.slice(-50);
    const resistance = Math.max(...last50.map(c => c.high));
    const support    = Math.min(...last50.map(c => c.low));

    const closes1h = candles1h.map(c => c.close);
    const sma1h    = closes1h.reduce((a, b) => a + b, 0) / closes1h.length;
    const trend1h  = closes1h[closes1h.length - 1] > sma1h ? 'UP' : 'DOWN';

    const currentRSI = calcRSI(14);
    const lastCandle = candles5m[candles5m.length - 1];

    const indicatorData = {
      currEMA20, currEMA50,
      prevEMA20, prevEMA50,
      ema20arr, ema50arr,
      slopePercent,
      atr: currentATR, atrAverage,
      rsi: currentRSI,
      resistance, support,
      trend1h, lastCandle,
    };

    if (Math.abs(slopePercent) < 0.005) {
      return { skip: true, reason: 'SKIP: Weak trend - sideways market', ...indicatorData };
    }
    if (currentATR > atrAverage * 2.5) {
      return { skip: true, reason: 'SKIP: Abnormal volatility - news event', ...indicatorData };
    }
    if (currentATR < 0.5 || currentATR > 12) {
      return { skip: true, reason: 'SKIP: ATR out of normal range', ...indicatorData };
    }

    return { skip: false, ...indicatorData };

  } catch (err) {
    return { skip: true, reason: `SKIP: Indicator error - ${err.message}` };
  }
}
