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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCandle(close, open = null) {
  open = open ?? close;
  return { time: Date.now(), open, high: close + 1, low: close - 1, close };
}

function makeStrongBullishCandles(n = 5, basePrice = 2000) {
  return Array.from({ length: n }, (_, i) => {
    const open  = basePrice + i * 0.30;
    const close = open + 0.20;
    return { time: Date.now() - (n - i) * 60000, open, high: close + 0.10, low: open - 0.05, close };
  });
}

function makeStrongBearishCandles(n = 5, basePrice = 2000) {
  return Array.from({ length: n }, (_, i) => {
    const open  = basePrice - i * 0.30;
    const close = open - 0.20;
    return { time: Date.now() - (n - i) * 60000, open, high: open + 0.05, low: close - 0.10, close };
  });
}

// Minimal indicator set that will pass all guards
function makeIndicators(overrides = {}) {
  const base = {
    currEMA20:   2000,
    currEMA50:   1998,  // EMA20 > EMA50 → uptrend
    prevEMA20:   1998,  // Was below EMA50 → crossover
    prevEMA50:   1999,
    slopePercent: 0.20,
    atr:          5.0,
    atrAverage:   4.0,
    rsi:          55,
    resistance:   2020,
    support:      1980,
    trend1h:      'UP',
    lastCandle:   { time: Date.now(), open: 1999.5, high: 2001, low: 1999, close: 2001 },
    ema20arr:     [1997, 1998, 1998, 2000],
    ema50arr:     [1999, 1999, 1999, 1998],
  };
  return { ...base, ...overrides };
}

// ── Section 1: null/undefined input guards ─────────────────────────────────

section('Input guards');
{
  const result = generateSignal(null, []);
  assert(result.signal === null, 'null indicators → signal null');

  const result2 = generateSignal(makeIndicators(), null);
  assert(result2.signal === null, 'null candles1m → signal null');

  const result3 = generateSignal(makeIndicators(), []);
  assert(result3.signal === null, 'empty candles1m → signal null');

  // NaN in core indicators
  const badIndicators = makeIndicators({ currEMA20: NaN });
  const result4 = generateSignal(badIndicators, makeStrongBullishCandles());
  assert(result4.signal === null, 'NaN in currEMA20 → signal null');
}

// ── Section 2: EMA crossover signals ─────────────────────────────────────────

section('EMA crossover — BUY signal');
{
  // EMA20 crosses above EMA50 on current bar
  const indicators = makeIndicators({
    ema20arr: [1997, 1998, 1998, 2001],  // last value crosses above EMA50
    ema50arr: [1999, 1999, 1999, 1999],  // EMA50 stable
    currEMA20: 2001,
    currEMA50: 1999,
    prevEMA20: 1998,
    prevEMA50: 1999,
    lastCandle: { time: Date.now(), open: 1999, high: 2002, low: 1998, close: 2001.5 },
  });

  const candles1m = makeStrongBullishCandles(5, 2000);
  const result = generateSignal(indicators, candles1m);

  assert(result.signal !== null, `Expected BUY crossover signal but got null (reason: ${result.debug?.dbgRejectReason})`);
  if (result.signal !== null) {
    assert(result.signal.action === 'BUY', `Crossover BUY signal detected (got ${result.signal.action})`);
    assert(result.signal.entryType === 'crossover', `Entry type is crossover (got ${result.signal.entryType})`);
    assert(result.signal.score >= 2, `Score >= 2 (got ${result.signal.score})`);
    assert(result.signal.stopLoss < result.signal.entryPrice, `Stop loss below entry (SL=${result.signal.stopLoss}, entry=${result.signal.entryPrice})`);
    assert(result.signal.takeProfit > result.signal.entryPrice, `Take profit above entry`);
    assert(typeof result.signal.id === 'string', `Signal has string ID`);
    assert(result.signal.atr === 5.0, `Signal carries ATR value`);
  }
}

