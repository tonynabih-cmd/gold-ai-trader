// tests/test_logger.mjs — Unit tests for passive v2 diagnostic log fields.

import { buildKillSwitchDiagnostics, buildV2Diagnostics, CYCLE_LOG_RETENTION_LIMIT, LOGGER_EXPORT_FIELDS, normalizeLogDiagnostics, updateBlockedSetupTracking, V2_DIAGNOSTIC_FIELDS } from '../lib/logger.js';
import { generateSignal } from '../lib/strategy.js';

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

function makeIndicators(overrides = {}) {
  const now = 1713184500000;
  const base = {
    currEMA20: 2000,
    currEMA50: 1996,
    ema20_1h: 2005,
    ema50_1h: 2000,
    trend1h: 'UP',
    marketRegime: 'NORMAL',
    ema20arr: [1990, 1992, 1994, 1995.5, 1998, 2000],
    ema50arr: [1988, 1989.5, 1991, 1992.5, 1994, 1996],
    atr: 5.0,
    atrAverage: 4.5,
    spread: 0.3,
    support: 1990,
    resistance: 2010,
    prevCandle: {
      time: now - 5 * 60 * 1000,
      open: 2001.4,
      high: 2001.8,
      low: 1999.2,
      close: 2000.1,
    },
    lastCandle: {
      time: now,
      open: 1999.8,
      high: 2002.0,
      low: 1999.0,
      close: 2001.8,
    },
  };
  return { ...base, ...overrides };
}

function assertNoUndefinedFields(record, fields, label) {
  for (const field of fields) {
    assert(Object.prototype.hasOwnProperty.call(record, field), `${label} includes ${field}`);
    assert(record[field] !== undefined, `${label}.${field} is not undefined`);
  }
}

section('Logger v2 diagnostic field coverage');
assert(CYCLE_LOG_RETENTION_LIMIT >= 5000, `cycle log retention keeps at least 5000 logs (got ${CYCLE_LOG_RETENTION_LIMIT})`);
{
  const indicators = makeIndicators();
  const generated = generateSignal(indicators, []);
  const diagnostics = buildV2Diagnostics(
    { signal: generated.signal, indicators, signalDebug: generated.debug, reason: null },
    indicators.marketRegime,
    new Date('2026-05-04T10:00:00.000Z')
  );

  assertNoUndefinedFields(diagnostics, V2_DIAGNOSTIC_FIELDS, 'diagnostics');
  assert(diagnostics.sessionName === 'LONDON_OPEN', `sessionName is derived passively (got ${diagnostics.sessionName})`);
  assert(diagnostics.isAllowedSession === true, 'allowed session is marked allowed');
  assert(diagnostics.sessionRejectReason === null, 'allowed session has null reject reason');
  assert(diagnostics.regime === 'NORMAL', 'regime mirrors marketRegime telemetry');
  assert(diagnostics.regimeRejectReason === null, 'allowed regime has null reject reason');
  assert(diagnostics.pullbackValid === true, 'pullbackValid is populated from strategy debug');
  assert(diagnostics.pullbackDirection === 'BUY', `pullbackDirection is populated from strategy debug (got ${diagnostics.pullbackDirection})`);
  assert(diagnostics.pullbackDistanceAtr === 0.16, `pullbackDistanceAtr is populated from strategy debug (got ${diagnostics.pullbackDistanceAtr})`);
  assert(diagnostics.pullbackRejectReason === null, 'valid pullbackRejectReason logs null');
  assert(diagnostics.sweepValid === null, 'missing sweep candles log null');
  assert(diagnostics.sweepDirection === null, 'missing sweep direction logs null');
  assert(diagnostics.bosValid === null, 'unsupported BOS telemetry is null');
  assert(diagnostics.bosDirection === null, 'missing BOS direction logs null');
  assert(diagnostics.lastSwingHigh === null, 'missing BOS swing high logs null');
  assert(diagnostics.lastSwingLow === null, 'missing BOS swing low logs null');
  assert(diagnostics.bosBreakDistanceAtr === null, 'missing BOS distance logs null');
  assert(diagnostics.rrCandidate === 1.8, `rrCandidate mirrors setup RR (got ${diagnostics.rrCandidate})`);
  assert(diagnostics.rrThresholdUsed === 1.8, `rrThresholdUsed logs v2 threshold (got ${diagnostics.rrThresholdUsed})`);
  assert(diagnostics.confidenceThresholdUsed === 55, `confidenceThresholdUsed logs v2 threshold (got ${diagnostics.confidenceThresholdUsed})`);
  assert(diagnostics.rrPass === true, 'rrPass logs true when RR meets v2 threshold');
  assert(diagnostics.confidencePass === true, 'confidencePass logs true when setup confidence meets v2 threshold');
  assert(diagnostics.trendConflict === false, 'trendConflict logs false for aligned setup');
  assert(diagnostics.trendConflictPenalty === 0, `trendConflictPenalty logs zero when absent (got ${diagnostics.trendConflictPenalty})`);
  assert(diagnostics.emaExpansionMissing === false, 'emaExpansionMissing logs false when prior expansion exists');
  assert(diagnostics.emaExpansionPenalty === 0, `emaExpansionPenalty logs zero when prior expansion exists (got ${diagnostics.emaExpansionPenalty})`);
  assert(diagnostics.penaltyReason === null, 'penaltyReason logs null when no confidence penalty applies');
  assert(diagnostics.rejectStage === null, 'accepted setup has null rejectStage');
}

