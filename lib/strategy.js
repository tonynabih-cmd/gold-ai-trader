// strategy.js — strict 2-layer logic
export function generateSignal(indicators, _) {
  try {
    const {
      currEMA20, currEMA50,
      atr,
      prevCandle, lastCandle,
    } = indicators;

    if (
      typeof currEMA20 !== 'number' || isNaN(currEMA20) ||
      typeof currEMA50 !== 'number' || isNaN(currEMA50) ||
      typeof atr       !== 'number' || isNaN(atr)       ||
      !prevCandle || typeof prevCandle.low !== 'number' || typeof prevCandle.high !== 'number' ||
      !lastCandle || typeof lastCandle.close !== 'number'
    ) return { signal: null, debug: { dbgRejectReason: 'invalid or missing indicator values' } };

    const TAKE_PROFIT_ATR_MULTIPLIER = 2.5;
    const STOP_LOSS_ATR_MULTIPLIER = 1.5;
    const EMA20_TOUCH_ZONE_MULTIPLIER = 0.20;

    // Layer 1: Trend detection via EMA20 vs EMA50
    let action = null;
    if (currEMA20 > currEMA50) {
      action = 'BUY';
    } else if (currEMA20 < currEMA50) {
      action = 'SELL';
    } else {
      return { signal: null, debug: { dbgRejectReason: 'EMA20 and EMA50 are flat' } };
    }

    // Layer 2: Pullback Touch & Confirmation Close
    const touchZone = atr * EMA20_TOUCH_ZONE_MULTIPLIER;
    const previousCandleTouchedZone =
      prevCandle.low <= currEMA20 + touchZone &&
      prevCandle.high >= currEMA20 - touchZone;

    if (!previousCandleTouchedZone) {
      return { signal: null, debug: { dbgRejectReason: `no EMA20 touch/sweep on prior candle (zone ${touchZone.toFixed(2)})` } };
    }

    const confirmationCloseValid =
      action === 'BUY'
        ? lastCandle.close > currEMA20
        : lastCandle.close < currEMA20;

    if (!confirmationCloseValid) {
      return { signal: null, debug: { dbgRejectReason: `confirmation candle did not close ${action === 'BUY' ? 'above' : 'below'} EMA20` } };
    }

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
