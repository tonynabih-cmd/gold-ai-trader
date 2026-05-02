// strategy.js — strict 2-layer logic
export const STRATEGY_VERSION = 'v1.5';

const TREND_CONFLICT_CONFIDENCE_PENALTY = 10;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value) {
  return Number(value.toFixed(2));
}

function finiteDiagnostic(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function roundDiagnostic(value) {
  const num = finiteDiagnostic(value);
  return num === null ? null : Number(num.toFixed(4));
}

function candleShapeDiagnostics(candle) {
  const open = finiteDiagnostic(candle?.open);
  const high = finiteDiagnostic(candle?.high);
  const low = finiteDiagnostic(candle?.low);
  const close = finiteDiagnostic(candle?.close);
  if (open === null || high === null || low === null || close === null) {
    return { bodyPct: null, upperWickPct: null, lowerWickPct: null };
  }

  const range = high - low;
  if (!Number.isFinite(range) || range <= 0) {
    return { bodyPct: null, upperWickPct: null, lowerWickPct: null };
  }

  return {
    bodyPct: roundDiagnostic((Math.abs(close - open) / range) * 100),
    upperWickPct: roundDiagnostic(((high - Math.max(open, close)) / range) * 100),
    lowerWickPct: roundDiagnostic(((Math.min(open, close) - low) / range) * 100),
  };
}

function validCandle(candle) {
  return (
    finiteDiagnostic(candle?.open) !== null &&
    finiteDiagnostic(candle?.high) !== null &&
    finiteDiagnostic(candle?.low) !== null &&
    finiteDiagnostic(candle?.close) !== null
  );
}

export function detectLiquiditySweep(candles5m, currentCandle, atr14_5m) {
  const atr = finiteDiagnostic(atr14_5m);
  const current = currentCandle && validCandle(currentCandle) ? currentCandle : null;

  if (!Array.isArray(candles5m) || candles5m.length < 12 || !current || atr === null || atr <= 0) {
    const shape = candleShapeDiagnostics(current);
    return {
      sweepValid: null,
      sweepDirection: null,
      swingHigh: null,
      swingLow: null,
      ...shape,
    };
  }

  const priorCandles = candles5m.slice(-12);
  if (priorCandles.length < 12 || priorCandles.some(candle => !validCandle(candle))) {
    const shape = candleShapeDiagnostics(current);
    return {
      sweepValid: null,
      sweepDirection: null,
      swingHigh: null,
      swingLow: null,
      ...shape,
    };
  }

  const swingLow = Math.min(...priorCandles.map(candle => candle.low));
  const swingHigh = Math.max(...priorCandles.map(candle => candle.high));
  const range = current.high - current.low;
  const shape = candleShapeDiagnostics(current);
  const rangeOk = range >= 0.50 * atr && range <= 2.00 * atr;

  const buySweep =
    current.low < swingLow - 0.10 * atr &&
    current.close > swingLow &&
    shape.lowerWickPct !== null && shape.lowerWickPct >= 45 &&
    shape.bodyPct !== null && shape.bodyPct >= 30 &&
    rangeOk;

  const sellSweep =
    current.high > swingHigh + 0.10 * atr &&
    current.close < swingHigh &&
    shape.upperWickPct !== null && shape.upperWickPct >= 45 &&
    shape.bodyPct !== null && shape.bodyPct >= 30 &&
    rangeOk;

  return {
    sweepValid: buySweep || sellSweep,
    sweepDirection: buySweep ? 'BUY' : sellSweep ? 'SELL' : null,
    swingHigh: roundDiagnostic(swingHigh),
    swingLow: roundDiagnostic(swingLow),
    ...shape,
  };
}

function calculateSetupConfidence({
  action,
  currEMA20,
  currEMA50,
  emaSep1,
  emaSep2,
  atr,
  atrAverage,
  prevCandle,
  lastCandle,
  touchZone,
}) {
  const emaSepAtr = Math.abs(currEMA20 - currEMA50) / atr;
  const expansionDeltaAtr = Math.max(0, Math.abs(emaSep1) - Math.abs(emaSep2)) / atr;
  const trendStructure = clamp(emaSepAtr / 0.8, 0, 1) * 25;
  const expansion = clamp(expansionDeltaAtr / 0.25, 0, 1) * 15;

  const prevMid = (prevCandle.high + prevCandle.low) / 2;
  const touchDistance = Math.abs(prevMid - currEMA20);
  const pullbackQuality = (1 - clamp(touchDistance / Math.max(touchZone, 0.01), 0, 1)) * 15;

  const candleSize = lastCandle.high - lastCandle.low;
  const bodySize = Math.abs(lastCandle.close - lastCandle.open);
  const bodyRatio = candleSize > 0 ? bodySize / candleSize : 0;
  const closeLocation = action === 'BUY'
    ? (lastCandle.close - lastCandle.low) / candleSize
    : (lastCandle.high - lastCandle.close) / candleSize;
  const confirmation = ((clamp(bodyRatio / 0.65, 0, 1) * 0.45) + (clamp(closeLocation / 0.8, 0, 1) * 0.55)) * 25;

  const atrBaseline = Number(atrAverage);
  const atrRatio = Number.isFinite(atrBaseline) && atrBaseline > 0 ? atr / atrBaseline : 1;
  const volatilityFit = (1 - clamp(Math.abs(atrRatio - 1) / 1.5, 0, 1)) * 20;

  const components = {
    trendStructure: roundScore(trendStructure),
    expansion: roundScore(expansion),
    pullbackQuality: roundScore(pullbackQuality),
    confirmation: roundScore(confirmation),
    volatilityFit: roundScore(volatilityFit),
  };
  const score = roundScore(Object.values(components).reduce((sum, value) => sum + value, 0));

  return {
    score,
    components,
    grade: score >= 85 ? 'A' : score >= 75 ? 'B' : score >= 65 ? 'C' : 'D',
  };
}

function gradeSetupConfidence(score) {
  return score >= 85 ? 'A' : score >= 75 ? 'B' : score >= 65 ? 'C' : 'D';
}

export function generateSignal(indicators, _) {
  try {
    if (!indicators || typeof indicators !== 'object') {
      return { signal: null, debug: { dbgRejectReason: 'invalid or missing indicator values' } };
    }

    const {
      currEMA20, currEMA50,
      ema20arr, ema50arr,
      ema20_1h, ema50_1h,
      atr, atrAverage,
      prevCandle, lastCandle,
    } = indicators;

    const debugBase = {
      dbgCurrE20: currEMA20 ?? null,
      dbgCurrE50: currEMA50 ?? null,
      dbg1hE20: ema20_1h ?? null,
      dbg1hE50: ema50_1h ?? null,
      dbgTrend1h: indicators?.trend1h ?? null,
      dbgAtr: atr ?? null,
      dbgAtrAverage: atrAverage ?? null,
      dbgPullbackChecked: true,
      dbgCrossoverChecked: false,
      atrRatio: null,
      emaSpreadAtr: null,
      pullbackValid: null,
      sweepValid: null,
      sweepDirection: null,
      bosValid: null,
      bodyPct: null,
      upperWickPct: null,
      lowerWickPct: null,
      swingHigh: null,
      swingLow: null,
      rrCandidate: null,
      rejectStage: 'validation',
    };

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
    ) return { signal: null, debug: { ...debugBase, dbgRejectReason: 'invalid or missing indicator values' } };

    const STOP_LOSS_ATR_MULTIPLIER = 1.5;
    const MIN_REWARD_R_MULTIPLE = 2.5;
    const TAKE_PROFIT_ATR_MULTIPLIER = STOP_LOSS_ATR_MULTIPLIER * MIN_REWARD_R_MULTIPLE;
    const EMA20_TOUCH_ZONE_MULTIPLIER = 0.30;
    const atrRatio = Number.isFinite(Number(atrAverage)) && Number(atrAverage) > 0 ? atr / Number(atrAverage) : null;
    const emaSpreadAtr = atr > 0 ? Math.abs(currEMA20 - currEMA50) / atr : null;
    const recentCandles = Array.isArray(indicators.recentCandles5m)
      ? indicators.recentCandles5m
      : Array.isArray(indicators.candles5m)
        ? indicators.candles5m.slice(-13)
        : null;
    const priorSweepCandles = Array.isArray(recentCandles) ? recentCandles.slice(-13, -1) : null;
    const sweepDiagnostics = detectLiquiditySweep(priorSweepCandles, lastCandle, atr);
    const strategyDiagnostics = {
      atrRatio: roundDiagnostic(atrRatio),
      emaSpreadAtr: roundDiagnostic(emaSpreadAtr),
      ...sweepDiagnostics,
      rejectStage: null,
    };

    // ── Layer 1: Regime Filter ────────────────────────────────────────────────
    let action = null;
    if (currEMA20 > currEMA50) {
      action = 'BUY';
    } else if (currEMA20 < currEMA50) {
      action = 'SELL';
    } else {
      return { signal: null, debug: { ...debugBase, ...strategyDiagnostics, rejectStage: 'regime', dbgRejectReason: 'EMA20 and EMA50 are flat' } };
    }

    const trendConflict =
      (action === 'BUY' && indicators.trend1h !== 'UP') ||
      (action === 'SELL' && indicators.trend1h !== 'DOWN');

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
      return { signal: null, debug: { ...debugBase, ...strategyDiagnostics, dbgAction: action, rejectStage: 'regime', dbgRejectReason: 'Regime: No prior EMA expansion detected leading into pullback' } };
    }

    const MIN_ATR_FOR_TRADING = 0.50; // Conservative floor for XAUUSD 5m to avoid dead markets

    if (atr < MIN_ATR_FOR_TRADING) {
      return { signal: null, debug: { ...debugBase, ...strategyDiagnostics, dbgAction: action, rejectStage: 'regime', dbgRejectReason: `Regime: ATR below minimum threshold (${MIN_ATR_FOR_TRADING.toFixed(2)})` } };
    }

    // ── Layer 2: Entry Filter ─────────────────────────────────────────────────
    const touchZone = atr * EMA20_TOUCH_ZONE_MULTIPLIER;
    const previousCandleTouchedZone =
      prevCandle.low <= currEMA20 + touchZone &&
      prevCandle.high >= currEMA20 - touchZone;
    const entryDiagnostics = {
      ...strategyDiagnostics,
      pullbackValid: previousCandleTouchedZone,
    };

    if (!previousCandleTouchedZone) {
      return { signal: null, debug: { ...debugBase, ...entryDiagnostics, dbgAction: action, rejectStage: 'entry', dbgRejectReason: `Entry: no EMA20 touch/sweep on prior candle (zone ${touchZone.toFixed(2)})` } };
    }

    const candleSize = lastCandle.high - lastCandle.low;
    if (candleSize === 0) return { signal: null, debug: { ...debugBase, ...entryDiagnostics, dbgAction: action, rejectStage: 'entry', dbgRejectReason: 'Entry: Candle size is 0' } };

    const bodySize = Math.abs(lastCandle.close - lastCandle.open);
    const isStrongBody = bodySize >= candleSize * 0.4;

    const confirmationValid = action === 'BUY'
      ? lastCandle.close > currEMA20 && lastCandle.close > lastCandle.open && isStrongBody && ((lastCandle.close - lastCandle.low) / candleSize >= 0.6)
      : lastCandle.close < currEMA20 && lastCandle.close < lastCandle.open && isStrongBody && ((lastCandle.high - lastCandle.close) / candleSize >= 0.6);

    if (!confirmationValid) {
      return { signal: null, debug: { ...debugBase, ...entryDiagnostics, dbgAction: action, rejectStage: 'entry', dbgRejectReason: 'Entry: weak confirmation or no trend direction close with rejection strength' } };
    }

    // ── SL & TP Calculation ───────────────────────────────────────────────────
    const stopLoss = action === 'BUY'
      ? lastCandle.close - (STOP_LOSS_ATR_MULTIPLIER * atr)
      : lastCandle.close + (STOP_LOSS_ATR_MULTIPLIER * atr);
    const takeProfit = action === 'BUY'
      ? lastCandle.close + (TAKE_PROFIT_ATR_MULTIPLIER * atr)
      : lastCandle.close - (TAKE_PROFIT_ATR_MULTIPLIER * atr);

    if (isNaN(stopLoss) || isNaN(takeProfit)) return { signal: null, debug: { ...debugBase, ...entryDiagnostics, dbgAction: action, rejectStage: 'sl_tp', dbgRejectReason: 'stopLoss or takeProfit is NaN' } };

    const rawSetupConfidence = calculateSetupConfidence({
      action,
      currEMA20,
      currEMA50,
      emaSep1,
      emaSep2,
      atr,
      atrAverage,
      prevCandle,
      lastCandle,
      touchZone,
    });
    const trendConflictPenalty = trendConflict ? TREND_CONFLICT_CONFIDENCE_PENALTY : 0;
    const setupConfidenceScore = roundScore(clamp(rawSetupConfidence.score - trendConflictPenalty, 0, 100));
    const setupConfidence = {
      ...rawSetupConfidence,
      score: setupConfidenceScore,
      rawScore: rawSetupConfidence.score,
      trendConflict,
      trendConflictPenalty: trendConflict ? -TREND_CONFLICT_CONFIDENCE_PENALTY : 0,
      penaltyReason: trendConflict ? '1h trend conflict penalty applied: -10' : null,
      penalties: trendConflict ? ['1h trend conflict penalty applied: -10'] : [],
      grade: gradeSetupConfidence(setupConfidenceScore),
    };

    if (trendConflict) {
      console.log(`[STRATEGY] 1h trend conflict penalty applied: -10 (${action} vs 1h ${indicators.trend1h})`);
    }

    const initialRewardRisk = Math.abs(takeProfit - lastCandle.close) / Math.abs(lastCandle.close - stopLoss);
    const readyDiagnostics = {
      ...entryDiagnostics,
      rrCandidate: roundDiagnostic(initialRewardRisk),
      rejectStage: null,
    };

    return {
      signal: {
        id:              `${lastCandle.time}_${action}_${STRATEGY_VERSION}`,
        pair:            'GOLD',
        action,
        entryType:       'pullback',
        entryPrice:      lastCandle.close,
        stopLoss,
        takeProfit,
        atr,
        score:          setupConfidence.score,
        setupConfidenceScore: setupConfidence.score,
        setupConfidence,
        trendConflict,
        trendConflictPenalty: setupConfidence.trendConflictPenalty,
        initialRewardRisk,
        strategyVersion: STRATEGY_VERSION,
        timestamp:       Date.now(),
      },
      debug: {
        ...debugBase,
        ...readyDiagnostics,
        dbgRejectReason: null,
        dbgAction: action,
        dbgEntryType: 'pullback',
        dbgSetupReady: true,
        dbgScore: setupConfidence.score,
        dbgSetupConfidenceScore: setupConfidence.score,
        dbgRawSetupConfidenceScore: rawSetupConfidence.score,
        dbgTrendConflict: trendConflict,
        dbgTrendConflictPenalty: setupConfidence.trendConflictPenalty,
        dbgPenaltyReason: setupConfidence.penaltyReason,
        dbgInitialRewardRisk: initialRewardRisk,
      },
    };
  } catch (err) {
    console.error('generateSignal error:', err.message);
    return { signal: null, debug: { dbgRejectReason: `exception: ${err.message}` } };
  }
}