section('Null-safe diagnostics');
{
  const diagnostics = buildV2Diagnostics(
    { signal: null, indicators: null, signalDebug: null, reason: 'SKIP: No signal generated this cycle' },
    null,
    new Date('2026-05-04T02:00:00.000Z')
  );

  assertNoUndefinedFields(diagnostics, V2_DIAGNOSTIC_FIELDS, 'null diagnostics');
  assert(diagnostics.sessionName === 'OUTSIDE_SESSION', `off-session is labeled (got ${diagnostics.sessionName})`);
  assert(diagnostics.isAllowedSession === false, 'off-session is marked blocked');
  assert(diagnostics.sessionRejectReason === 'SKIP: Outside allowed trading session', 'off-session reject reason is clear');
  assert(diagnostics.regime === null, 'missing regime logs null');
  assert(diagnostics.atrRatio === null, 'missing atrRatio logs null');
  assert(diagnostics.regimeRejectReason === null, 'missing regimeRejectReason logs null');
  assert(diagnostics.pullbackValid === null, 'missing pullbackValid logs null');
  assert(diagnostics.pullbackDirection === null, 'missing pullbackDirection logs null');
  assert(diagnostics.pullbackDistanceAtr === null, 'missing pullbackDistanceAtr logs null');
  assert(diagnostics.pullbackRejectReason === null, 'missing pullbackRejectReason logs null');
  assert(diagnostics.bosValid === null, 'missing bosValid logs null');
  assert(diagnostics.bosDirection === null, 'missing bosDirection logs null');
  assert(diagnostics.lastSwingHigh === null, 'missing lastSwingHigh logs null');
  assert(diagnostics.lastSwingLow === null, 'missing lastSwingLow logs null');
  assert(diagnostics.bosBreakDistanceAtr === null, 'missing bosBreakDistanceAtr logs null');
  assert(diagnostics.rrThresholdUsed === 1.8, `missing signal still logs rrThresholdUsed (got ${diagnostics.rrThresholdUsed})`);
  assert(diagnostics.confidenceThresholdUsed === 55, `missing signal still logs confidenceThresholdUsed (got ${diagnostics.confidenceThresholdUsed})`);
  assert(diagnostics.rrPass === null, 'missing RR logs null rrPass');
  assert(diagnostics.confidencePass === null, 'missing confidence logs null confidencePass');
  assert(diagnostics.strategyVersion === 'v1.6-exit-first', 'missing signal falls back to active strategyVersion');
}

