import { classifyMarketRegime } from '../lib/market_regime.js';

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

function base(overrides = {}) {
  return {
    atr: 1.0,
    atrAverage: 1.0,
    currEMA20: 2001,
    currEMA50: 2000,
    trend1h: 'UP',
    spread: 0.10,
    ...overrides,
  };
}

console.log('\n── Passive market regime classifier ──');

assert(classifyMarketRegime(base({ atr: 0.40 })) === 'DEAD', 'low ATR maps to DEAD');
assert(classifyMarketRegime(base({ currEMA20: 2000.05, currEMA50: 2000, trend1h: 'UP' })) === 'SIDEWAYS', 'tight EMA separation maps to SIDEWAYS');
assert(classifyMarketRegime(base()) === 'NORMAL', 'ordinary ATR/trend maps to NORMAL');
assert(classifyMarketRegime(base({ atr: 1.70, atrAverage: 1.0 })) === 'VOLATILE', 'elevated ATR maps to VOLATILE');
assert(classifyMarketRegime(base({ atr: 2.60, atrAverage: 1.0 })) === 'EXTREME', 'extreme ATR maps to EXTREME');
assert(classifyMarketRegime(base({ atr: NaN })) === null, 'invalid ATR returns null telemetry label');

console.log(`\nTests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
