// indicators.js — Calculate all technical indicators from candle data.
// Input: candles5m (100+ candles), candles1h (100+ candles)
// Output: indicator object with skip flag, or indicator data for strategy.js

const ALLOW_TRENDLESS_TRADES = process.env.ALLOW_TRENDLESS_TRADES === 'true';

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateCandleSeries(candles, label, minLength) {
  if (!Array.isArray(candles) || candles.length < minLength) {
    return { ok: false, reason: `SKIP: Not enough ${label} candles (${candles?.length ?? 0}/${minLength})` };
  }

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle || !isFiniteNumber(candle.time)) {
      return { ok: false, reason: `SKIP: ${label} candle ${i} missing valid timestamp` };
    }
    for (const key of ['open', 'high', 'low', 'close']) {
      if (!isFiniteNumber(candle[key])) {
        return { ok: false, reason: `SKIP: ${label} candle ${i} missing valid ${key}` };
      }
    }
  }

  return { ok: true, reason: null };
}

function emaArray(data, period) {
  if (!Array.isArray(data) || data.length < period) return [];
  if (data.some(value => !isFiniteNumber(value))) return [];

  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((sum, value) => sum + value, 0) / period;

  if (!isFiniteNumber(ema)) return [];

  const output = new Array(period - 1).fill(null);
  output.push(ema);

  for (let i = period; i < data.length; i++) {
    ema = (data[i] * k) + (ema * (1 - k));
    if (!isFiniteNumber(ema)) return [];
    output.push(ema);
  }

  return output;
}

function calcATR(candles, period) {
  if (!Array.isArray(candles) || candles.length < period + 1) return [];

  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    if (!isFiniteNumber(tr)) return [];
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) return [];

  const atrValues = [];
  let atr = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  if (!isFiniteNumber(atr)) return [];
  atrValues.push(atr);

  for (let i = period; i < trueRanges.length; i++) {
    atr = ((atr * (period - 1)) + trueRanges[i]) / period;
    if (!isFiniteNumber(atr)) return [];
    atrValues.push(atr);
  }

  return atrValues;
}

export function calculateIndicators(candles5m, candles1h) {
  try {
    const validation5m = validateCandleSeries(candles5m, '5m', 100);
    if (!validation5m.ok) return { skip: true, reason: validation5m.reason };

    const validation1h = validateCandleSeries(candles1h, '1h', 100);
    if (!validation1h.ok) return { skip: true, reason: validation1h.reason };

    const closes5m = candles5m.map(candle => candle.close);
    const closes1h = candles1h.map(candle => candle.close);

    const ema20arr = emaArray(closes5m, 20);
    const ema50arr = emaArray(closes5m, 50);
    if (ema20arr.length < 2 || ema50arr.length < 2) {
      return { skip: true, reason: 'SKIP: 5m EMA arrays too short or invalid' };
    }

    const currEMA20 = ema20arr[ema20arr.length - 1];
    const currEMA50 = ema50arr[ema50arr.length - 1];
    if (!isFiniteNumber(currEMA20) || !isFiniteNumber(currEMA50)) {
      return { skip: true, reason: 'SKIP: Invalid 5m EMA value detected' };
    }

    const atrArr = calcATR(candles5m, 14);
    if (atrArr.length < 50) {
      return { skip: true, reason: 'SKIP: ATR array too short or invalid' };
    }

    const currentATR = atrArr[atrArr.length - 1];
    const recentATRs = atrArr.slice(-50);
    const atrAverage = recentATRs.reduce((sum, value) => sum + value, 0) / recentATRs.length;
    if (!isFiniteNumber(currentATR) || !isFiniteNumber(atrAverage)) {
      return { skip: true, reason: 'SKIP: ATR missing or invalid' };
    }

    const ema20_1h_arr = emaArray(closes1h, 20);
    const ema50_1h_arr = emaArray(closes1h, 50);
    const ema20_1h = ema20_1h_arr.at(-1);
    const ema50_1h = ema50_1h_arr.at(-1);

    let trend1h = 'N/A';
    let trendReason = 'insufficient 1h EMA history';

    if (isFiniteNumber(ema20_1h) && isFiniteNumber(ema50_1h)) {
      if (ema20_1h > ema50_1h) {
        trend1h = 'UP';
        trendReason = 'EMA20 above EMA50';
      } else if (ema20_1h < ema50_1h) {
        trend1h = 'DOWN';
        trendReason = 'EMA20 below EMA50';
      } else {
        trendReason = 'EMA20 equals EMA50';
      }
    }

    console.log(`[IND] 1h candles fetched: ${candles1h.length}`);
    console.log(`[IND] EMA20: ${isFiniteNumber(ema20_1h) ? ema20_1h.toFixed(2) : 'N/A'}`);
    console.log(`[IND] EMA50: ${isFiniteNumber(ema50_1h) ? ema50_1h.toFixed(2) : 'N/A'}`);
    console.log(`[IND] Trend: ${trend1h}${trendReason ? ` (${trendReason})` : ''}`);

    if (trend1h === 'N/A' && !ALLOW_TRENDLESS_TRADES) {
      return {
        skip: true,
        reason: `SKIP: 1h trend undefined (${trendReason})`,
        ema20_1h,
        ema50_1h,
        trend1h,
        trendReason,
      };
    }

    const lastCandle = candles5m[candles5m.length - 1];
    const prevCandle = candles5m[candles5m.length - 2] || null;

    const indicatorData = {
      currEMA20,
      currEMA50,
      ema20arr,
      ema50arr,
      ema20_1h,
      ema50_1h,
      trend1h,
      trendReason,
      atr: currentATR,
      atrAverage,
      prevCandle,
      lastCandle,
    };

    console.log(`[IND] EMA/ATR CHECK: EMA20=${currEMA20.toFixed(2)}, EMA50=${currEMA50.toFixed(2)}, ATR=${currentATR.toFixed(2)}`);

    return { skip: false, ...indicatorData };
  } catch (err) {
    console.error('calculateIndicators error:', err.message);
    return { skip: true, reason: `SKIP: Indicator calculation error - ${err.message}` };
  }
}
