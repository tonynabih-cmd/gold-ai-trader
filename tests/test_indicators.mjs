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

function makeCandle(close, i = 0, baseTime = Date.now()) {
  const open = close - 0.10;
  return {
    time: baseTime + i * 5 * 60 * 1000,
    open,
    high: close + 2.0,
    low: open - 2.0,
    close,
  };
}

function makeCandles5m(n = 120, startPrice = 2000, slope = 0.20) {
  return Array.from({ length: n }, (_, i) => makeCandle(startPrice + i * slope, i));
}

function makeCandles1h(n = 60, startPrice = 2000) {
  return Array.from({ length: n }, (_, i) => makeCandle(startPrice + i * 0.10, i));
}

section('Input validation');
{
  const result1 = calculateIndicators(null, makeCandles1h());
  assert(result1.skip === true, 'null 5m candles → skip=true');

  const result2 = calculateIndicators(makeCandles5m(50), makeCandles1h());
  assert(result2.skip === true, 'insufficient 5m candles → skip=true');

  const result3 = calculateIndicators(makeCandles5m(100), null);
  assert(result3.skip === true, 'null 1h candles → skip=true');
}

section('Valid output structure');
{
  const result = calculateIndicators(makeCandles5m(120), makeCandles1h(60));
  assert(result.skip === false, 'sufficient candles → skip=false');

  for (const field of ['currEMA20', 'currEMA50', 'prevEMA20', 'prevEMA50', 'slopePercent', 'atr', 'atrAverage', 'rsi', 'efficiency12']) {
    assert(typeof result[field] === 'number' && !isNaN(result[field]), `${field} is a valid number`);
  }

  assert(typeof result.lastCandle?.close === 'number', 'lastCandle exists');
  assert(typeof result.prevCandle?.close === 'number', 'prevCandle exists');
  assert(Array.isArray(result.ema20arr), 'ema20arr exists');
  assert(Array.isArray(result.ema50arr), 'ema50arr exists');
}

section('Trend window metadata');
{
  const candles5m = makeCandles5m(120, 2000, 0.25);
  const result = calculateIndicators(candles5m, makeCandles1h());

  assert(result.currentTrendDirection === 'BUY' || result.currentTrendDirection === 'SELL' || result.currentTrendDirection === 'FLAT', 'currentTrendDirection is present');
  assert(typeof result.trendWindowStartTime === 'number' || result.trendWindowStartTime === null, 'trendWindowStartTime is present');
}

section('Indicator layer does not pre-skip on flat or spike regimes');
{
  const flatCandles = Array.from({ length: 120 }, (_, i) => ({
    time: Date.now() + i * 5 * 60 * 1000,
    open: 2000,
    high: 2000.10,
    low: 1999.90,
    close: 2000,
  }));
  const flatResult = calculateIndicators(flatCandles, makeCandles1h());
  assert(flatResult.skip === false, 'flat market still returns indicators for Layer 1 to decide');

  const spikeCandles = makeCandles5m(119, 2000, 0.02);
  spikeCandles.push({
    time: Date.now() + 119 * 5 * 60 * 1000,
    open: 2000,
    high: 2100,
    low: 1900,
    close: 2050,
  });
  const spikeResult = calculateIndicators(spikeCandles, makeCandles1h());
  assert(spikeResult.skip === false, 'ATR spike does not get pre-filtered before strategy Layer 1');
  assert(spikeResult.atr > spikeResult.atrAverage, 'spike still shows up in ATR telemetry');
}

section('Exception safety');
{
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
  assert(!threw, 'calculateIndicators never throws');
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(60)}\n`);

if (failed > 0) process.exit(1);
