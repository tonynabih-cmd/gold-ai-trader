// tests/test_strategy.mjs — Unit tests for lib/strategy.js
// Run: node tests/test_strategy.mjs

import {
  detectBreakOfStructure,
  detectLiquiditySweep,
  EMA_TOUCH_TOLERANCE_ATR,
  findLastFractalSwings,
  generateSignal,
  validatePullback,
} from '../lib/strategy.js';
import { checkRisk as checkRiskImpl } from '../lib/risk.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${message}`);
  }
}

function section(name) {
  console.log(`\n── ${name} ──`);
}

const ALLOWED_NOW = new Date('2026-05-04T12:30:00.000Z');

function checkRisk(signal, botState, indicators, options = {}) {
  return checkRiskImpl(signal, botState, indicators, { now: ALLOWED_NOW, ...options });
}

function make1mCandles(n = 3, basePrice = 2000) {
  return Array.from({ length: n }, (_, i) => ({
    time: Date.now() - (n - i) * 60000,
    open: basePrice + i * 0.05,
    high: basePrice + i * 0.10 + 0.10,
    low: basePrice + i * 0.05 - 0.10,
    close: basePrice + i * 0.08,
  }));
}

function makeIndicators(overrides = {}) {
  const now = Date.now();
  const base = {
    currEMA20: 2000,
    currEMA50: 1997,
    ema20_1h: 2005,
    ema50_1h: 2000,
    trend1h: 'UP',
    ema20arr: [1994, 1995, 1996, 1997, 1998.5, 2000],
    ema50arr: [1992, 1992.8, 1993.6, 1994.5, 1995.5, 1997],
    atr: 5.0,
    atrAverage: 4.5,
    prevCandle: {
      time: now - 5 * 60 * 1000,
      open: 2001.0,
      high: 2001.5,
      low: 1999.3,
      close: 2000.2,
    },
    lastCandle: {
      time: now,
      open: 2000.0,
      high: 2002.2,
      low: 1999.5,
      close: 2001.2,
    },
    trendWindowStartTime: now - 30 * 60 * 1000,
    recentOutcomes: [],
    lastOrderTimestamp: now - 6 * 60 * 60 * 1000,
  };
  return { ...base, ...overrides };
}

function makeHighQualityIndicators(overrides = {}) {
  const now = Date.now();
  const base = {
    currEMA20: 2000,
    currEMA50: 1996,
    ema20_1h: 1995,
    ema50_1h: 2000,
    trend1h: 'DOWN',
    ema20arr: [1990, 1992, 1994, 1995.5, 1998, 2000],
    ema50arr: [1988, 1989.5, 1991, 1992.5, 1994, 1996],
    atr: 5.0,
    atrAverage: 5.0,
    prevCandle: {
      time: now - 5 * 60 * 1000,
      open: 2000.0,
      high: 2000.5,
      low: 1999.5,
      close: 2000.0,
    },
    lastCandle: {
      time: now,
      open: 1999.0,
      high: 2004.0,
      low: 1999.0,
      close: 2003.5,
    },
    trendWindowStartTime: now - 30 * 60 * 1000,
    recentOutcomes: [],
    lastOrderTimestamp: now - 6 * 60 * 60 * 1000,
  };
  return { ...base, ...overrides };
}

function makeBotState(overrides = {}) {
  return {
    botEnabled: true,
    stateIntegrityOk: true,
    criticalFailure: false,
    riskDataFresh: true,
    lastRiskSyncAt: Date.now(),
    balance: 1000,
    equity: 1000,
    availableMargin: 800,
    peakBalance: 1000,
    dailyLoss: 0,
    dailyTrades: 0,
    openTrades: [],
    recentTradeIds: [],
    recentOrderKeys: [],
    recentOutcomes: [],
    ...overrides,
  };
}

function makePriorSweepCandles({ swingLow = 100, swingHigh = 110 } = {}) {
  return Array.from({ length: 12 }, (_, i) => ({
    time: Date.now() - (13 - i) * 5 * 60 * 1000,
    open: 105,
    high: i === 3 ? swingHigh : 108,
    low: i === 4 ? swingLow : 102,
    close: 105,
  }));
}

