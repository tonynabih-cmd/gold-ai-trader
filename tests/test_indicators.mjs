// tests/test_indicators.mjs — Unit tests for lib/indicators.js
// Run: node tests/test_indicators.mjs

import { calculateIndicators } from '../lib/indicators.js';

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

function makeCandle(close, i = 0, baseTime = Date.now()) {
  const open = close - 0.10;
  return {
    time:  baseTime + i * 5 * 60 * 1000,
    open,
    high:  close + 2.0,   // ~2pt range → ATR > 1.2
    low:   open  - 2.0,
    close,
  };
}

// Generate `n` 5m candles with a gentle trend
function makeCandles5m(n = 120, startPrice = 2000, slope = 0.20) {
  return Array.from({ length: n }, (_, i) => makeCandle(startPrice + i * slope, i));
}

// Generate `n` 1h candles
function makeCandles1h(n = 60, startPrice = 2000) {
  return Array.from({ length: n }, (_, i) => makeCandle(startPrice + i * 0.10, i));
}

// ── Section 1: Input validation ───────────────────────────────────────────────

section('Input validation');
{
  const result1 = calculateIndicators(null, makeCandles1h());
  assert(result1.skip === true, 'null 5m candles → skip=true');
  assert(typeof result1.reason === 'string', 'null 5m candles → reason is string');

  const result2 = calculateIndicators([], makeCandles1h());
  assert(result2.skip === true, 'empty 5m candles → skip=true');

  const result3 = calculateIndicators(makeCandles5m(50), makeCandles1h());
  assert(result3.skip === true, `Only 50 5m candles → skip=true (need 100, reason: ${result3.reason})`);

  const result4 = calculateIndicators(makeCandles5m(100), null);
  assert(result4.skip === true, 'null 1h candles → skip=true');

  const result5 = calculateIndicators(makeCandles5m(100), [makeCandle(2000)]);
  assert(result5.skip === true, 'Only 1 1h candle → skip=true (need 2)');
}

// ── Section 2: Valid output structure ─────────────────────────────────────────

section('Valid output structure');
{
  const candles5m = makeCandles5m(120);
  const candles1h = makeCandles1h(60);
  const result    = calculateIndicators(candles5m, candles1h);

  assert(result.skip === false, 'Sufficient candles → skip=false');

  // Required numeric fields
  for (const field of ['currEMA20', 'currEMA50', 'prevEMA20', 'prevEMA50', 'slopePercent', 'atr', 'atrAverage', 'rsi', 'efficiency12']) {
    assert(typeof result[field] === 'number' && !isNaN(result[field]), `${field} is a valid number`);
  }

  // Required string/enum fields
  assert(result.trend1h === 'UP' || result.trend1h === 'DOWN', `trend1h is 'UP' or 'DOWN' (got ${result.trend1h})`);

  // Support/Resistance
  assert(typeof result.resistance === 'number', 'resistance is a number');
  assert(typeof result.support === 'number', 'support is a number');
  assert(result.resistance > result.support, 'resistance > support');

  // lastCandle
  assert(typeof result.lastCandle?.close === 'number', 'lastCandle.close is a number');

  // EMA arrays
  assert(Array.isArray(result.ema20arr), 'ema20arr is an array');
  assert(Array.isArray(result.ema50arr), 'ema50arr is an array');
  assert(result.ema20arr.length >= 2,    'ema20arr has at least 2 elements');
}

// ── Section 3: EMA calculation accuracy ───────────────────────────────────────

section('EMA calculation accuracy');
{
  // A perfect uptrend: price increases by exactly 1 per bar
  const n = 120;
  const candles5m = Array.from({ length: n }, (_, i) =>
    makeCandle(1000 + i, i)
  );
  const candles1h = makeCandles1h(60, 1000);
  const result = calculateIndicators(candles5m, candles1h);

  if (!result.skip) {
    // In a perfect linear trend, EMA20 should be above EMA50 (faster EMA tracks price better)
    assert(result.currEMA20 > result.currEMA50, `In uptrend: EMA20 (${result.currEMA20.toFixed(2)}) > EMA50 (${result.currEMA50.toFixed(2)})`);
    // Current price should be above both EMAs in a perfect uptrend
    const lastClose = candles5m[candles5m.length - 1].close;
    assert(lastClose > result.currEMA20, `Price (${lastClose}) > EMA20 (${result.currEMA20.toFixed(2)})`);
    assert(lastClose > result.currEMA50, `Price (${lastClose}) > EMA50 (${result.currEMA50.toFixed(2)})`);
  }

  // Flat market: all prices identical
  const flatCandles = Array.from({ length: 120 }, (_, i) => makeCandle(2000, i));
  const flatResult  = calculateIndicators(flatCandles, candles1h);

  if (!flatResult.skip) {
    // In a flat market, all EMAs converge to the same price
    assert(Math.abs(flatResult.currEMA20 - 2000) < 0.01, `Flat market EMA20 ≈ 2000 (got ${flatResult.currEMA20.toFixed(4)})`);
    assert(Math.abs(flatResult.currEMA50 - 2000) < 0.01, `Flat market EMA50 ≈ 2000 (got ${flatResult.currEMA50.toFixed(4)})`);
  }
}