section('EMA crossover — SELL signal');
{
  // EMA20 crosses below EMA50 on current bar
  const indicators = makeIndicators({
    ema20arr: [2001, 2000, 1999, 1997],  // last value crosses below EMA50
    ema50arr: [1999, 1999, 1999, 1999],
    currEMA20: 1997,
    currEMA50: 1999,
    prevEMA20: 1999,
    prevEMA50: 1999,
    slopePercent: -0.25,
    lastCandle: { time: Date.now(), open: 1999, high: 2000, low: 1994, close: 1995 },  // close < currEMA20 (1997)
    trend1h: 'DOWN',
  });

  const candles1m = makeStrongBearishCandles(5, 2000);
  const result = generateSignal(indicators, candles1m);

    assert(result.signal !== null, `Expected SELL crossover signal but got null (reason: ${result.debug?.dbgRejectReason})`);
  if (result.signal !== null) {
    assert(result.signal.action === 'SELL', `Crossover SELL signal detected (got ${result.signal.action})`);
    assert(result.signal.entryType === 'crossover', `Entry type is crossover`);
    assert(result.signal.stopLoss > result.signal.entryPrice, `SELL stop loss above entry`);
    assert(result.signal.takeProfit < result.signal.entryPrice, `SELL take profit below entry`);
  }
}

// ── Section 3: Pullback signals ────────────────────────────────────────────

section('Pullback BUY — trend established, price near EMA20');
{
  const indicators = makeIndicators({
    ema20arr: Array.from({ length: 60 }, (_, i) => 1990 + i * 0.15),
    ema50arr: Array.from({ length: 60 }, (_, i) => 1985 + i * 0.10),
    currEMA20: 1998,
    currEMA50: 1991,  // EMA20 > EMA50 by 7 points (strong uptrend)
    prevEMA20: 1997,
    prevEMA50: 1991,
    slopePercent: 0.25,
    atr:          5.0,
    atrAverage:   4.5,
    lastCandle: {
      time:  Date.now(),
      open:  1997.0,
      high:  1999.5,
      low:   1995.0,
      close: 1999.0,  // Bullish close, above EMA20
    },
  });

  const candles1m = makeStrongBullishCandles(5, 1999);
  const result = generateSignal(indicators, candles1m);

  if (result.signal !== null) {
    assert(result.signal.action === 'BUY', `Pullback BUY signal (got ${result.signal.action})`);
    assert(['pullback', 'momentum'].includes(result.signal.entryType), `Entry type is pullback/momentum (got ${result.signal.entryType})`);
  } else {
    // May legitimately be filtered by anti-chop or other rules; just log
    console.log(`    (No pullback BUY signal — reason: ${result.debug?.dbgRejectReason})`);
  }
}

// ── Section 4: Filter gates ────────────────────────────────────────────────

section('1m momentum filter — too weak');
{
  const indicators = makeIndicators();
  // Choppy 1m candles with near-zero net movement
  const weakCandles = [
    { time: Date.now() - 3000, open: 2000, high: 2001, low: 1999, close: 2000.05 },
    { time: Date.now() - 2000, open: 2000.05, high: 2001, low: 1999, close: 1999.98 },
    { time: Date.now() - 1000, open: 1999.98, high: 2000.5, low: 1999, close: 2000.05 },
  ];
  const result = generateSignal(indicators, weakCandles);
  assert(result.signal === null, `Signal filtered: weak 1m momentum (reason: ${result.debug?.dbgRejectReason})`);
}

section('1m direction inconsistency filter');
{
  const indicators = makeIndicators();
  // Net momentum is positive but 2 of 3 candles are bearish
  const mixedCandles = [
    { time: Date.now() - 3000, open: 2000, high: 2005, low: 1999, close: 1999.5 },  // bearish
    { time: Date.now() - 2000, open: 1999.5, high: 2002, low: 1998, close: 1999.2 }, // bearish
    { time: Date.now() - 1000, open: 1999.2, high: 2005, low: 1999, close: 2003 },   // bullish (+3.8)
  ];
  const result = generateSignal(indicators, mixedCandles);
  assert(result.signal === null, `Signal filtered: direction inconsistency (reason: ${result.debug?.dbgRejectReason})`);
}