function makeBosCandles() {
  return [
    { time: 1, open: 100, high: 101, low: 98, close: 100 },
    { time: 2, open: 100, high: 103, low: 97, close: 101 },
    { time: 3, open: 101, high: 106, low: 96, close: 104 },
    { time: 4, open: 104, high: 102, low: 95, close: 97 },
    { time: 5, open: 97, high: 101, low: 94, close: 98 },
    { time: 6, open: 98, high: 103, low: 97, close: 101 },
    { time: 7, open: 101, high: 102, low: 98, close: 100 },
  ];
}

process.env.BOT_ENABLED = 'true';
process.env.MAX_SPREAD = '0.5';

section('Input guards');
{
  const result = generateSignal(null, []);
  assert(result.signal === null, 'null indicators → signal null');

  const result3 = generateSignal(makeIndicators({ currEMA20: NaN }), make1mCandles());
  assert(result3.signal === null, 'invalid indicator values → signal null');
}

section('Layer 1 volatility stability guard');
{
  const lowAtr = generateSignal(makeIndicators({ atr: 0.4, atrAverage: 4.0 }), make1mCandles());
  assert(lowAtr.signal === null, `dead market ATR is blocked (reason: ${lowAtr.debug?.dbgRejectReason})`);
  assert(lowAtr.debug?.dbgRejectReason?.includes('ATR below minimum threshold'), 'low ATR rejection comes from current minimum threshold');

  const highAtr = generateSignal(makeIndicators({ atr: 12.0, atrAverage: 4.5 }), make1mCandles());
  assert(highAtr.signal !== null, `high ATR is not strategy-gated by current production policy (reason: ${highAtr.debug?.dbgRejectReason})`);
}

section('Layer 2 BUY pullback with 2-step confirmation');
{
  const indicators = makeIndicators({
    currEMA20: 2000,
    currEMA50: 1996,
    ema20_1h: 2005,
    ema50_1h: 2000,
    trend1h: 'UP',
    ema20arr: [1990, 1992, 1994, 1995.5, 1998, 2000],
    ema50arr: [1988, 1989.5, 1991, 1992.5, 1994, 1996],
    prevCandle: {
      time: Date.now() - 5 * 60 * 1000,
      open: 2001.4,
      high: 2001.8,
      low: 1999.2,
      close: 2000.1,
    },
    lastCandle: {
      time: Date.now(),
      open: 1999.8,
      high: 2002.2,
      low: 1999.0,
      close: 2001.2,
    },
  });

  const result = generateSignal(indicators, make1mCandles());
  assert(result.signal !== null, `BUY pullback passes after touch + confirm (reason: ${result.debug?.dbgRejectReason})`);
  if (result.signal) {
    assert(result.signal.action === 'BUY', `Signal direction is BUY (got ${result.signal.action})`);
    assert(result.signal.entryType === 'pullback', `Entry type remains pullback (got ${result.signal.entryType})`);
  }
}

