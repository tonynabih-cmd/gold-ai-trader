// strategy.js — strict 2-layer logic
export function generateSignal(indicators, _) {
  try {
    const {
      currEMA20, currEMA50,
      ema20arr, ema50arr,
      ema20_1h, ema50_1h,
      atr, atrAverage,
      prevCandle, lastCandle,
    } = indicators;

    if (
      typeof currEMA20 !== 'number' || isNaN(currEMA20) ||
      typeof currEMA50 !== 'number' || isNaN(currEMA50) ||
      typeof ema20_1h !== 'number' || isNaN(ema20_1h) ||
      typeof ema50_1h !== 'number' || isNaN(ema50_1h) ||
      typeof atr       !== 'number' || isNaN(atr)       ||
      !Array.isArray(ema20arr) || ema20arr.length < 6 ||
      !Array.isArray(ema50arr) || ema50arr.length < 6 ||
      !prevCandle || typeof prevCandle.low !== 'number' || typeof prevCandle.high !== 'number' ||
      !lastCandle || typeof lastCandle.close !== 'number'
    ) return { signal: null, debug: { dbgRejectReason: 'invalid or missing indicator values' } };

    const TAKE_PROFIT_ATR_MULTIPLIER = 2.5;
    const STOP_LOSS_ATR_MULTIPLIER = 1.5;
    const EMA20_TOUCH_ZONE_MULTIPLIER = 0.30;

    // ── Layer 1: Regime Filter ────────────────────────────────────────────────
    let action = null;
    if (currEMA20 > currEMA50) {
      action = 'BUY';
    } else if (currEMA20 < currEMA50) {
      action = 'SELL';
    } else {
      return { signal: null, debug: { dbgRejectReason: 'EMA20 and EMA50 are flat' } };
    }

    if (action === 'BUY' && indicators.trend1h !== 'UP') {
      return { signal: null, debug: { dbgRejectReason: `Regime: 1h trend conflict (1h is ${indicators.trend1h})` } };
    }
    if (action === 'SELL' && indicators.trend1h !== 'DOWN') {
      return { signal: null, debug: { dbgRejectReason: `Regime: 1h trend conflict (1h is ${indicators.trend1h})` } };
    }

    const emaSep1 = ema20arr[ema20arr.length - 2] - ema50arr[ema50arr.length - 2];
    const emaSep2 = ema20arr[ema20arr.length - 3] - ema50arr[ema50arr.length - 3];
    const emaSep3 = ema20arr[ema20arr.length - 4] - ema50arr[ema50arr.length - 4];
    const emaSep4 = ema20arr[ema20arr.length - 5] - ema50arr[ema50arr.length - 5];
    const emaSep5 = ema20arr[ema20arr.length - 6] - ema50arr[ema50arr.length - 6];

    // Check if expansion happened on any recent sequence leading into the current state.
    // Direction-aware: requires the signed separation to keep its sign and expand in the current action direction.
    // Relaxed from a strict 3-step chain to a 2-step chain so valid trends are not over-rejected.
    const priorExpansion =
      action === 'BUY'
        ? (
            (emaSep1 > 0 && emaSep2 > 0 && emaSep1 > emaSep2) ||
            (emaSep2 > 0 && emaSep3 > 0 && emaSep2 > emaSep3) ||
            (emaSep3 > 0 && emaSep4 > 0 && emaSep3 > emaSep4) ||
            (emaSep4 > 0 && emaSep5 > 0 && emaSep4 > emaSep5)
          )
        : (
            (emaSep1 < 0 && emaSep2 < 0 && emaSep1 < emaSep2) ||
            (emaSep2 < 0 && emaSep3 < 0 && emaSep2 < emaSep3) ||
            (emaSep3 < 0 && emaSep4 < 0 && emaSep3 < emaSep4) ||
            (emaSep4 < 0 && emaSep5 < 0 && emaSep4 < emaSep5)
          );

    if (!priorExpansion) {
      return { signal: null, debug: { dbgRejectReason: 'Regime: No prior EMA expansion detected leading into pullback' } };
    }

    const MIN_ATR_FOR_TRADING = 0.50; // Conservative floor for XAUUSD 5m to avoid dead markets

    if (atr < MIN_ATR_FOR_TRADING) {
      return { signal: null, debug: { dbgRejectReason: `Regime: ATR below minimum threshold (${MIN_ATR_FOR_TRADING.toFixed(2)})` } };
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
      ? lastCandle.close > currEMA20 && lastCandle.close > lastCandle.open && isStrongBody && ((lastCandle.close - lastCandle.low) / candleSize >= 0.6)
      : lastCandle.close < currEMA20 && lastCandle.close < lastCandle.open && isStrongBody && ((lastCandle.high - lastCandle.close) / candleSize >= 0.6);

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
      debug: { dbgRejectReason: null, dbgSetupReady: true },
    };
  } catch (err) {
    console.error('generateSignal error:', err.message);
    return { signal: null, debug: { dbgRejectReason: `exception: ${err.message}` } };
  }
}