section('RR and confidence calibration logging');
{
  const diagnostics = buildV2Diagnostics(
    {
      signal: {
        initialRewardRisk: 1.99,
        setupConfidenceScore: 54,
        setupQuality: {
          initialRewardRisk: 1.99,
          setupConfidenceScore: 54,
          rewardOk: false,
          confidenceOk: false,
          minRewardR: 2.0,
          minSetupConfidenceScore: 55,
        },
      },
      indicators: null,
      signalDebug: null,
      reason: null,
    },
    null,
    new Date('2026-05-04T12:30:00.000Z')
  );

  assert(diagnostics.rrThresholdUsed === 2.0, `explicit setup rrThresholdUsed is preserved (got ${diagnostics.rrThresholdUsed})`);
  assert(diagnostics.confidenceThresholdUsed === 55, `confidenceThresholdUsed is null-safe and calibrated (got ${diagnostics.confidenceThresholdUsed})`);
  assert(diagnostics.rrPass === false, 'rrPass logs false below threshold');
  assert(diagnostics.confidencePass === false, 'confidencePass logs false below threshold');

  const boundary = buildV2Diagnostics(
    {
      signal: {
        initialRewardRisk: 2.0,
        setupConfidenceScore: 55,
      },
      indicators: null,
      signalDebug: null,
      reason: null,
    },
    null,
    new Date('2026-05-04T12:30:00.000Z')
  );
  assert(boundary.confidenceThresholdUsed === 55, `boundary confidence uses threshold 55 (got ${boundary.confidenceThresholdUsed})`);
  assert(boundary.confidencePass === true, 'confidencePass logs true at score 55');
  assert(boundary.rrPass === true, 'rrPass remains true above the v1.6 threshold');
}

section('EMA expansion penalty telemetry');
{
  const indicators = makeIndicators({
    ema20arr: [2000, 2000, 2000, 2000, 2000, 2000],
    ema50arr: [1996, 1996, 1996, 1996, 1996, 1996],
  });
  const generated = generateSignal(indicators, []);
  const diagnostics = buildV2Diagnostics(
    { signal: generated.signal, indicators, signalDebug: generated.debug, reason: null },
    indicators.marketRegime,
    new Date('2026-05-04T12:30:00.000Z')
  );

  assert(generated.signal !== null, 'missing EMA expansion still produces signal telemetry');
  assert(diagnostics.emaExpansionMissing === true, 'emaExpansionMissing logs true');
  assert(diagnostics.emaExpansionPenalty === -5, `emaExpansionPenalty logs -5 (got ${diagnostics.emaExpansionPenalty})`);
  assert(diagnostics.emaExpansionHandledAs === 'CONFIDENCE_PENALTY', `emaExpansionHandledAs logs CONFIDENCE_PENALTY (got ${diagnostics.emaExpansionHandledAs})`);
  assert(diagnostics.penaltyReason.includes('No prior EMA expansion'), `penaltyReason includes EMA expansion reason (got ${diagnostics.penaltyReason})`);
  assert(diagnostics.rejectStage === null, 'EMA expansion penalty does not become a regime hard rejection');
}