section('Diagnostic pullback validation');
{
  const validBuy = validatePullback({ low: 1999.2, high: 2001.8, close: 2000.1 }, 2000, 1996, 5, 'BUY');
  assert(validBuy.pullbackValid === true, 'Valid BUY pullback inside EMA zone');
  assert(validBuy.pullbackDirection === 'BUY', `Valid BUY direction logged (got ${validBuy.pullbackDirection})`);
  assert(validBuy.pullbackDistanceAtr === 0.16, `Valid BUY distance logged in ATR (got ${validBuy.pullbackDistanceAtr})`);
  assert(validBuy.pullbackRejectReason === null, 'Valid BUY has null reject reason');

  const shallowBuy = validatePullback({ low: 2002.3, high: 2003, close: 2002.6 }, 2000, 1996, 5, 'BUY');
  assert(shallowBuy.pullbackValid === false, 'Invalid BUY pullback too shallow');
  assert(shallowBuy.pullbackRejectReason.includes('low did not reach EMA20 zone'), `Shallow BUY reject reason is clear (got ${shallowBuy.pullbackRejectReason})`);
  assert(shallowBuy.pullbackNearMiss === false, 'Clearly shallow BUY pullback is not a near miss');

  const nearMissBuy = validatePullback({ low: 2001.3, high: 2002, close: 2001.6 }, 2000, 1996, 5, 'BUY');
  assert(nearMissBuy.pullbackNearMiss === true, 'BUY pullback near miss is detected near EMA20 zone');
  assert(nearMissBuy.pullbackMissDistanceAtr === 0.01, `BUY near-miss distance logs in ATR (got ${nearMissBuy.pullbackMissDistanceAtr})`);

  const deepBuy = validatePullback({ low: 1994.0, high: 1998, close: 1997.0 }, 2000, 1996, 5, 'BUY');
  assert(deepBuy.pullbackValid === false, 'Invalid BUY pullback too deep below EMA50');
  assert(deepBuy.pullbackRejectReason.includes('low extended below EMA50 zone'), `Deep BUY reject reason is clear (got ${deepBuy.pullbackRejectReason})`);

  const validSell = validatePullback({ low: 1993.7, high: 1995.6, close: 1994.9 }, 1995, 1999, 5, 'SELL');
  assert(validSell.pullbackValid === true, 'Valid SELL pullback inside EMA zone');
  assert(validSell.pullbackDirection === 'SELL', `Valid SELL direction logged (got ${validSell.pullbackDirection})`);
  assert(validSell.pullbackDistanceAtr === 0.12, `Valid SELL distance logged in ATR (got ${validSell.pullbackDistanceAtr})`);
  assert(validSell.pullbackRejectReason === null, 'Valid SELL has null reject reason');

  const shallowSell = validatePullback({ low: 1991, high: 1993.6, close: 1992.8 }, 1995, 1999, 5, 'SELL');
  assert(shallowSell.pullbackValid === false, 'Invalid SELL pullback too shallow');
  assert(shallowSell.pullbackRejectReason.includes('high did not reach EMA20 zone'), `Shallow SELL reject reason is clear (got ${shallowSell.pullbackRejectReason})`);

  const deepSell = validatePullback({ low: 1998, high: 2001.0, close: 1998.8 }, 1995, 1999, 5, 'SELL');
  assert(deepSell.pullbackValid === false, 'Invalid SELL pullback too deep above EMA50');
  assert(deepSell.pullbackRejectReason.includes('high extended above EMA50 zone'), `Deep SELL reject reason is clear (got ${deepSell.pullbackRejectReason})`);

  const missing = validatePullback({ low: 1999, high: 2001, close: 2000 }, null, 1996, 5, 'BUY');
  assert(missing.pullbackValid === null, 'Missing ATR/EMA returns null pullbackValid');
  assert(missing.pullbackDirection === null, 'Missing ATR/EMA returns null pullbackDirection');
  assert(missing.pullbackDistanceAtr === null, 'Missing ATR/EMA returns null pullbackDistanceAtr');
  assert(missing.pullbackRejectReason.includes('missing ATR, EMA, or candle values'), `Missing ATR/EMA reject reason is safe (got ${missing.pullbackRejectReason})`);
}

section('1h trend conflict applies confidence penalty instead of hard reject');
{
  const aligned = generateSignal(makeHighQualityIndicators({ trend1h: 'UP' }), make1mCandles());
  const conflicted = generateSignal(makeHighQualityIndicators({ trend1h: 'DOWN' }), make1mCandles());

  assert(aligned.signal !== null, `Aligned high-quality setup produces signal (reason: ${aligned.debug?.dbgRejectReason})`);
  assert(conflicted.signal !== null, `1h conflict no longer causes immediate SKIP (reason: ${conflicted.debug?.dbgRejectReason})`);

  if (aligned.signal && conflicted.signal) {
    assert(
      conflicted.signal.setupConfidenceScore === aligned.signal.setupConfidenceScore - 5,
      `Conflicted setupConfidenceScore is reduced by 5 (${aligned.signal.setupConfidenceScore} -> ${conflicted.signal.setupConfidenceScore})`
    );
    assert(
      conflicted.signal.setupConfidence?.penalties?.includes('1h trend conflict penalty applied: -5'),
      'Penalty is logged in setupConfidence telemetry'
    );
    assert(conflicted.debug?.dbgTrendConflictPenalty === -5, 'Penalty is exposed in debug telemetry');
  }
}

