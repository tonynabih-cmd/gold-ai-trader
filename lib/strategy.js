// strategy.js — 2-layer trade logic.
// Layer 1: EMA20 vs EMA50 direction + ATR stability band.
// Layer 2: EMA20 pullback interaction + next-candle close confirmation.
// Returns a signal object or null (no trade this cycle).

export function generateSignal(indicators, candles1m) {
  try {
    const {
      currEMA20, currEMA50,
      atr, atrAverage,
      prevCandle, lastCandle,
      trendWindowStartTime,
      recentOutcomes,
      lastOrderTimestamp,
    } = indicators;

    // ── Guard: candles1m must exist and have data ─────────────────────────────
    if (!candles1m || candles1m.length === 0) return { signal: null, debug: { dbgRejectReason: 'missing or empty candles1m' } };

    // ── Guard: core indicator values must be valid numbers ────────────────────
    if (
      typeof currEMA20 !== 'number' || isNaN(currEMA20) ||
      typeof currEMA50 !== 'number' || isNaN(currEMA50) ||
      typeof atr       !== 'number' || isNaN(atr)       ||
      typeof atrAverage !== 'number' || isNaN(atrAverage) ||
      !prevCandle || typeof prevCandle.low !== 'number' || typeof prevCandle.high !== 'number' ||
      !lastCandle || typeof lastCandle.close !== 'number'
    ) return { signal: null, debug: { dbgRejectReason: 'invalid or missing indicator values' } };

    const TAKE_PROFIT_ATR_MULTIPLIER = 2.5; // v1.5: was 3.0 — achievable TP (1.67:1 R:R)
    const STOP_LOSS_ATR_MULTIPLIER = 1.5;    // v1.5: was 1.2 — wider SL absorbs slippage
    const EMA20_TOUCH_ZONE_MULTIPLIER = 0.20;
    const ABSOLUTE_MIN_ATR = 1.2;
    const ABSOLUTE_MAX_ATR = 50;
    const ATR_LOW_BAND_MULTIPLIER = 0.65;
    const ATR_HIGH_BAND_MULTIPLIER = 2.0;

    const DEBUG_STRATEGY = process.env.DEBUG_STRATEGY === 'true';

    const hoursSinceLastTrade = (Date.now() - (lastOrderTimestamp || 0)) / (1000 * 60 * 60);
    const dbgEmaSep = Math.abs(currEMA20 - currEMA50);
    const dbgDistToEMA20 = Math.abs(lastCandle.close - currEMA20);
    const touchZone = atr * EMA20_TOUCH_ZONE_MULTIPLIER;
    const minStableAtr = Math.max(ABSOLUTE_MIN_ATR, atrAverage * ATR_LOW_BAND_MULTIPLIER);
    const maxStableAtr = Math.min(ABSOLUTE_MAX_ATR, atrAverage * ATR_HIGH_BAND_MULTIPLIER);

    let action = null;
    const entryType = 'pullback';
    let riskMultiplier = 1.0;
    let dbgPullbackReason = null;
    let dbgSetupReady = false;

    function isTrendingMarket() {
      if (currEMA20 === currEMA50) {
        return { valid: false, reason: 'Layer 1: EMA20 and EMA50 are flat', direction: null };
      }
      if (atr < minStableAtr) {
        return { valid: false, reason: `Layer 1: ATR below stable band (${atr.toFixed(2)} < ${minStableAtr.toFixed(2)})`, direction: null };
      }
      if (atr > maxStableAtr) {
        return { valid: false, reason: `Layer 1: ATR above stable band (${atr.toFixed(2)} > ${maxStableAtr.toFixed(2)})`, direction: null };
      }
      return { valid: true, reason: null, direction: currEMA20 > currEMA50 ? 'BUY' : 'SELL' };
    }

    const layer1 = isTrendingMarket();
    if (!layer1.valid) {
      return {
        signal: null,
        debug: {
          dbgCurrE20: +currEMA20.toFixed(4),
          dbgCurrE50: +currEMA50.toFixed(4),
          dbgEmaSeparation: +dbgEmaSep.toFixed(4),
          dbgDistToEMA20: +dbgDistToEMA20.toFixed(4),
          dbgAtr: +atr.toFixed(4),
          dbgAtrMin: +minStableAtr.toFixed(4),
          dbgAtrMax: +maxStableAtr.toFixed(4),
          dbgPullbackChecked: false,
          dbgAction: null,
          dbgEntryType: null,
          dbgPullbackReason: layer1.reason,
          dbgSetupReady: false,
          isRelaxedMode: false,
          hoursSinceLastTrade,
          dbgRejectReason: layer1.reason,
        },
      };
    }

    action = layer1.direction;

    const previousCandleTouchedZone =
      prevCandle.low <= currEMA20 + touchZone &&
      prevCandle.high >= currEMA20 - touchZone;

    const confirmationCloseValid =
      action === 'BUY'
        ? lastCandle.close > currEMA20
        : lastCandle.close < currEMA20;

    const latestSameDirectionOutcome = Array.isArray(recentOutcomes)
      ? [...recentOutcomes].reverse().find(o => o?.action === action && typeof o?.closedAt === 'number')
      : null;

    if (latestSameDirectionOutcome && typeof trendWindowStartTime === 'number' && latestSameDirectionOutcome.closedAt >= trendWindowStartTime) {
      dbgPullbackReason = `Layer 2: same-direction re-entry blocked inside current EMA trend window (${action})`;
    } else if (!previousCandleTouchedZone) {
      dbgPullbackReason = `Layer 2: no EMA20 touch/sweep on prior candle (zone ${touchZone.toFixed(2)})`;
    } else if (!confirmationCloseValid) {
      dbgSetupReady = true;
      dbgPullbackReason = `Layer 2: confirmation candle did not close ${action === 'BUY' ? 'above' : 'below'} EMA20`;
    }

    const signalDebug = {
      dbgCurrE20:          +currEMA20.toFixed(4),
      dbgCurrE50:          +currEMA50.toFixed(4),
      dbgPrevE20:          null,
      dbgPrevE50:          null,
      dbgEmaSeparation:    +dbgEmaSep?.toFixed(4),
      dbgDistToEMA20:      +dbgDistToEMA20?.toFixed(4),
      dbgPullbackThreshold: +touchZone.toFixed(4),
      dbgAtr:              +atr.toFixed(4),
      dbgAtrMin:           +minStableAtr.toFixed(4),
      dbgAtrMax:           +maxStableAtr.toFixed(4),
      dbgCrossoverChecked: false,
      dbgBuyCrossover:     false,
      dbgSellCrossover:    false,
      dbgPullbackChecked:  true,
      dbgPullbackReason,
      dbgSetupReady,
      dbgRecentTrendCross: action,
      dbgCrossoverAgeBars: null,
      dbgPrevCandleTouchedEMA20: previousCandleTouchedZone,
      dbgTrendWindowStartTime: trendWindowStartTime ?? null,
      dbgLastSameDirectionClose: latestSameDirectionOutcome?.closedAt ?? null,
      dbgAction:           action,
      dbgEntryType:        entryType,
      isRelaxedMode: false,
      hoursSinceLastTrade,
      dbgMarketConditions: {
          atr,
          atrAverage,
          spread: indicators.spread,
          layer1Direction: action,
      }
    };

    if (DEBUG_STRATEGY) {
        console.log(`[STRATEGY_DEBUG] Cycle: ${new Date().toISOString()}`);
        console.log(`[STRATEGY_DEBUG] Price: ${lastCandle.close} | EMA20: ${currEMA20.toFixed(2)} | EMA50: ${currEMA50.toFixed(2)}`);
        console.log(`[STRATEGY_DEBUG] ATR: ${atr.toFixed(2)} | Stable band: ${minStableAtr.toFixed(2)} - ${maxStableAtr.toFixed(2)}`);
        console.log(`[STRATEGY_DEBUG] Prev touch: ${previousCandleTouchedZone} | Confirm close valid: ${confirmationCloseValid}`);
        console.log(`[STRATEGY_DEBUG] ${dbgPullbackReason ? `REJECTED: ${dbgPullbackReason}` : `SIGNAL DETECTED: ${action} via ${entryType}`}`);
    }

    if (!action) return { signal: null, debug: { ...signalDebug, dbgRejectReason: dbgPullbackReason ?? 'no crossover and no pullback signal' } };
    if (dbgPullbackReason) {
      return { signal: null, debug: { ...signalDebug, dbgRejectReason: dbgPullbackReason } };
    }

    const stopLoss = action === 'BUY'
      ? lastCandle.close - (STOP_LOSS_ATR_MULTIPLIER * atr)
      : lastCandle.close + (STOP_LOSS_ATR_MULTIPLIER * atr);
    const takeProfit = action === 'BUY'
      ? lastCandle.close + (TAKE_PROFIT_ATR_MULTIPLIER * atr)
      : lastCandle.close - (TAKE_PROFIT_ATR_MULTIPLIER * atr);

    if (isNaN(stopLoss) || isNaN(takeProfit)) return { signal: null, debug: { ...signalDebug, dbgRejectReason: 'stopLoss or takeProfit is NaN' } };

    return {
      signal: {
        id:              `${lastCandle.time}_${action}_v1.5`,
        pair:            'GOLD',
        action,
        entryType,
        entryPrice:      lastCandle.close,
        stopLoss,
        takeProfit,
        atr,
        score:           2,
        riskMultiplier,
        isRelaxedMode:   false,
        hoursSinceLastTrade,
        strategyVersion: 'v1.5',
        timestamp:       Date.now(),
      },
      debug: { ...signalDebug, dbgScore: 2, dbgRejectReason: null },
    };
  } catch (err) {
    console.error('generateSignal error:', err.message);
    return { signal: null, debug: { dbgRejectReason: `exception: ${err.message}` } };
  }
}