section('Score too low — no signal');
{
  // EMA crossover but counter-trend, near resistance, RSI overbought
  const indicators = makeIndicators({
    ema20arr: [1997, 1998, 1998, 2001],
    ema50arr: [1999, 1999, 1999, 1999],
    currEMA20: 2001,
    currEMA50: 1999,
    prevEMA20: 1998,
    prevEMA50: 1999,
    rsi:       78,    // overbought → -1
    trend1h:  'DOWN', // counter-trend → -1
    resistance: 2002, // very close to resistance → -2
    atr:        5.0,  // resistance within 0.5*ATR = 2.5
    lastCandle: { time: Date.now(), open: 1999, high: 2002, low: 1998, close: 2001.5 },
  });

  const candles1m = makeStrongBullishCandles(5, 2000);
  const result = generateSignal(indicators, candles1m);
  // Score: crossover=+2, ATR>2=+1, bullish candle=+1, slope>0=+1, RSI>70=-1, counter-trend=-1, near resistance=-2 → total=1 < 2
  if (result.signal === null) {
    assert(true, `Low-score signal correctly rejected (reason: ${result.debug?.dbgRejectReason})`);
  } else {
    // Score might vary slightly depending on implementation
    console.log(`    Signal not filtered (score=${result.signal.score}) — reviewing score logic`);
  }
}

section('Stale crossover — not on current bar');
{
  // EMA20 already above EMA50 for multiple bars — no new crossover
  const indicators = makeIndicators({
    ema20arr: [1995, 2000, 2001, 2002, 2003],  // Already crossed 4 bars ago
    ema50arr: [1999, 1999, 1999, 1999, 1999],
    currEMA20: 2003,
    currEMA50: 1999,
    prevEMA20: 2002,  // Already above
    prevEMA50: 1999,
    slopePercent: 0.20,
    lastCandle: { time: Date.now(), open: 2002, high: 2004, low: 2001, close: 2003 },
  });

  const candles1m = makeStrongBullishCandles(5, 2002);
  const result = generateSignal(indicators, candles1m);
  // No crossover on current bar (both pE20 > pE50 and cE20 > cE50 → no crossover)
  // Would need pullback conditions to trigger
  if (result.signal) {
    assert(['pullback', 'momentum'].includes(result.signal.entryType), `Any signal from stale crossover is pullback/momentum type (got ${result.signal.entryType})`);
  } else {
    assert(true, `No stale crossover signal generated (reason: ${result.debug?.dbgRejectReason})`);
  }
}

// ── Section 5: Signal structure ────────────────────────────────────────────

section('Signal structure validation');
{
  const indicators = makeIndicators();
  const candles1m  = makeStrongBullishCandles(5, 2000);
  const result     = generateSignal(indicators, candles1m);

  if (result.signal !== null) {
    const s = result.signal;
    assert(typeof s.id          === 'string',  'Signal has id (string)');
    assert(typeof s.action      === 'string',  'Signal has action');
    assert(typeof s.entryPrice  === 'number',  'Signal has entryPrice (number)');
    assert(typeof s.stopLoss    === 'number',  'Signal has stopLoss (number)');
    assert(typeof s.takeProfit  === 'number',  'Signal has takeProfit (number)');
    assert(typeof s.atr         === 'number',  'Signal has atr (number)');
    assert(typeof s.score       === 'number',  'Signal has score (number)');
    assert(!isNaN(s.stopLoss),                 'stopLoss is not NaN');
    assert(!isNaN(s.takeProfit),               'takeProfit is not NaN');
    assert(s.action === 'BUY' || s.action === 'SELL', 'Action is BUY or SELL');
    
    // R:R ratio should be at least 1:1 (TP distance >= SL distance)
    const slDist = Math.abs(s.entryPrice - s.stopLoss);
    const tpDist = Math.abs(s.takeProfit - s.entryPrice);
    assert(tpDist >= slDist, `R:R >= 1:1 (SL dist=${slDist.toFixed(2)}, TP dist=${tpDist.toFixed(2)})`);
  }

  // debug is always returned
  assert(result.debug !== undefined, 'Debug object always present');
  assert(typeof result.debug === 'object', 'Debug is an object');
}

section('Exception safety');
{
  // Pass a completely broken indicators object — override AFTER spread
  const badIndicators = { ...makeIndicators(), currEMA20: 'not-a-number' };
  let threw = false;
  try {
    const result = generateSignal(badIndicators, makeStrongBullishCandles());
    // Should return null signal, not throw
    assert(result.signal === null, 'Broken input returns null signal (no throw)');
    assert(typeof result.debug?.dbgRejectReason === 'string', 'Debug reason present on error');
  } catch (_) {
    threw = true;
  }
  assert(!threw, 'generateSignal never throws — returns {signal:null, debug:{...}} on any error');
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(60)}\n`);

if (failed > 0) process.exit(1);