section('1h-conflicted setups still pass through normal risk gates');
{
  const standardQuality = generateSignal(makeIndicators({ trend1h: 'DOWN' }), make1mCandles());
  assert(standardQuality.signal !== null, `Conflicted setup reaches risk gate (reason: ${standardQuality.debug?.dbgRejectReason})`);
  if (standardQuality.signal) {
    const standardRisk = checkRisk(
      standardQuality.signal,
      makeBotState(),
      {
        atr: standardQuality.signal.atr,
        atrAverage: 4.5,
        spread: 0.30,
        currEMA20: 2000,
        currEMA50: 1997,
        trend1h: 'DOWN',
      }
    );
    assert(standardQuality.signal.setupConfidenceScore >= 55, `Conflicted setup remains above the 55 confidence gate (got: ${standardQuality.signal.setupConfidenceScore})`);
    assert(standardRisk === 'APPROVED', `Conflicted setup passes when final confidence and RR pass (got: ${standardRisk})`);
  }

  const highQuality = generateSignal(makeHighQualityIndicators({ trend1h: 'DOWN' }), make1mCandles());
  assert(highQuality.signal !== null, `High-quality conflicted setup reaches risk gate (reason: ${highQuality.debug?.dbgRejectReason})`);
  if (highQuality.signal) {
    const highRisk = checkRisk(
      highQuality.signal,
      makeBotState(),
      {
        atr: highQuality.signal.atr,
        atrAverage: 5.0,
        spread: 0.30,
        currEMA20: 2000,
        currEMA50: 1996,
        trend1h: 'DOWN',
      }
    );
    assert(highRisk === 'APPROVED', `High-quality conflicted setup can pass if score remains above threshold (got: ${highRisk})`);
  }
}

section('Missing prior EMA expansion is confidence penalty, not hard reject');
{
  const result = generateSignal(
    makeHighQualityIndicators({
      trend1h: 'UP',
      ema20arr: [2000, 2000, 2000, 2000, 2000, 2000],
      ema50arr: [1996, 1996, 1996, 1996, 1996, 1996],
    }),
    make1mCandles()
  );

  assert(result.signal !== null, `Missing prior EMA expansion still returns a setup (reason: ${result.debug?.dbgRejectReason})`);
  assert(result.debug?.dbgRejectReason === null, 'Missing prior EMA expansion is not logged as a hard rejection');
  assert(result.debug?.rejectStage === null, 'Missing prior EMA expansion does not set rejectStage=regime');

  if (result.signal) {
    assert(result.signal.emaExpansionMissing === true, 'emaExpansionMissing is logged on signal');
    assert(result.signal.emaExpansionPenalty === -10, `emaExpansionPenalty is -10 (got ${result.signal.emaExpansionPenalty})`);
    assert(result.signal.emaExpansionHandledAs === 'CONFIDENCE_PENALTY', `emaExpansionHandledAs is CONFIDENCE_PENALTY (got ${result.signal.emaExpansionHandledAs})`);
    assert(result.signal.setupConfidence?.penalties?.some(reason => reason.includes('No prior EMA expansion')), 'EMA expansion penalty reason is retained');
    assert(
      Number((result.signal.setupConfidence.rawScore - result.signal.setupConfidenceScore).toFixed(2)) === 10,
      `Final confidence reflects only the -10 EMA expansion penalty (${result.signal.setupConfidence.rawScore} -> ${result.signal.setupConfidenceScore})`
    );

    const risk = checkRisk(
      result.signal,
      makeBotState(),
      {
        atr: result.signal.atr,
        atrAverage: 5.0,
        spread: 0.30,
        currEMA20: 2000,
        currEMA50: 1996,
        trend1h: 'UP',
      }
    );
    assert(risk === 'APPROVED', `Missing EMA expansion setup can pass if final confidence and RR pass (got: ${risk})`);
  }
}

section('Layer 2 SELL pullback with 2-step confirmation');
{
  const indicators = makeIndicators({
    currEMA20: 1995,
    currEMA50: 1999,
    ema20_1h: 1995,
    ema50_1h: 2000,
    trend1h: 'DOWN',
    ema20arr: [2004, 2002.5, 2001, 1999, 1997, 1995],
    ema50arr: [2006, 2005, 2004, 2003, 2001, 1999],
    prevCandle: {
      time: Date.now() - 5 * 60 * 1000,
      open: 1994.8,
      high: 1995.6,
      low: 1993.7,
      close: 1994.9,
    },
    lastCandle: {
      time: Date.now(),
      open: 1995.2,
      high: 1995.3,
      low: 1992.8,
      close: 1993.6,
    },
  });

  const result = generateSignal(indicators, make1mCandles());
  assert(result.signal !== null, `SELL pullback passes after touch + confirm (reason: ${result.debug?.dbgRejectReason})`);
  if (result.signal) {
    assert(result.signal.action === 'SELL', `Signal direction is SELL (got ${result.signal.action})`);
    assert(result.signal.entryType === 'pullback', `Entry type remains pullback (got ${result.signal.entryType})`);
  }
}

