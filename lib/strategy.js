// strategy.js — strict 2-layer logic
export const STRATEGY_VERSION = 'v1.6-exit-first';

const TREND_CONFLICT_CONFIDENCE_PENALTY = 5;
const EMA_EXPANSION_CONFIDENCE_PENALTY = 5;
const EMA_EXPANSION_HANDLED_AS = 'CONFIDENCE_PENALTY';
export const EMA_TOUCH_TOLERANCE_ATR = 0.15;
const CONFIRMATION_DISPLACEMENT_ATR = 0.10;
const MAX_OPPOSITE_WICK_PCT = 45;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value) {
  return Number(value.toFixed(2));
}

function finiteDiagnostic(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function roundDiagnostic(value) {
  const num = finiteDiagnostic(value);
  return num === null ? null : Number(num.toFixed(4));
}

function requiredFiniteDiagnostic(value) {
  if (value === null || value === undefined) return null;
  return finiteDiagnostic(value);
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

function candidateFailedReason(parts) {
  const failed = parts.filter(Boolean);
  return failed.length > 0 ? failed.join('; ') : null;
}

function validCandle(candle) {
  return (
    finiteDiagnostic(candle?.open) !== null &&
    finiteDiagnostic(candle?.high) !== null &&
    finiteDiagnostic(candle?.low) !== null &&
    finiteDiagnostic(candle?.close) !== null
  );
}

function distanceFromRangeToLevel(low, high, level) {
  if (low <= level && high >= level) return 0;
  return low > level ? low - level : level - high;
}

export function detectLiquiditySweep(candles5m, currentCandle, atr14_5m) {
  const atr = finiteDiagnostic(atr14_5m);
  const current = currentCandle && validCandle(currentCandle) ? currentCandle : null;

  if (!Array.isArray(candles5m) || candles5m.length < 12 || !current || atr === null || atr <= 0) {
    const shape = candleShapeDiagnostics(current);
    return {
      sweepValid: null,
      sweepDirection: null,
      sweepCandidate: null,
      sweepLookbackUsed: Array.isArray(candles5m) ? candles5m.length : null,
      sweepBreakDistanceAtr: null,
      sweepWickPct: null,
      sweepBodyPct: shape.bodyPct,
      sweepFailedReason: 'Sweep validation unavailable: missing candles, ATR, or candle values',
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
      sweepCandidate: null,
      sweepLookbackUsed: priorCandles.length,
      sweepBreakDistanceAtr: null,
      sweepWickPct: null,
      sweepBodyPct: shape.bodyPct,
      sweepFailedReason: 'Sweep validation unavailable: invalid lookback candles',
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
  const buyBreakDistanceAtr = (swingLow - current.low) / atr;
  const sellBreakDistanceAtr = (current.high - swingHigh) / atr;
  const buyCandidate = buyBreakDistanceAtr > 0.10;
  const sellCandidate = sellBreakDistanceAtr > 0.10;
  const sweepCandidate = buyCandidate || sellCandidate;
  const candidateDirection = buyCandidate ? 'BUY' : sellCandidate ? 'SELL' : null;
  const candidateWickPct = candidateDirection === 'BUY'
    ? shape.lowerWickPct
    : candidateDirection === 'SELL'
      ? shape.upperWickPct
      : null;
  const candidateBreakDistanceAtr = buyCandidate
    ? buyBreakDistanceAtr
    : sellCandidate
      ? sellBreakDistanceAtr
      : Math.max(buyBreakDistanceAtr, sellBreakDistanceAtr);
  const reclaimOk = candidateDirection === 'BUY'
    ? current.close > swingLow
    : candidateDirection === 'SELL'
      ? current.close < swingHigh
      : false;
  const wickOk = candidateWickPct !== null && candidateWickPct >= 45;
  const bodyOk = shape.bodyPct !== null && shape.bodyPct >= 30;

  return {
    sweepValid: buySweep || sellSweep,
    sweepDirection: buySweep ? 'BUY' : sellSweep ? 'SELL' : null,
    sweepCandidate,
    sweepLookbackUsed: priorCandles.length,
    sweepBreakDistanceAtr: roundDiagnostic(candidateBreakDistanceAtr),
    sweepWickPct: roundDiagnostic(candidateWickPct),
    sweepBodyPct: shape.bodyPct,
    sweepFailedReason: buySweep || sellSweep
      ? null
      : candidateFailedReason([
          sweepCandidate ? null : 'No qualifying liquidity break',
          sweepCandidate && !reclaimOk ? 'Sweep did not reclaim swing level' : null,
          sweepCandidate && !wickOk ? 'Sweep wick below threshold' : null,
          sweepCandidate && !bodyOk ? 'Sweep body below threshold' : null,
          sweepCandidate && !rangeOk ? 'Sweep candle range outside ATR bounds' : null,
        ]),
    swingHigh: roundDiagnostic(swingHigh),
    swingLow: roundDiagnostic(swingLow),
    ...shape,
  };
}

export function validatePullback(candle, ema20_5m, ema50_5m, atr14_5m, preferredDirection = null) {
  const low = requiredFiniteDiagnostic(candle?.low);
  const high = requiredFiniteDiagnostic(candle?.high);
  const close = requiredFiniteDiagnostic(candle?.close);
  const ema20 = requiredFiniteDiagnostic(ema20_5m);
  const ema50 = requiredFiniteDiagnostic(ema50_5m);
  const atr = requiredFiniteDiagnostic(atr14_5m);
  const direction = preferredDirection === 'BUY' || preferredDirection === 'SELL'
    ? preferredDirection
    : null;

  if (
    low === null || high === null || close === null ||
    ema20 === null || ema50 === null || atr === null || atr <= 0
  ) {
    return {
      pullbackValid: null,
      pullbackDirection: null,
      pullbackDistanceAtr: null,
      pullbackDistanceFromEma20Atr: null,
      pullbackDistanceFromEma50Atr: null,
      pullbackNearMiss: null,
      pullbackMissDistanceAtr: null,
      pullbackRejectReason: 'Pullback validation unavailable: missing ATR, EMA, or candle values',
    };
  }

  const buyTooShallow = low > ema20 + 0.25 * atr;
  const buyTooDeep = low < ema50 - 0.35 * atr;
  const buyCloseInvalid = close <= ema50;
  const buyValid = !buyTooShallow && !buyTooDeep && !buyCloseInvalid;

  const sellTooShallow = high < ema20 - 0.25 * atr;
  const sellTooDeep = high > ema50 + 0.35 * atr;
  const sellCloseInvalid = close >= ema50;
  const sellValid = !sellTooShallow && !sellTooDeep && !sellCloseInvalid;

  if (buyValid || sellValid) {
    const pullbackDirection = buyValid ? 'BUY' : 'SELL';
    const extreme = pullbackDirection === 'BUY' ? low : high;
    return {
      pullbackValid: true,
      pullbackDirection,
      pullbackDistanceAtr: roundDiagnostic(Math.abs(extreme - ema20) / atr),
      pullbackDistanceFromEma20Atr: roundDiagnostic(Math.abs(extreme - ema20) / atr),
      pullbackDistanceFromEma50Atr: roundDiagnostic(Math.abs(extreme - ema50) / atr),
      pullbackNearMiss: false,
      pullbackMissDistanceAtr: 0,
      pullbackRejectReason: null,
    };
  }

  const directionToExplain = direction ?? (ema20 >= ema50 ? 'BUY' : 'SELL');
  const reason = directionToExplain === 'BUY'
    ? buyTooShallow
      ? 'BUY pullback invalid: low did not reach EMA20 zone'
      : buyTooDeep
        ? 'BUY pullback invalid: low extended below EMA50 zone'
        : 'BUY pullback invalid: close did not reclaim EMA50'
    : sellTooShallow
      ? 'SELL pullback invalid: high did not reach EMA20 zone'
      : sellTooDeep
        ? 'SELL pullback invalid: high extended above EMA50 zone'
        : 'SELL pullback invalid: close did not reject below EMA50';
  const extreme = directionToExplain === 'BUY' ? low : high;
  const missDistances = directionToExplain === 'BUY'
    ? [
        buyTooShallow ? (low - (ema20 + 0.25 * atr)) / atr : null,
        buyTooDeep ? ((ema50 - 0.35 * atr) - low) / atr : null,
        buyCloseInvalid ? (ema50 - close) / atr : null,
      ]
    : [
        sellTooShallow ? ((ema20 - 0.25 * atr) - high) / atr : null,
        sellTooDeep ? (high - (ema50 + 0.35 * atr)) / atr : null,
        sellCloseInvalid ? (close - ema50) / atr : null,
      ];
  const finiteMissDistances = missDistances
    .map(value => finiteDiagnostic(value))
    .filter(value => value !== null && value >= 0);
  const pullbackMissDistanceAtr = finiteMissDistances.length > 0
    ? Math.min(...finiteMissDistances)
    : null;

  return {
    pullbackValid: false,
    pullbackDirection: null,
    pullbackDistanceAtr: roundDiagnostic(Math.abs(extreme - ema20) / atr),
    pullbackDistanceFromEma20Atr: roundDiagnostic(Math.abs(extreme - ema20) / atr),
    pullbackDistanceFromEma50Atr: roundDiagnostic(Math.abs(extreme - ema50) / atr),
    pullbackNearMiss: pullbackMissDistanceAtr !== null ? pullbackMissDistanceAtr <= 0.15 : null,
    pullbackMissDistanceAtr: roundDiagnostic(pullbackMissDistanceAtr),
    pullbackRejectReason: `${reason}; no valid BUY or SELL pullback`,
  };
}

export function findLastFractalSwings(candles5m) {
  if (!Array.isArray(candles5m) || candles5m.length < 5 || candles5m.some(candle => !validCandle(candle))) {
    return { lastSwingHigh: null, lastSwingLow: null };
  }

  let lastSwingHigh = null;
  let lastSwingLow = null;

  for (let i = 2; i <= candles5m.length - 3; i++) {
    const candle = candles5m[i];
    const swingHigh =
      candle.high > candles5m[i - 1].high &&
      candle.high > candles5m[i - 2].high &&
      candle.high > candles5m[i + 1].high &&
      candle.high > candles5m[i + 2].high;
    const swingLow =
      candle.low < candles5m[i - 1].low &&
      candle.low < candles5m[i - 2].low &&
      candle.low < candles5m[i + 1].low &&
      candle.low < candles5m[i + 2].low;

    if (swingHigh) lastSwingHigh = candle.high;
    if (swingLow) lastSwingLow = candle.low;
  }

  return {
    lastSwingHigh: roundDiagnostic(lastSwingHigh),
    lastSwingLow: roundDiagnostic(lastSwingLow),
  };
}

export function detectBreakOfStructure(candles5m, currentCandle, atr14_5m) {
  const atr = requiredFiniteDiagnostic(atr14_5m);
  const current = currentCandle && validCandle(currentCandle) ? currentCandle : null;
  const shape = candleShapeDiagnostics(current);

  if (!Array.isArray(candles5m) || candles5m.length < 5 || !current || atr === null || atr <= 0) {
    return {
      bosValid: null,
      bosDirection: null,
      bosCandidate: null,
      lastSwingHigh: null,
      lastSwingLow: null,
      bosBreakDistanceAtr: null,
      bosFailedReason: 'BOS validation unavailable: missing candles, ATR, or candle values',
    };
  }

  const { lastSwingHigh, lastSwingLow } = findLastFractalSwings(candles5m);
  if (lastSwingHigh === null && lastSwingLow === null) {
    return {
      bosValid: false,
      bosDirection: null,
      bosCandidate: false,
      lastSwingHigh: null,
      lastSwingLow: null,
      bosBreakDistanceAtr: null,
      bosFailedReason: 'No fractal swing levels available',
    };
  }

  const bodyOk = shape.bodyPct !== null && shape.bodyPct >= 40;
  const buyBreakDistanceAtr = lastSwingHigh !== null
    ? (current.close - (lastSwingHigh + 0.05 * atr)) / atr
    : null;
  const sellBreakDistanceAtr = lastSwingLow !== null
    ? ((lastSwingLow - 0.05 * atr) - current.close) / atr
    : null;
  const buyBos = bodyOk && buyBreakDistanceAtr !== null && buyBreakDistanceAtr > 0;
  const sellBos = bodyOk && sellBreakDistanceAtr !== null && sellBreakDistanceAtr > 0;
  const buyCandidate = buyBreakDistanceAtr !== null && buyBreakDistanceAtr > 0;
  const sellCandidate = sellBreakDistanceAtr !== null && sellBreakDistanceAtr > 0;
  const bosCandidate = buyCandidate || sellCandidate;
  const candidateBreakDistanceAtr = buyCandidate
    ? buyBreakDistanceAtr
    : sellCandidate
      ? sellBreakDistanceAtr
      : null;

  return {
    bosValid: buyBos || sellBos,
    bosDirection: buyBos ? 'BUY' : sellBos ? 'SELL' : null,
    bosCandidate,
    lastSwingHigh,
    lastSwingLow,
    bosBreakDistanceAtr: buyBos
      ? roundDiagnostic(buyBreakDistanceAtr)
      : sellBos
        ? roundDiagnostic(sellBreakDistanceAtr)
        : roundDiagnostic(candidateBreakDistanceAtr),
    bosFailedReason: buyBos || sellBos
      ? null
      : candidateFailedReason([
          bosCandidate ? null : 'No qualifying structure break',
          bosCandidate && !bodyOk ? 'BOS body below threshold' : null,
        ]),
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
  sweepDiagnostics,
  bosDiagnostics,
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
  const sweepBonus = sweepDiagnostics?.sweepValid === true && sweepDiagnostics?.sweepDirection === action ? 10 : 0;
  const bosBonus = (
    (bosDiagnostics?.bosValid === true || bosDiagnostics?.bosCandidate === true) &&
    (bosDiagnostics?.bosDirection === action || bosDiagnostics?.bosDirection === null)
  ) ? 10 : 0;
  const strongCloseBonus = bodyRatio >= 0.45 && closeLocation >= 0.75 ? 10 : 0;
  const pullbackDistanceAtr = atr > 0
    ? Math.abs((action === 'BUY' ? prevCandle.low : prevCandle.high) - currEMA20) / atr
    : null;
  const pullbackDepthBonus = pullbackDistanceAtr !== null && pullbackDistanceAtr >= 0.15 && pullbackDistanceAtr <= 0.75 ? 5 : 0;
  const structureBonus = Math.min(20, sweepBonus + bosBonus + strongCloseBonus + pullbackDepthBonus);

  const components = {
    trendStructure: roundScore(trendStructure),
    expansion: roundScore(expansion),
    pullbackQuality: roundScore(pullbackQuality),
    confirmation: roundScore(confirmation),
    volatilityFit: roundScore(volatilityFit),
    structureBonus: roundScore(structureBonus),
  };
  const score = roundScore(clamp(Object.values(components).reduce((sum, value) => sum + value, 0), 0, 100));

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
      pullbackDirection: null,
      pullbackDistanceAtr: null,
      pullbackDistanceFromEma20Atr: null,
      pullbackDistanceFromEma50Atr: null,
      pullbackNearMiss: null,
      pullbackMissDistanceAtr: null,
      pullbackRejectReason: null,
      sweepValid: null,
      sweepDirection: null,
      sweepCandidate: null,
      sweepLookbackUsed: null,
      sweepBreakDistanceAtr: null,
      sweepWickPct: null,
      sweepBodyPct: null,
      sweepFailedReason: null,
      bosValid: null,
      bosDirection: null,
      bosCandidate: null,
      lastSwingHigh: null,
      lastSwingLow: null,
      bosBreakDistanceAtr: null,
      bosFailedReason: null,
      bodyPct: null,
      upperWickPct: null,
      lowerWickPct: null,
      swingHigh: null,
      swingLow: null,
      rrCandidate: null,
      emaTouchToleranceAtr: EMA_TOUCH_TOLERANCE_ATR,
      emaTouchDistanceAtr: null,
      emaTouchPassedByTolerance: null,
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
    const MIN_REWARD_R_MULTIPLE = 1.8;
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
    const bosCandles = Array.isArray(recentCandles) ? recentCandles.slice(0, -1) : null;
    const bosDiagnostics = detectBreakOfStructure(bosCandles, lastCandle, atr);
    const strategyDiagnostics = {
      atrRatio: roundDiagnostic(atrRatio),
      emaSpreadAtr: roundDiagnostic(emaSpreadAtr),
      ...sweepDiagnostics,
      ...bosDiagnostics,
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

    const emaExpansionMissing = !priorExpansion;

    const MIN_ATR_FOR_TRADING = 0.50; // Conservative floor for XAUUSD 5m to avoid dead markets

    if (atr < MIN_ATR_FOR_TRADING) {
      return { signal: null, debug: { ...debugBase, ...strategyDiagnostics, dbgAction: action, rejectStage: 'regime', dbgRejectReason: `Regime: ATR below minimum threshold (${MIN_ATR_FOR_TRADING.toFixed(2)})` } };
    }

    // ── Layer 2: Entry Filter ─────────────────────────────────────────────────
    const touchZone = atr * EMA20_TOUCH_ZONE_MULTIPLIER;
    const emaTouchDistance = distanceFromRangeToLevel(prevCandle.low, prevCandle.high, currEMA20);
    const emaTouchDistanceAtr = atr > 0 ? emaTouchDistance / atr : null;
    const emaTouchPassedByTolerance = emaTouchDistanceAtr !== null && emaTouchDistanceAtr <= EMA_TOUCH_TOLERANCE_ATR;
    const previousCandleTouchedZone = emaTouchPassedByTolerance;
    const pullbackDiagnostics = validatePullback(prevCandle, currEMA20, currEMA50, atr, action);
    const entryDiagnostics = {
      ...strategyDiagnostics,
      ...pullbackDiagnostics,
      emaTouchToleranceAtr: EMA_TOUCH_TOLERANCE_ATR,
      emaTouchDistanceAtr: roundDiagnostic(emaTouchDistanceAtr),
      emaTouchPassedByTolerance,
    };

    if (!previousCandleTouchedZone) {
      return { signal: null, debug: { ...debugBase, ...entryDiagnostics, dbgAction: action, rejectStage: 'entry', dbgRejectReason: `Entry: no EMA20 touch/sweep on prior candle (distance ${roundDiagnostic(emaTouchDistanceAtr)} ATR, tolerance ${EMA_TOUCH_TOLERANCE_ATR})` } };
    }

    const candleSize = lastCandle.high - lastCandle.low;
    if (candleSize === 0) return { signal: null, debug: { ...debugBase, ...entryDiagnostics, dbgAction: action, rejectStage: 'entry', dbgRejectReason: 'Entry: Candle size is 0' } };

    const bodySize = Math.abs(lastCandle.close - lastCandle.open);
    const isStrongBody = bodySize >= candleSize * 0.4;
    const closeLocation = action === 'BUY'
      ? (lastCandle.close - lastCandle.low) / candleSize
      : (lastCandle.high - lastCandle.close) / candleSize;
    const oppositeWickPct = action === 'BUY'
      ? ((lastCandle.high - Math.max(lastCandle.open, lastCandle.close)) / candleSize) * 100
      : ((Math.min(lastCandle.open, lastCandle.close) - lastCandle.low) / candleSize) * 100;
    const confirmationDisplacementAtr = action === 'BUY'
      ? (lastCandle.close - currEMA20) / atr
      : (currEMA20 - lastCandle.close) / atr;

    const confirmationValid = action === 'BUY'
      ? lastCandle.close > currEMA20 && lastCandle.close > lastCandle.open && isStrongBody && closeLocation >= 0.6
      : lastCandle.close < currEMA20 && lastCandle.close < lastCandle.open && isStrongBody && closeLocation >= 0.6;

    if (!confirmationValid) {
      return { signal: null, debug: { ...debugBase, ...entryDiagnostics, dbgAction: action, confirmationDisplacementAtr: roundDiagnostic(confirmationDisplacementAtr), oppositeWickPct: roundDiagnostic(oppositeWickPct), rejectStage: 'entry', dbgRejectReason: 'Entry: weak confirmation or no trend direction close with rejection strength' } };
    }

    if (confirmationDisplacementAtr < CONFIRMATION_DISPLACEMENT_ATR) {
      return { signal: null, debug: { ...debugBase, ...entryDiagnostics, dbgAction: action, confirmationDisplacementAtr: roundDiagnostic(confirmationDisplacementAtr), oppositeWickPct: roundDiagnostic(oppositeWickPct), rejectStage: 'entry', dbgRejectReason: `Entry: confirmation displacement ${roundDiagnostic(confirmationDisplacementAtr)} ATR below ${CONFIRMATION_DISPLACEMENT_ATR}` } };
    }

    if (oppositeWickPct > MAX_OPPOSITE_WICK_PCT) {
      return { signal: null, debug: { ...debugBase, ...entryDiagnostics, dbgAction: action, confirmationDisplacementAtr: roundDiagnostic(confirmationDisplacementAtr), oppositeWickPct: roundDiagnostic(oppositeWickPct), rejectStage: 'entry', dbgRejectReason: `Entry: opposite wick ${roundDiagnostic(oppositeWickPct)}% exceeds ${MAX_OPPOSITE_WICK_PCT}%` } };
    }

    const directionalStructureOk =
      (sweepDiagnostics.sweepValid === true && sweepDiagnostics.sweepDirection === action) ||
      (bosDiagnostics.bosValid === true && bosDiagnostics.bosDirection === action) ||
      (bodySize / candleSize >= 0.45 && closeLocation >= 0.75);
    if (!directionalStructureOk) {
      return { signal: null, debug: { ...debugBase, ...entryDiagnostics, dbgAction: action, confirmationDisplacementAtr: roundDiagnostic(confirmationDisplacementAtr), oppositeWickPct: roundDiagnostic(oppositeWickPct), rejectStage: 'entry', dbgRejectReason: 'Entry: missing directional structure confirmation (sweep, BOS, or strong close)' } };
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
      sweepDiagnostics,
      bosDiagnostics,
    });
    const trendConflictPenalty = trendConflict ? -TREND_CONFLICT_CONFIDENCE_PENALTY : 0;
    const emaExpansionPenalty = emaExpansionMissing ? -EMA_EXPANSION_CONFIDENCE_PENALTY : 0;
    const penaltyReasonParts = [
      trendConflict ? `1h trend conflict penalty applied: ${trendConflictPenalty}` : null,
      emaExpansionMissing ? `No prior EMA expansion detected leading into pullback penalty applied: ${emaExpansionPenalty}` : null,
    ].filter(Boolean);
    const setupConfidenceScore = roundScore(clamp(
      rawSetupConfidence.score + trendConflictPenalty + emaExpansionPenalty,
      0,
      100
    ));
    const setupConfidence = {
      ...rawSetupConfidence,
      score: setupConfidenceScore,
      rawScore: rawSetupConfidence.score,
      trendConflict,
      trendConflictPenalty,
      emaExpansionMissing,
      emaExpansionPenalty,
      emaExpansionHandledAs: emaExpansionMissing ? EMA_EXPANSION_HANDLED_AS : null,
      penaltyReason: penaltyReasonParts.length > 0 ? penaltyReasonParts.join('; ') : null,
      penalties: penaltyReasonParts,
      grade: gradeSetupConfidence(setupConfidenceScore),
    };

    if (trendConflict) {
      console.log(`[STRATEGY] 1h trend conflict penalty applied: ${trendConflictPenalty} (${action} vs 1h ${indicators.trend1h})`);
    }

    if (emaExpansionMissing) {
      console.log(`[STRATEGY] No prior EMA expansion handled as confidence penalty: ${emaExpansionPenalty}`);
    }

    console.log(`[STRATEGY] Final setupConfidenceScore: ${setupConfidence.score}`);

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
        emaExpansionMissing,
        emaExpansionPenalty,
        emaExpansionHandledAs: setupConfidence.emaExpansionHandledAs,
        penaltyReason: setupConfidence.penaltyReason,
        sweepValid: sweepDiagnostics.sweepValid,
        sweepDirection: sweepDiagnostics.sweepDirection,
        bosValid: bosDiagnostics.bosValid,
        bosDirection: bosDiagnostics.bosDirection,
        initialRewardRisk,
        exitPlanVersion: 'v1.6_scaleout_40_35_25',
        managementState: 'OPEN_FULL',
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
        setupConfidenceScore: setupConfidence.score,
        dbgSetupConfidenceScore: setupConfidence.score,
        dbgRawSetupConfidenceScore: rawSetupConfidence.score,
        dbgTrendConflict: trendConflict,
        dbgTrendConflictPenalty: setupConfidence.trendConflictPenalty,
        emaExpansionMissing,
        emaExpansionPenalty,
        emaExpansionHandledAs: setupConfidence.emaExpansionHandledAs,
        dbgEmaExpansionMissing: emaExpansionMissing,
        dbgEmaExpansionPenalty: emaExpansionPenalty,
        dbgEmaExpansionHandledAs: setupConfidence.emaExpansionHandledAs,
        penaltyReason: setupConfidence.penaltyReason,
        dbgPenaltyReason: setupConfidence.penaltyReason,
        dbgInitialRewardRisk: initialRewardRisk,
        confirmationDisplacementAtr: roundDiagnostic(confirmationDisplacementAtr),
        oppositeWickPct: roundDiagnostic(oppositeWickPct),
      },
    };
  } catch (err) {
    console.error('generateSignal error:', err.message);
    return { signal: null, debug: { dbgRejectReason: `exception: ${err.message}` } };
  }
}
