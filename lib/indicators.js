// indicators.js — Calculate all technical indicators from candle data.
// Input: candles5m (100 candles), candles1h (60 candles)
// Output: indicator object with skip flag, or indicator data for strategy.js

export function calculateIndicators(candles5m, candles1h) {
  try {
    // ── Input validation ──────────────────────────────────────────────────────
    if (!candles5m || candles5m.length < 100) {
      return { skip: true, reason: `SKIP: Not enough 5m candles (${candles5m?.length ?? 0}/100)` };
    }

    const closes = candles5m.map(c => c.close);
    const highs  = candles5m.map(c => c.high);
    const lows   = candles5m.map(c => c.low);

    // ── EMA calculation ───────────────────────────────────────────────────────
    function emaArray(data, period) {
      if (data.length < period) return [];
      const k   = 2 / (period + 1);
      let val   = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
      const out = new Array(period - 1).fill(null);
      out.push(val);
      for (let i = period; i < data.length; i++) {
        val = data[i] * k + val * (1 - k);
        out.push(val);
      }
      return out;
    }

    // ── ATR calculation (Wilder's smoothing) ──────────────────────────────────
    function calcATR(period) {
      const trs = [];
      for (let i = 1; i < candles5m.length; i++) {
        trs.push(Math.max(
          highs[i]  - lows[i],
          Math.abs(highs[i]  - closes[i - 1]),
          Math.abs(lows[i]   - closes[i - 1])
        ));
      }
      if (trs.length < period) return [];
      
      const atrArr = [];
      let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
      atrArr.push(atr);
      for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]) / period;
        atrArr.push(atr);
      }
      return atrArr;
    }

    // ── Compute EMA arrays ────────────────────────────────────────────────────
    const ema20arr = emaArray(closes, 20);
    const ema50arr = emaArray(closes, 50);

    if (ema20arr.length < 2 || ema50arr.length < 2) {
      return { skip: true, reason: 'SKIP: EMA arrays too short - not enough candle data' };
    }

    const currEMA20 = ema20arr[ema20arr.length - 1];
    const currEMA50 = ema50arr[ema50arr.length - 1];

    // ── ATR & Volatility Baseline ─────────────────────────────────────────────
    const atrArr = calcATR(14);
    if (atrArr.length < 50) {
      return { skip: true, reason: 'SKIP: ATR array too short' };
    }
    const currentATR = atrArr[atrArr.length - 1];
    const recentATRs = atrArr.slice(-50);
    const atrAverage = recentATRs.reduce((a, b) => a + b, 0) / recentATRs.length;

    const lastCandle = candles5m[candles5m.length - 1];
    const prevCandle = candles5m[candles5m.length - 2] || null;

    const closes1h = candles1h.map(c => c.close);
    const ema20_1h = emaArray(closes1h, 20).slice(-1)[0];
    const ema50_1h = emaArray(closes1h, 50).slice(-1)[0];

    // ── Pack all indicator data ───────────────────────────────────────────────
    const indicatorData = {
      currEMA20,
      currEMA50,
      ema20arr,
      ema50arr,
      ema20_1h,
      ema50_1h,
      atr: currentATR,
      atrAverage,
      prevCandle,
      lastCandle,
    };

    if (typeof currentATR !== 'number' || isNaN(currentATR)) {
      return { skip: true, reason: 'SKIP: ATR missing or invalid (null/undefined)', ...indicatorData };
    }

    console.log(`EMA/ATR CHECK: EMA20=${currEMA20.toFixed(2)}, EMA50=${currEMA50.toFixed(2)}, ATR=${currentATR.toFixed(2)}`);

    return { skip: false, ...indicatorData };

  } catch (err) {
    console.error('calculateIndicators error:', err.message);
    return { skip: true, reason: `SKIP: Indicator calculation error - ${err.message}` };
  }
}