section('EMA20 touch tolerance');
{
  assert(EMA_TOUCH_TOLERANCE_ATR === 0.15, `EMA touch tolerance is 0.15 ATR (got ${EMA_TOUCH_TOLERANCE_ATR})`);

  const boundary = generateSignal(
    makeIndicators({
      prevCandle: {
        time: Date.now() - 5 * 60 * 1000,
        open: 2001.4,
        high: 2001.8,
        low: 2000.75,
        close: 2001.0,
      },
    }),
    make1mCandles()
  );
  assert(boundary.signal !== null, `EMA touch tolerance passes at <= 0.15 ATR (reason: ${boundary.debug?.dbgRejectReason})`);
  assert(boundary.debug?.emaTouchToleranceAtr === 0.15, `emaTouchToleranceAtr logs 0.15 (got ${boundary.debug?.emaTouchToleranceAtr})`);
  assert(boundary.debug?.emaTouchDistanceAtr === 0.15, `emaTouchDistanceAtr logs boundary distance (got ${boundary.debug?.emaTouchDistanceAtr})`);
  assert(boundary.debug?.emaTouchPassedByTolerance === true, 'emaTouchPassedByTolerance logs true at boundary');

  const aboveTolerance = generateSignal(
    makeIndicators({
      prevCandle: {
        time: Date.now() - 5 * 60 * 1000,
        open: 2001.4,
        high: 2001.8,
        low: 2000.8,
        close: 2001.0,
      },
    }),
    make1mCandles()
  );
  assert(aboveTolerance.signal === null, `EMA touch tolerance fails above 0.15 ATR (reason: ${aboveTolerance.debug?.dbgRejectReason})`);
  assert(aboveTolerance.debug?.emaTouchDistanceAtr === 0.16, `emaTouchDistanceAtr logs above-tolerance distance (got ${aboveTolerance.debug?.emaTouchDistanceAtr})`);
  assert(aboveTolerance.debug?.emaTouchPassedByTolerance === false, 'emaTouchPassedByTolerance logs false above tolerance');
}

section('Layer 2 rejects when prior candle does not touch EMA20 zone');
{
  const result = generateSignal(
    makeIndicators({
      prevCandle: {
        time: Date.now() - 5 * 60 * 1000,
        open: 2004.0,
        high: 2005.0,
        low: 2003.6,
        close: 2004.5,
      },
    }),
    make1mCandles()
  );

  assert(result.signal === null, `No touch/sweep is blocked (reason: ${result.debug?.dbgRejectReason})`);
  assert(result.debug?.dbgRejectReason?.includes('no EMA20 touch/sweep'), 'rejection reason names the missing pullback interaction');
}

section('Layer 2 rejects when confirmation candle fails close-vs-EMA20 rule');
{
  const result = generateSignal(
    makeIndicators({
      lastCandle: {
        time: Date.now(),
        open: 2000.0,
        high: 2001.0,
        low: 1998.9,
        close: 1999.8,
      },
    }),
    make1mCandles()
  );

  assert(result.signal === null, `Failed confirmation close is blocked (reason: ${result.debug?.dbgRejectReason})`);
  assert(result.debug?.dbgRejectReason?.includes('weak confirmation'), 'current confirmation rule is enforced explicitly');
}