section('Regime threshold telemetry and confidence buckets');
{
  const dead = buildV2Diagnostics(
    { signal: null, indicators: makeIndicators({ atr: 2.0, atrAverage: 4.0 }), signalDebug: null, reason: 'SKIP: Market regime DEAD blocks new entries' },
    null,
    new Date('2026-05-04T12:30:00.000Z')
  );
  assert(dead.regimeBlockType === 'DEAD', `DEAD regime block type logs (got ${dead.regimeBlockType})`);
  assert(dead.atrRatioValue === 0.5, `atrRatioValue logs raw ratio (got ${dead.atrRatioValue})`);
  assert(dead.atrDeadDistance === -0.1, `atrDeadDistance logs threshold distance (got ${dead.atrDeadDistance})`);

  const sideways = buildV2Diagnostics(
    { signal: null, indicators: makeIndicators({ currEMA20: 2000, currEMA50: 1999.5, atr: 5, atrAverage: 5 }), signalDebug: null, reason: 'SKIP: Market regime SIDEWAYS blocks new entries' },
    null,
    new Date('2026-05-04T12:30:00.000Z')
  );
  assert(sideways.regimeBlockType === 'SIDEWAYS', `SIDEWAYS regime block type logs (got ${sideways.regimeBlockType})`);
  assert(sideways.sidewaysDistance === -0.04, `sidewaysDistance logs threshold distance (got ${sideways.sidewaysDistance})`);

  const extreme = buildV2Diagnostics(
    { signal: null, indicators: makeIndicators({ atr: 12, atrAverage: 4 }), signalDebug: null, reason: 'SKIP: Market regime EXTREME blocks new entries' },
    null,
    new Date('2026-05-04T12:30:00.000Z')
  );
  assert(extreme.regimeBlockType === 'EXTREME', `EXTREME regime block type logs (got ${extreme.regimeBlockType})`);
  assert(extreme.atrExtremeDistance === -0.4, `atrExtremeDistance logs threshold distance (got ${extreme.atrExtremeDistance})`);

  const lowConfidence = buildV2Diagnostics(
    { signal: { setupConfidenceScore: 64 }, indicators: null, signalDebug: null, reason: 'SKIP' },
    null,
    new Date('2026-05-04T12:30:00.000Z')
  );
  assert(lowConfidence.confidenceBucket === '50-64', `confidence bucket below gate logs (got ${lowConfidence.confidenceBucket})`);

  const highConfidence = buildV2Diagnostics(
    { signal: { setupConfidenceScore: 87 }, indicators: null, signalDebug: { dbgRawSetupConfidenceScore: 97 }, reason: null },
    null,
    new Date('2026-05-04T12:30:00.000Z')
  );
  assert(highConfidence.confidenceRaw === 97, `confidenceRaw logs pre-penalty score (got ${highConfidence.confidenceRaw})`);
  assert(highConfidence.confidenceBucket === '85-100', `confidence bucket high score logs (got ${highConfidence.confidenceBucket})`);
}

section('Pullback diagnostic logging');
{
  const diagnostics = buildV2Diagnostics(
    {
      signal: null,
      indicators: null,
      signalDebug: {
        pullbackValid: false,
        pullbackDirection: null,
        pullbackDistanceAtr: 0.28,
        pullbackRejectReason: 'BUY pullback invalid: low did not reach EMA20 zone; no valid BUY or SELL pullback',
      },
      reason: null,
    },
    null,
    new Date('2026-05-04T12:30:00.000Z')
  );

  assert(diagnostics.pullbackValid === false, 'invalid pullbackValid logs false');
  assert(diagnostics.pullbackDirection === null, 'invalid pullbackDirection logs null');
  assert(diagnostics.pullbackDistanceAtr === 0.28, `pullbackDistanceAtr logs finite value (got ${diagnostics.pullbackDistanceAtr})`);
  assert(diagnostics.pullbackRejectReason.includes('no valid BUY or SELL pullback'), `pullbackRejectReason logs clear reason (got ${diagnostics.pullbackRejectReason})`);
}

section('Sweep diagnostics');
{
  const diagnostics = buildV2Diagnostics(
    {
      signal: null,
      indicators: null,
      signalDebug: {
        sweepValid: true,
        sweepDirection: 'BUY',
        swingHigh: 110,
        swingLow: 100,
        bodyPct: 30,
        upperWickPct: 20,
        lowerWickPct: 50,
      },
      reason: null,
    },
    null,
    new Date('2026-05-04T12:30:00.000Z')
  );

  assert(diagnostics.sweepValid === true, 'sweepValid logs true when detected');
  assert(diagnostics.sweepDirection === 'BUY', `sweepDirection logs direction (got ${diagnostics.sweepDirection})`);
  assert(diagnostics.swingHigh === 110, `swingHigh logs sweep level (got ${diagnostics.swingHigh})`);
  assert(diagnostics.swingLow === 100, `swingLow logs sweep level (got ${diagnostics.swingLow})`);
  assert(diagnostics.bodyPct === 30, `bodyPct logs candle stat (got ${diagnostics.bodyPct})`);
  assert(diagnostics.upperWickPct === 20, `upperWickPct logs candle stat (got ${diagnostics.upperWickPct})`);
  assert(diagnostics.lowerWickPct === 50, `lowerWickPct logs candle stat (got ${diagnostics.lowerWickPct})`);
}

