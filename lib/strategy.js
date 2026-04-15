// strategy.js — strict 2-layer logic
export function generateSignal(indicators, _) {
  try {
    const {
      currEMA20, currEMA50,
      ema20arr, ema50arr,
      atr, atrAverage,
      prevCandle, lastCandle,
    } = indicators;

    if (
      typeof currEMA20 !== 'number' || isNaN(currEMA20) ||
      typeof currEMA50 !== 'number' || isNaN(currEMA50) ||
      typeof atr       !== 'number' || isNaN(atr)       ||
      !Array.isArray(ema20arr) || ema20arr.length < 3 ||
      !Array.isArray(ema50arr) || ema50arr.length < 3 ||
      !prevCandle || typeof prevCandle.low !== 'number' || typeof prevCandle.high !== 'number' ||
      !lastCandle || typeof lastCandle.close !== 'number'
    ) return { signal: null, debug: { dbgRejectReason: 'invalid or missing indicator values' } };

    const TAKE_PROFIT_ATR_MULTIPLIER = 2.5;
    const STOP_LOSS_ATR_MULTIPLIER = 1.5;
    const EMA20_TOUCH_ZONE_MULTIPLIER = 0.20;

    // ── Layer 1: Regime Filter ────────────────────────────────────────────────
    let action = null;
    if (currEMA20 > currEMA50) {
      action = 'BUY';
    } else if (currEMA20 < currEMA50) {
      action = 'SELL';
    } else {
      return { signal: null, debug: { dbgRejectReason: 'EMA20 and EMA50 are flat' } };
    }

    const emaDist0 = Math.abs(ema20arr[ema20arr.length - 1] - ema50arr[ema50arr.length - 1]);
    const emaDist1 = Math.abs(ema20arr[ema20arr.length - 2] - ema50arr[ema50arr.length - 2]);
    const emaDist2 = Math.abs(ema20arr[ema20arr.length - 3] - ema50arr[ema50arr.length - 3]);
    
    const isExpanding = emaDist0 > emaDist1 && emaDist1 > emaDist2;
    if (!isExpanding) {
      return { signal: null, debug: { dbgRejectReason: 'Regime: EMA distance is not expanding' } };
    }

    if (typeof atrAverage !== 'number' || atr <= atrAverage) {
      return { signal: null, debug: { dbgRejectReason: 'Regime: ATR is below recent average (dead market)' } };
    }

    // ── Layer 2: Entry Filter ─────────────────────────────────────────────────
    const touchZone = atr * EMA20_TOUCH_ZONE_MULTIPLIER;
    const previousCandleTouchedZone =
      prevCandle.low <= currEMA20 + touchZone &&
      prevCandle.high >= currEMA20 - touchZone;

    if (!previousCandleTouchedZone) {
      return { signal: null, debug: { dbgRejectReason: `Entry: no EMA20 touch/sweep on prior candle (zone ${touchZone.toFixed(2)})` } };
    }

    const candleSize = lastCandle.high - lastCandle.low;
    if (candleSize === 0) return { signal: null, debug: { dbgRejectReason: 'Entry: Candle size is 0' } };

    const bodySize = Math.abs(lastCandle.close - lastCandle.open);
    const isStrongBody = bodySize >= candleSize * 0.4;

    const confirmationValid = action === 'BUY'
      ? lastCandle.close > currEMA20 && isStrongBody && ((lastCandle.close - lastCandle.low) / candleSize >= 0.6)
      : lastCandle.close < currEMA20 && isStrongBody && ((lastCandle.high - lastCandle.close) / candleSize >= 0.6);

    if (!confirmationValid) {
      return { signal: null, debug: { dbgRejectReason: 'Entry: weak confirmation or no trend direction close with rejection strength' } };
    }

    // ── SL & TP Calculation ───────────────────────────────────────────────────
    const stopLoss = action === 'BUY'
      ? lastCandle.close - (STOP_LOSS_ATR_MULTIPLIER * atr)
      : lastCandle.close + (STOP_LOSS_ATR_MULTIPLIER * atr);
    const takeProfit = action === 'BUY'
      ? lastCandle.close + (TAKE_PROFIT_ATR_MULTIPLIER * atr)
      : lastCandle.close - (TAKE_PROFIT_ATR_MULTIPLIER * atr);

    if (isNaN(stopLoss) || isNaN(takeProfit)) return { signal: null, debug: { dbgRejectReason: 'stopLoss or takeProfit is NaN' } };

    return {
      signal: {
        id:              `${lastCandle.time}_${action}_v1.5`,
        pair:            'GOLD',
        action,
        entryType:       'pullback',
        entryPrice:      lastCandle.close,
        stopLoss,
        takeProfit,
        atr,
        strategyVersion: 'v1.5',
        timestamp:       Date.now(),
      },
      debug: { dbgRejectReason: null },
    };
  } catch (err) {
    console.error('generateSignal error:', err.message);
    return { signal: null, debug: { dbgRejectReason: `exception: ${err.message}` } };
  }
}