section('Liquidity sweep telemetry');
{
  const prior = makePriorSweepCandles();

  const validBuy = detectLiquiditySweep(prior, {
    time: Date.now(),
    open: 103,
    high: 108,
    low: 98,
    close: 106,
  }, 10);
  assert(validBuy.sweepValid === true, 'Valid BUY sweep detected');
  assert(validBuy.sweepDirection === 'BUY', `BUY sweep direction logged (got ${validBuy.sweepDirection})`);
  assert(validBuy.swingLow === 100, `BUY sweep swingLow logged (got ${validBuy.swingLow})`);
  assert(validBuy.bodyPct === 30, `BUY sweep bodyPct logged (got ${validBuy.bodyPct})`);
  assert(validBuy.lowerWickPct === 50, `BUY sweep lowerWickPct logged (got ${validBuy.lowerWickPct})`);

  const noReclaimBuy = detectLiquiditySweep(prior, {
    time: Date.now(),
    open: 103,
    high: 108,
    low: 98,
    close: 99.5,
  }, 10);
  assert(noReclaimBuy.sweepValid === false, 'Invalid BUY sweep when close does not reclaim swingLow');
  assert(noReclaimBuy.sweepCandidate === true, 'Failed BUY sweep still logs as candidate');
  assert(noReclaimBuy.sweepBreakDistanceAtr === 0.2, `Failed BUY sweep break distance logs in ATR (got ${noReclaimBuy.sweepBreakDistanceAtr})`);
  assert(noReclaimBuy.sweepFailedReason.includes('reclaim'), `Failed BUY sweep reason is logged (got ${noReclaimBuy.sweepFailedReason})`);

  const smallLowerWick = detectLiquiditySweep(prior, {
    time: Date.now(),
    open: 99,
    high: 108,
    low: 98,
    close: 104,
  }, 10);
  assert(smallLowerWick.sweepValid === false, 'Invalid BUY sweep when lower wick is too small');

  const validSell = detectLiquiditySweep(prior, {
    time: Date.now(),
    open: 107,
    high: 112,
    low: 102,
    close: 104,
  }, 10);
  assert(validSell.sweepValid === true, 'Valid SELL sweep detected');
  assert(validSell.sweepDirection === 'SELL', `SELL sweep direction logged (got ${validSell.sweepDirection})`);
  assert(validSell.swingHigh === 110, `SELL sweep swingHigh logged (got ${validSell.swingHigh})`);
  assert(validSell.upperWickPct === 50, `SELL sweep upperWickPct logged (got ${validSell.upperWickPct})`);

  const noReclaimSell = detectLiquiditySweep(prior, {
    time: Date.now(),
    open: 107,
    high: 112,
    low: 102,
    close: 110.5,
  }, 10);
  assert(noReclaimSell.sweepValid === false, 'Invalid SELL sweep when close does not reclaim below swingHigh');

  const smallUpperWick = detectLiquiditySweep(prior, {
    time: Date.now(),
    open: 111,
    high: 112,
    low: 102,
    close: 106,
  }, 10);
  assert(smallUpperWick.sweepValid === false, 'Invalid SELL sweep when upper wick is too small');

  const tooSmallRange = detectLiquiditySweep(prior, {
    time: Date.now(),
    open: 100.3,
    high: 102.5,
    low: 98.5,
    close: 101.5,
  }, 10);
  assert(tooSmallRange.sweepValid === false, 'Reject sweep when range is too small');

  const tooLargeRange = detectLiquiditySweep(prior, {
    time: Date.now(),
    open: 106.5,
    high: 118,
    low: 97,
    close: 112.8,
  }, 10);
  assert(tooLargeRange.sweepValid === false, 'Reject sweep when range is too large');

  const missing = detectLiquiditySweep(prior.slice(0, 3), {
    time: Date.now(),
    open: 103,
    high: 108,
    low: 98,
    close: 106,
  }, 10);
  assert(missing.sweepValid === null, 'Missing candles handled safely');
  assert(missing.swingHigh === null && missing.swingLow === null, 'Missing candle swings log null');
}

