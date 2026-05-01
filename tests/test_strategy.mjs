// tests/test_strategy.mjs — Unit tests for lib/strategy.js
// Run: node tests/test_strategy.mjs

import { generateSignal } from '../lib/strategy.js';
import { checkRisk } from '../lib/risk.js';

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

section('1h trend conflict applies confidence penalty instead of hard reject');
{
  const aligned = generateSignal(makeHighQualityIndicators({ trend1h: 'UP' }), make1mCandles());
  const conflicted = generateSignal(makeHighQualityIndicators({ trend1h: 'DOWN' }), make1mCandles());

  assert(aligned.signal !== null, `Aligned high-quality setup produces signal (reason: ${aligned.debug?.dbgRejectReason})`);
  assert(conflicted.signal !== null, `1h conflict no longer causes immediate SKIP (reason: ${conflicted.debug?.dbgRejectReason})`);

  if (aligned.signal && conflicted.signal) {
    assert(
      conflicted.signal.setupConfidenceScore === aligned.signal.setupConfidenceScore - 10,
      `Conflicted setupConfidenceScore is reduced by 10 (${aligned.signal.setupConfidenceScore} -> ${conflicted.signal.setupConfidenceScore})`
    );
    assert(
      conflicted.signal.setupConfidence?.penalties?.includes('1h trend conflict penalty applied: -10'),
      'Penalty is logged in setupConfidence telemetry'
    );
    assert(conflicted.debug?.dbgTrendConflictPenalty === -10, 'Penalty is exposed in debug telemetry');
  }
}

section('1h-conflicted setups still pass through normal risk gates');
{
  const lowQuality = generateSignal(makeIndicators({ trend1h: 'DOWN' }), make1mCandles());
  assert(lowQuality.signal !== null, `Low-quality conflicted setup reaches risk gate (reason: ${lowQuality.debug?.dbgRejectReason})`);
  if (lowQuality.signal) {
    const lowRisk = checkRisk(
      lowQuality.signal,
      makeBotState(),
      {
        atr: lowQuality.signal.atr,
        atrAverage: 4.5,
        spread: 0.30,
        currEMA20: 2000,
        currEMA50: 1997,
        trend1h: 'DOWN',
      }
    );
    assert(lowRisk.includes('Setup confidence score'), `Low-quality conflicted setup fails later confidence gate (got: ${lowRisk})`);
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

section('Signal structure validation');
{
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
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(60)}\n`);

if (failed > 0) process.exit(1);
