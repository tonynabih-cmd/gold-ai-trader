import { classifyMarketRegime, classifyMarketRegimeDetails, isAllowedMarketRegime } from '../lib/market_regime.js';

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
    spread: 0.10,
    ...overrides,
  };
}

console.log('\n── Deterministic market regime classifier ──');

assert(classifyMarketRegime(base({ atr: 0.59, atrAverage: 1.0 })) === 'DEAD', 'DEAD from atrRatio < 0.60');
assert(classifyMarketRegime(base({ atr: 0.59, atrAverage: 0.59 })) === 'DEAD', 'DEAD from atr14_5m < 0.60');
assert(classifyMarketRegime(base({ atr: 0.65, atrAverage: 1.0 })) === 'SOFT_DEAD', 'SOFT_DEAD from atrRatio 0.60-0.70');
assert(classifyMarketRegime(base({ atr: 2.21, atrAverage: 1.0 })) === 'SOFT_EXTREME', 'SOFT_EXTREME from atrRatio > 2.20');
assert(classifyMarketRegime(base({ atr: 2.61, atrAverage: 1.0 })) === 'EXTREME', 'EXTREME from atrRatio > 2.60');
assert(classifyMarketRegime(base({ atr: 1.0, atrAverage: 1.0, currEMA20: 2000.17, currEMA50: 2000 })) === 'SOFT_SIDEWAYS', 'SOFT_SIDEWAYS from emaSpreadAtr 0.14-0.18');
assert(classifyMarketRegime(base({ atr: 1.0, atrAverage: 1.0, currEMA20: 2000.13, currEMA50: 2000 })) === 'SIDEWAYS', 'SIDEWAYS from emaSpreadAtr < 0.14');
assert(classifyMarketRegime(base({ atr: 1.2, atrAverage: 1.0 })) === 'ACTIVE', 'ACTIVE from atrRatio between 1.20 and 2.20');
assert(classifyMarketRegime(base({ atr: 1.19, atrAverage: 1.0 })) === 'NORMAL', 'NORMAL fallback below ACTIVE threshold');
assert(classifyMarketRegime(base({ atr: NaN })) === null, 'invalid ATR returns null regime');

const active = classifyMarketRegimeDetails(base({ atr: 1.5, atrAverage: 1.0, currEMA20: 2002, currEMA50: 2000 }));
assert(active.regime === 'ACTIVE', `details include ACTIVE regime (got ${active.regime})`);
assert(active.atrRatio === 1.5, `details include atrRatio (got ${active.atrRatio})`);
assert(active.emaSpreadAtr === 1.3333, `details include emaSpreadAtr (got ${active.emaSpreadAtr})`);
assert(active.isAllowedRegime === true, 'ACTIVE is allowed');
assert(active.regimeRejectReason === null, 'ACTIVE has no reject reason');

const blocked = classifyMarketRegimeDetails(base({ atr: 0.5, atrAverage: 1.0 }));
assert(blocked.isAllowedRegime === false, 'DEAD is blocked');
assert(blocked.regimeRejectReason === 'SKIP: Market regime DEAD blocks new entries', `DEAD reject reason is clear (got ${blocked.regimeRejectReason})`);

const closed = classifyMarketRegimeDetails(base({ atr: 2.5, atrAverage: 1.0 }), {
  marketClosedReason: 'MARKET_CLOSED: Gold weekend close (Saturday UTC)',
});
assert(closed.regime === null, 'market-closed override suppresses regime label');
assert(closed.regimeRejectReason === null, 'market-closed override creates no regime noise');

assert(isAllowedMarketRegime('NORMAL') === true, 'NORMAL is allowed');
assert(isAllowedMarketRegime('ACTIVE') === true, 'ACTIVE is allowed');
assert(isAllowedMarketRegime('SOFT_DEAD') === true, 'SOFT_DEAD is allowed at reduced risk');
assert(isAllowedMarketRegime('SOFT_SIDEWAYS') === true, 'SOFT_SIDEWAYS is allowed at reduced risk');
assert(isAllowedMarketRegime('SOFT_EXTREME') === true, 'SOFT_EXTREME is allowed at reduced risk');
assert(isAllowedMarketRegime('DEAD') === false, 'DEAD is blocked');
assert(isAllowedMarketRegime('SIDEWAYS') === false, 'SIDEWAYS is blocked');
assert(isAllowedMarketRegime('EXTREME') === false, 'EXTREME is blocked');

console.log(`\nTests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
