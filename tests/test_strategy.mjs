// tests/test_strategy.mjs — Unit tests for lib/strategy.js
// Run: node tests/test_strategy.mjs

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
      open: 2000.1,
      high: 2002.0,
      low: 1999.8,
      close: 2001.1,
    },
    trendWindowStartTime: now - 30 * 60 * 1000,
    recentOutcomes: [],
    lastOrderTimestamp: now - 6 * 60 * 60 * 1000,
  };
  return { ...base, ...overrides };
}

section('Input guards');
{
  const result = generateSignal(null, []);
  assert(result.signal === null, 'null indicators → signal null');

  const result2 = generateSignal(makeIndicators(), null);
  assert(result2.signal === null, 'null candles1m → signal null');

  const result3 = generateSignal(makeIndicators({ currEMA20: NaN }), make1mCandles());
  assert(result3.signal === null, 'invalid indicator values → signal null');
}

section('Layer 1 volatility stability guard');
{
  const lowAtr = generateSignal(makeIndicators({ atr: 1.0, atrAverage: 4.0 }), make1mCandles());
  assert(lowAtr.signal === null, `dead market ATR is blocked (reason: ${lowAtr.debug?.dbgRejectReason})`);
  assert(lowAtr.debug?.dbgRejectReason?.includes('ATR below stable band'), 'low ATR rejection comes from Layer 1 band');

  const highAtr = generateSignal(makeIndicators({ atr: 12.0, atrAverage: 4.5 }), make1mCandles());
  assert(highAtr.signal === null, `spike ATR is blocked (reason: ${highAtr.debug?.dbgRejectReason})`);
  assert(highAtr.debug?.dbgRejectReason?.includes('ATR above stable band'), 'high ATR rejection comes from Layer 1 band');
}

section('Layer 2 BUY pullback with 2-step confirmation');
{
  const indicators = makeIndicators({
    currEMA20: 2000,
    currEMA50: 1996,
    prevCandle: {
      time: Date.now() - 5 * 60 * 1000,
      open: 2001.4,
      high: 2001.8,
      low: 1999.2,
      close: 2000.1,
    },
    lastCandle: {
      time: Date.now(),
      open: 2000.0,
      high: 2002.2,
      low: 1999.9,
      close: 2001.2,
    },
  });

  const result = generateSignal(indicators, make1mCandles());
  assert(result.signal !== null, `BUY pullback passes after touch + confirm (reason: ${result.debug?.dbgRejectReason})`);
  if (result.signal) {
    assert(result.signal.action === 'BUY', `Signal direction is BUY (got ${result.signal.action})`);
    assert(result.signal.entryType === 'pullback', `Entry type remains pullback (got ${result.signal.entryType})`);
    assert(result.signal.score === 2, `Signal keeps fixed score for unchanged risk contract (got ${result.signal.score})`);
  }
}

section('Layer 2 SELL pullback with 2-step confirmation');
{
  const indicators = makeIndicators({
    currEMA20: 1995,
    currEMA50: 1999,
    prevCandle: {
      time: Date.now() - 5 * 60 * 1000,
      open: 1994.8,
      high: 1995.6,
      low: 1993.7,
      close: 1994.9,
    },
    lastCandle: {
      time: Date.now(),
      open: 1995.0,
      high: 1995.1,
      low: 1992.8,
      close: 1994.1,
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
  assert(result.debug?.dbgRejectReason?.includes('confirmation candle did not close above EMA20'), 'confirmation rule is enforced explicitly');
}

section('Same-direction rapid re-entry is blocked inside same trend window');
{
  const now = Date.now();
  const result = generateSignal(
    makeIndicators({
      trendWindowStartTime: now - 20 * 60 * 1000,
      recentOutcomes: [
        { action: 'BUY', pnl: -4, closedAt: now - 3 * 60 * 1000 },
      ],
    }),
    make1mCandles()
  );

  assert(result.signal === null, `same-direction rapid re-entry is blocked (reason: ${result.debug?.dbgRejectReason})`);
  assert(result.debug?.dbgRejectReason?.includes('same-direction re-entry blocked'), 're-entry guard is tied to current trend window');
}

section('Opposite-direction recent close does not block current trend');
{
  const now = Date.now();
  const result = generateSignal(
    makeIndicators({
      trendWindowStartTime: now - 20 * 60 * 1000,
      recentOutcomes: [
        { action: 'SELL', pnl: -4, closedAt: now - 3 * 60 * 1000 },
      ],
    }),
    make1mCandles()
  );

  assert(result.signal !== null, `opposite-direction close does not block new pullback (reason: ${result.debug?.dbgRejectReason})`);
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