section('Break of structure telemetry');
{
  const candles = makeBosCandles();
  const swings = findLastFractalSwings(candles);
  assert(swings.lastSwingHigh === 106, `Valid swing high detected (got ${swings.lastSwingHigh})`);
  assert(swings.lastSwingLow === 94, `Valid swing low detected (got ${swings.lastSwingLow})`);

  const buyBos = detectBreakOfStructure(candles, {
    time: 8,
    open: 104,
    high: 108,
    low: 103,
    close: 107,
  }, 10);
  assert(buyBos.bosValid === true, 'BUY BOS detected');
  assert(buyBos.bosDirection === 'BUY', `BUY BOS direction logged (got ${buyBos.bosDirection})`);
  assert(buyBos.lastSwingHigh === 106, `BUY BOS logs last swing high (got ${buyBos.lastSwingHigh})`);
  assert(buyBos.bosBreakDistanceAtr === 0.05, `BUY BOS break distance logs in ATR (got ${buyBos.bosBreakDistanceAtr})`);

  const sellBos = detectBreakOfStructure(candles, {
    time: 8,
    open: 96,
    high: 97,
    low: 92,
    close: 93,
  }, 10);
  assert(sellBos.bosValid === true, 'SELL BOS detected');
  assert(sellBos.bosDirection === 'SELL', `SELL BOS direction logged (got ${sellBos.bosDirection})`);
  assert(sellBos.lastSwingLow === 94, `SELL BOS logs last swing low (got ${sellBos.lastSwingLow})`);
  assert(sellBos.bosBreakDistanceAtr === 0.05, `SELL BOS break distance logs in ATR (got ${sellBos.bosBreakDistanceAtr})`);

  const noBuyBreak = detectBreakOfStructure(candles, {
    time: 8,
    open: 104,
    high: 107,
    low: 103,
    close: 106.4,
  }, 10);
  assert(noBuyBreak.bosValid === false, 'Reject BUY BOS if close does not break swing high');
  assert(noBuyBreak.bosDirection === null, 'Rejected BUY BOS logs null direction');

  const noSellBreak = detectBreakOfStructure(candles, {
    time: 8,
    open: 96,
    high: 97,
    low: 93,
    close: 93.6,
  }, 10);
  assert(noSellBreak.bosValid === false, 'Reject SELL BOS if close does not break swing low');
  assert(noSellBreak.bosDirection === null, 'Rejected SELL BOS logs null direction');

  const weakBody = detectBreakOfStructure(candles, {
    time: 8,
    open: 106.8,
    high: 110,
    low: 100,
    close: 107.2,
  }, 10);
  assert(weakBody.bosValid === false, 'Reject BOS if bodyPct < 40');
  assert(weakBody.bosCandidate === true, 'Weak-body BOS still logs as candidate');
  assert(weakBody.bosBreakDistanceAtr === 0.07, `Weak-body BOS candidate logs break distance (got ${weakBody.bosBreakDistanceAtr})`);
  assert(weakBody.bosFailedReason.includes('body'), `Weak-body BOS failure reason is logged (got ${weakBody.bosFailedReason})`);

  const missing = detectBreakOfStructure(candles.slice(0, 4), {
    time: 8,
    open: 104,
    high: 108,
    low: 103,
    close: 107,
  }, 10);
  assert(missing.bosValid === null, 'Insufficient BOS candles handled safely');
  assert(missing.lastSwingHigh === null && missing.lastSwingLow === null, 'Insufficient BOS levels log null');
}

section('Signal structure validation');
{
  const baseline = generateSignal(makeIndicators(), make1mCandles());
  const result = generateSignal(makeIndicators(), make1mCandles());
  assert(result.signal !== null, 'baseline setup produces a signal');

  if (result.signal) {
    const s = result.signal;
    assert(typeof s.id === 'string', 'Signal has id');
    assert(typeof s.entryPrice === 'number', 'Signal has entryPrice');
    assert(typeof s.stopLoss === 'number', 'Signal has stopLoss');
    assert(typeof s.takeProfit === 'number', 'Signal has takeProfit');
    assert(s.takeProfit > s.entryPrice, 'BUY take profit is above entry');
    assert(s.stopLoss < s.entryPrice, 'BUY stop loss is below entry');
  }
  if (baseline.signal && result.signal) {
    assert(result.signal.action === baseline.signal.action, 'Sweep telemetry does not change action');
    assert(result.signal.entryPrice === baseline.signal.entryPrice, 'Sweep telemetry does not change entry');
    assert(result.signal.stopLoss === baseline.signal.stopLoss, 'Sweep telemetry does not change stop');
    assert(result.signal.takeProfit === baseline.signal.takeProfit, 'Sweep telemetry does not change target');
  }

  const noBos = generateSignal(makeIndicators({
    recentCandles5m: [
      { time: 1, open: 2000, high: 2001, low: 1998, close: 2000 },
      { time: 2, open: 2000, high: 2003, low: 1997, close: 2001 },
      { time: 3, open: 2001, high: 2006, low: 1996, close: 2004 },
      { time: 4, open: 2004, high: 2002, low: 1995, close: 1997 },
      { time: 5, open: 1997, high: 2001, low: 1994, close: 1998 },
      { time: 6, open: 1998, high: 2003, low: 1997, close: 2001 },
      { time: 7, open: 2001, high: 2002, low: 1998, close: 2000 },
      {
        time: Date.now(),
        open: 2000.0,
        high: 2002.2,
        low: 1999.5,
        close: 2001.2,
      },
    ],
  }), make1mCandles());
  assert(noBos.signal !== null, `bosValid=false does not block signal generation (reason: ${noBos.debug?.dbgRejectReason})`);
  assert(noBos.debug?.bosValid === false, 'bosValid=false is logged without blocking');
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(60)}\n`);

if (failed > 0) process.exit(1);