section('BOS diagnostics');
{
  const diagnostics = buildV2Diagnostics(
    {
      signal: null,
      indicators: null,
      signalDebug: {
        bosValid: true,
        bosDirection: 'SELL',
        lastSwingHigh: 106,
        lastSwingLow: 94,
        bosBreakDistanceAtr: 0.05,
      },
      reason: null,
    },
    null,
    new Date('2026-05-04T12:30:00.000Z')
  );

  assert(diagnostics.bosValid === true, 'bosValid logs true when detected');
  assert(diagnostics.bosDirection === 'SELL', `bosDirection logs direction (got ${diagnostics.bosDirection})`);
  assert(diagnostics.lastSwingHigh === 106, `lastSwingHigh logs fractal level (got ${diagnostics.lastSwingHigh})`);
  assert(diagnostics.lastSwingLow === 94, `lastSwingLow logs fractal level (got ${diagnostics.lastSwingLow})`);
  assert(diagnostics.bosBreakDistanceAtr === 0.05, `bosBreakDistanceAtr logs distance (got ${diagnostics.bosBreakDistanceAtr})`);
}

section('Kill-switch diagnostics');
{
  const now = new Date('2026-05-05T10:30:00.000Z');
  const activatedAt = new Date('2026-05-04T10:30:00.000Z').getTime();
  const diagnostics = buildKillSwitchDiagnostics(
    {
      rollingProfitFactor5: 0.66,
      expectancyKillSwitch: {
        active: true,
        activatedAt,
        resetReason: null,
      },
    },
    {},
    now
  );
  assert(diagnostics.killSwitchActive === true, 'killSwitchActive logs active expectancy kill switch state');
  assert(diagnostics.killSwitchActivatedAt === '2026-05-04T10:30:00.000Z', `killSwitchActivatedAt logs UTC activation time (got ${diagnostics.killSwitchActivatedAt})`);
  assert(diagnostics.currentTimeUTC === '2026-05-05T10:30:00.000Z', `currentTimeUTC logs current cron timestamp (got ${diagnostics.currentTimeUTC})`);
  assert(diagnostics.hoursSinceActivation === 24, `hoursSinceActivation logs elapsed hours (got ${diagnostics.hoursSinceActivation})`);
  assert(diagnostics.resetReason === null, `resetReason logs null before reset (got ${diagnostics.resetReason})`);
  assert(diagnostics.pfValueUsed === 0.66, `pfValueUsed logs PF5 value (got ${diagnostics.pfValueUsed})`);
  assert(diagnostics.pfThresholdUsed === 0.7, `pfThresholdUsed logs PF5 threshold (got ${diagnostics.pfThresholdUsed})`);
  assert(diagnostics.killSwitchPolicy === 'PF5_0.70_24H_EXPIRY', `killSwitchPolicy logs policy tag (got ${diagnostics.killSwitchPolicy})`);
}

