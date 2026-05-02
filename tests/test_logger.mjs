// tests/test_logger.mjs — Unit tests for passive v2 diagnostic log fields.

import { buildV2Diagnostics, CYCLE_LOG_RETENTION_LIMIT, normalizeLogDiagnostics, V2_DIAGNOSTIC_FIELDS } from '../lib/logger.js';
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
      high: 2002.2,
      low: 1999.0,
      close: 2001.2,
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
  assert(diagnostics.rrCandidate === 2.5, `rrCandidate mirrors setup RR (got ${diagnostics.rrCandidate})`);
  assert(diagnostics.rrThresholdUsed === 2.0, `rrThresholdUsed logs v2 threshold (got ${diagnostics.rrThresholdUsed})`);
  assert(diagnostics.confidenceThresholdUsed === 65, `confidenceThresholdUsed logs v2 threshold (got ${diagnostics.confidenceThresholdUsed})`);
  assert(diagnostics.rrPass === true, 'rrPass logs true when RR meets v2 threshold');
  assert(diagnostics.confidencePass === true, 'confidencePass logs true when setup confidence meets v2 threshold');
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
  assert(diagnostics.rrThresholdUsed === 2.0, `missing signal still logs rrThresholdUsed (got ${diagnostics.rrThresholdUsed})`);
  assert(diagnostics.confidenceThresholdUsed === 65, `missing signal still logs confidenceThresholdUsed (got ${diagnostics.confidenceThresholdUsed})`);
  assert(diagnostics.rrPass === null, 'missing RR logs null rrPass');
  assert(diagnostics.confidencePass === null, 'missing confidence logs null confidencePass');
  assert(diagnostics.strategyVersion === 'v1.5', 'missing signal falls back to active strategyVersion');
}

section('RR and confidence calibration logging');
{
  const diagnostics = buildV2Diagnostics(
    {
      signal: {
        initialRewardRisk: 1.99,
        setupConfidenceScore: 64,
        setupQuality: {
          initialRewardRisk: 1.99,
          setupConfidenceScore: 64,
          rewardOk: false,
          confidenceOk: false,
          minRewardR: 2.0,
          minSetupConfidenceScore: 65,
        },
      },
      indicators: null,
      signalDebug: null,
      reason: null,
    },
    null,
    new Date('2026-05-04T12:30:00.000Z')
  );

  assert(diagnostics.rrThresholdUsed === 2.0, `rrThresholdUsed is null-safe and calibrated (got ${diagnostics.rrThresholdUsed})`);
  assert(diagnostics.confidenceThresholdUsed === 65, `confidenceThresholdUsed is null-safe and calibrated (got ${diagnostics.confidenceThresholdUsed})`);
  assert(diagnostics.rrPass === false, 'rrPass logs false below threshold');
  assert(diagnostics.confidencePass === false, 'confidencePass logs false below threshold');
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
  assert(normalized.sessionName === 'MARKET_CLOSED', `market closed legacy log is labeled (got ${normalized.sessionName})`);
  assert(normalized.isAllowedSession === false, 'market closed legacy log is marked not allowed');
  assert(normalized.sessionRejectReason === null, 'market closed legacy log has no session rejection noise');
  assert(normalized.strategyVersion === 'v1.5', 'legacy strategyVersion is preserved');
}

section('Telemetry does not alter strategy decision fields');
{
  const generated = generateSignal(makeIndicators(), []);
  assert(generated.signal !== null, 'baseline still produces a signal');
  if (generated.signal) {
    assert(generated.signal.action === 'BUY', `action unchanged (got ${generated.signal.action})`);
    assert(generated.signal.entryType === 'pullback', `entryType unchanged (got ${generated.signal.entryType})`);
    assert(generated.signal.entryPrice === 2001.2, `entryPrice unchanged (got ${generated.signal.entryPrice})`);
    assert(generated.signal.stopLoss === 1993.7, `stopLoss unchanged (got ${generated.signal.stopLoss})`);
    assert(generated.signal.takeProfit === 2019.95, `takeProfit unchanged (got ${generated.signal.takeProfit})`);
  }
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(60)}\n`);

if (failed > 0) process.exit(1);