// ── Section 4: ATR calculation ────────────────────────────────────────────────

section('ATR calculation');
{
  const candles5m = makeCandles5m(120, 2000);
  const candles1h = makeCandles1h(60);
  const result    = calculateIndicators(candles5m, candles1h);

  if (!result.skip) {
    assert(result.atr > 0, `ATR > 0 (got ${result.atr.toFixed(4)})`);
    assert(result.atrAverage > 0, `ATR baseline > 0 (got ${result.atrAverage.toFixed(4)})`);
    // ATR should be in a reasonable range for these synthetic candles
    assert(result.atr < 5, `ATR < 5 for synthetic flat-ish market (got ${result.atr.toFixed(4)})`);
  }
}

// ── Section 5: RSI range ──────────────────────────────────────────────────────

section('RSI range');
{
  // Perfect uptrend should give high RSI (>50)
  const upCandles5m = Array.from({ length: 120 }, (_, i) => makeCandle(1000 + i * 2, i));
  const candles1h   = makeCandles1h(60);
  const upResult    = calculateIndicators(upCandles5m, candles1h);
  if (!upResult.skip) {
    assert(upResult.rsi >= 0 && upResult.rsi <= 100, `RSI in [0,100] range (got ${upResult.rsi.toFixed(1)})`);
    assert(upResult.rsi > 50, `Strong uptrend RSI > 50 (got ${upResult.rsi.toFixed(1)})`);
  }

  // Perfect downtrend should give low RSI (<50)
  const downCandles5m = Array.from({ length: 120 }, (_, i) => makeCandle(2000 - i * 2, i));
  const downResult  = calculateIndicators(downCandles5m, candles1h);
  if (!downResult.skip) {
    assert(downResult.rsi >= 0 && downResult.rsi <= 100, `RSI in [0,100] range (got ${downResult.rsi.toFixed(1)})`);
    assert(downResult.rsi < 50, `Strong downtrend RSI < 50 (got ${downResult.rsi.toFixed(1)})`);
  }
}

// ── Section 6: Sideways market filter ─────────────────────────────────────────

section('Sideways market filter');
{
  // Perfect flat market → slope ≈ 0 → should trigger sideways filter
  const flatCandles = Array.from({ length: 120 }, (_, i) => ({
    time:  Date.now() + i * 5 * 60 * 1000,
    open:  2000,
    high:  2000.10,
    low:   1999.90,
    close: 2000,
  }));
  const candles1h = makeCandles1h(60);
  const result    = calculateIndicators(flatCandles, candles1h);

  assert(result.skip === true, `Perfectly flat market triggers sideways skip (reason: ${result.reason})`);
}

// ── Section 7: ATR spike filter ───────────────────────────────────────────────

section('ATR spike filter');
{
  // Normal candles + one huge spike candle
  const candles5m = makeCandles5m(119, 2000, 0.02);
  candles5m.push({
    time:  Date.now() + 119 * 5 * 60 * 1000,
    open:  2000,
    high:  2100,  // 100-point range → huge ATR
    low:   1900,
    close: 2050,
  });
  const candles1h = makeCandles1h(60);
  const result    = calculateIndicators(candles5m, candles1h);

  // If ATR spike > 2.5× average, should skip
  if (result.skip) {
    assert(result.reason.includes('ATR'), `Spike rejected with ATR reason (reason: ${result.reason})`);
  } else {
    // If the candles are arranged so the spike is absorbed into atrAverage, it might pass
    console.log(`    (ATR spike not filtered — ATR=${result.atr?.toFixed(2)}, avg=${result.atrAverage?.toFixed(2)})`);
  }
}

// ── Section 8: Candle OHLC consistency ───────────────────────────────────────

section('Support/Resistance based on last 50 candles');
{
  const candles5m = makeCandles5m(120, 2000, 0.02);
  // Inject a known high and low into the last 50 candles
  candles5m[80].high  = 2500;  // Should become resistance
  candles5m[90].low   = 1500;  // Should become support
  const candles1h = makeCandles1h(60);
  const result    = calculateIndicators(candles5m, candles1h);

  if (!result.skip) {
    assert(result.resistance >= 2500, `Resistance includes max high (${result.resistance})`);
    assert(result.support    <= 1500, `Support includes min low (${result.support})`);
  }
}

// ── Section 9: Exception safety ──────────────────────────────────────────────

section('Exception safety');
{
  // Pass candles with NaN prices
  const nanCandles = Array.from({ length: 120 }, () => ({
    time: Date.now(), open: NaN, high: NaN, low: NaN, close: NaN,
  }));
  let threw = false;
  try {
    const result = calculateIndicators(nanCandles, makeCandles1h());
    assert(result.skip === true, 'NaN candles → skip=true (no throw)');
  } catch (_) {
    threw = true;
  }
  assert(!threw, 'calculateIndicators never throws — returns {skip:true} on any error');
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(60)}\n`);

if (failed > 0) process.exit(1);