section('Blocked setup tracking');
{
  const botState = {};
  const signal = {
    id: 'blocked_setup_1',
    action: 'BUY',
    entryPrice: 2000,
    stopLoss: 1990,
    takeProfit: 2022,
    setupConfidenceScore: 61,
    setupConfidence: { score: 61, rawScore: 66 },
    initialRewardRisk: 2.2,
    setupQuality: { confidenceOk: true, rewardOk: true },
  };
  const first = updateBlockedSetupTracking(
    botState,
    {
      signal,
      tradeExecuted: false,
      reason: 'PAUSE: Rolling 5-trade profit factor kill switch active — waiting for 1h trend reset',
      indicators: { lastCandle: { close: 2000 }, trend1h: 'UP' },
      signalDebug: {
        dbgSetupConfidenceScore: 61,
        dbgRawSetupConfidenceScore: 66,
        dbgInitialRewardRisk: 2.2,
        confidencePass: true,
        rrPass: true,
        marketRegime: 'NORMAL',
      },
    },
    new Date('2026-05-04T12:00:00.000Z')
  );
  assert(first.blockedSetupId === 'blocked_setup_1', `blocked setup id stored (got ${first.blockedSetupId})`);
  assert(first.blockedSetupDirection === 'BUY', `blocked setup direction stored (got ${first.blockedSetupDirection})`);
  assert(first.blockedSetupReason.includes('profit factor kill switch'), `blocked setup reason stored (got ${first.blockedSetupReason})`);
  assert(first.setupConfidenceScore === 61, `blocked setup confidence stored (got ${first.setupConfidenceScore})`);
  assert(first.rawSetupConfidenceScore === 66, `blocked setup raw confidence stored (got ${first.rawSetupConfidenceScore})`);
  assert(first.initialRewardRisk === 2.2, `blocked setup RR stored (got ${first.initialRewardRisk})`);
  assert(first.entryPrice === 2000 && first.stopLoss === 1990 && first.takeProfit === 2022, 'blocked setup prices stored');
  assert(first.direction === 'BUY', `blocked setup direction field stored (got ${first.direction})`);
  assert(first.marketRegime === 'NORMAL', `blocked setup marketRegime stored (got ${first.marketRegime})`);
  assert(first.trend1h === 'UP', `blocked setup trend1h stored (got ${first.trend1h})`);
  assert(first.confidencePass === true && first.rrPass === true, 'blocked setup pass flags stored');
  assert(botState.blockedSetupTracking.length === 1, 'blocked setup tracking stores without trade execution');

  const updated = updateBlockedSetupTracking(
    botState,
    {
      signal: null,
      tradeExecuted: false,
      reason: 'SKIP: No signal generated this cycle',
      indicators: { lastCandle: { close: 2015 } },
    },
    new Date('2026-05-04T12:30:00.000Z')
  );
  assert(updated.blockedSetupMfe1hR === 1.5, `blocked setup 1h MFE updates in R (got ${updated.blockedSetupMfe1hR})`);
  assert(updated.blockedSetupMfe3hR === 1.5, `blocked setup 3h MFE updates in R (got ${updated.blockedSetupMfe3hR})`);

  const adverse = updateBlockedSetupTracking(
    botState,
    {
      signal: null,
      tradeExecuted: false,
      reason: 'SKIP: No signal generated this cycle',
      indicators: { lastCandle: { close: 1985 } },
    },
    new Date('2026-05-04T14:30:00.000Z')
  );
  assert(adverse.blockedSetupMfe1hR === 1.5, 'blocked setup 1h MFE is retained after 1h horizon');
  assert(adverse.blockedSetupMae3hR === 1.5, `blocked setup 3h MAE updates in R (got ${adverse.blockedSetupMae3hR})`);
}

section('Legacy log normalization');
{
  const normalized = normalizeLogDiagnostics({
    time: '2026-05-02T22:10:06.928Z',
    strategyVersion: 'v1.5',
    signalDetected: 'NONE',
    marketRegime: null,
    reason: 'MARKET_CLOSED: Gold weekend close (Saturday UTC)',
  });

  assertNoUndefinedFields(normalized, V2_DIAGNOSTIC_FIELDS, 'normalized legacy log');
  assertNoUndefinedFields(normalized, LOGGER_EXPORT_FIELDS, 'normalized legacy log export');
  assert(normalized.sessionName === 'MARKET_CLOSED', `market closed legacy log is labeled (got ${normalized.sessionName})`);
  assert(normalized.isAllowedSession === false, 'market closed legacy log is marked not allowed');
  assert(normalized.sessionRejectReason === null, 'market closed legacy log has no session rejection noise');
  assert(normalized.strategyVersion === 'v1.5', 'legacy strategyVersion is preserved');
  assert(normalized.blockedSetupMfe1hR === null, 'legacy no-signal blockedSetupMfe1hR logs null');
  assert(normalized.blockedSetupMae1hR === null, 'legacy no-signal blockedSetupMae1hR logs null');
  assert(normalized.blockedSetupMfe3hR === null, 'legacy no-signal blockedSetupMfe3hR logs null');
  assert(normalized.blockedSetupMae3hR === null, 'legacy no-signal blockedSetupMae3hR logs null');
  assert(normalized.takenTradeMfeR === null, 'legacy no-signal takenTradeMfeR logs null');
  assert(normalized.takenTradeMaeR === null, 'legacy no-signal takenTradeMaeR logs null');
  assert(normalized.reached1R === null, 'legacy no-signal reached1R logs null');
  assert(normalized.reached1_5R === null, 'legacy no-signal reached1_5R logs null');
  assert(normalized.reached2R === null, 'legacy no-signal reached2R logs null');
  assert(normalized.reached2_5R === null, 'legacy no-signal reached2_5R logs null');
}

section('Logger export field normalization');
{
  const noSignal = normalizeLogDiagnostics({
    time: '2026-05-02T22:10:06.928Z',
    strategyVersion: 'v1.5',
    signalDetected: 'NONE',
    marketRegime: null,
    reason: 'SKIP: No signal generated this cycle',
    sessionName: 'OUTSIDE_SESSION',
    isAllowedSession: false,
    sessionRejectReason: 'SKIP: Outside allowed trading session',
    regime: null,
    atrRatio: null,
    emaSpreadAtr: null,
    regimeRejectReason: null,
    regimeBlockType: null,
    atrRatioValue: null,
    atrDeadDistance: null,
    atrExtremeDistance: null,
    emaSpreadAtrValue: null,
    sidewaysDistance: null,
    nearSignalDetected: false,
    nearSignalDirection: null,
    nearSignalRejectReason: 'SKIP: No signal generated this cycle',
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
    rrThresholdUsed: 2,
    confidenceThresholdUsed: 55,
    confidenceRaw: null,
    confidenceBucket: null,
    rrPass: null,
    confidencePass: null,
    rejectStage: null,
  });

  assertNoUndefinedFields(noSignal, LOGGER_EXPORT_FIELDS, 'normalized no-signal export');
  assert(noSignal.blockedSetupMfe1hR === null, 'NO_SIGNAL blockedSetupMfe1hR is null, not omitted');
  assert(noSignal.takenTradeMfeR === null, 'NO_SIGNAL takenTradeMfeR is null, not omitted');
  assert(noSignal.reached2R === null, 'NO_SIGNAL reached2R is null, not omitted');
  assert(noSignal.reached2_5R === null, 'NO_SIGNAL reached2_5R is null, not omitted');

  const closedTrade = normalizeLogDiagnostics({
    time: '2026-05-04T12:30:00.000Z',
    strategyVersion: 'v1.5',
    signalDetected: 'SELL',
    marketRegime: 'NORMAL',
    reason: 'CLOSED: CONFIRMED',
    exitAudit: {
      mfeR: 2.6,
      maeR: 0.4,
      reached1R: true,
      reached1_5R: true,
      reached2R: true,
      reached2_5R: true,
    },
  });

  assertNoUndefinedFields(closedTrade, LOGGER_EXPORT_FIELDS, 'normalized closed-trade export');
  assert(closedTrade.takenTradeMfeR === 2.6, `closed trade takenTradeMfeR logs from exitAudit (got ${closedTrade.takenTradeMfeR})`);
  assert(closedTrade.takenTradeMaeR === 0.4, `closed trade takenTradeMaeR logs from exitAudit (got ${closedTrade.takenTradeMaeR})`);
  assert(closedTrade.reached1R === true, 'closed trade reached1R logs true');
  assert(closedTrade.reached1_5R === true, 'closed trade reached1_5R logs true');
  assert(closedTrade.reached2R === true, 'closed trade reached2R logs true');
  assert(closedTrade.reached2_5R === true, 'closed trade reached2_5R logs true');
}

section('Telemetry does not alter strategy decision fields');
{
  const generated = generateSignal(makeIndicators(), []);
  assert(generated.signal !== null, 'baseline still produces a signal');
  if (generated.signal) {
    assert(generated.signal.action === 'BUY', `action unchanged (got ${generated.signal.action})`);
    assert(generated.signal.entryType === 'pullback', `entryType unchanged (got ${generated.signal.entryType})`);
    assert(generated.signal.entryPrice === 2001.8, `entryPrice unchanged (got ${generated.signal.entryPrice})`);
    assert(generated.signal.stopLoss === 1994.3, `stopLoss unchanged (got ${generated.signal.stopLoss})`);
    assert(generated.signal.takeProfit === 2015.3, `takeProfit unchanged (got ${generated.signal.takeProfit})`);
  }
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(60)}\n`);

if (failed > 0) process.exit(1);
