// tests/test_market_data.mjs
// Run: node tests/test_market_data.mjs

import { assessCandleSettlement, REQUIRED_SETTLEMENT_MS } from '../lib/market_data.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  OK ${message}`);
  } else {
    failed++;
    console.error(`  FAIL ${message}`);
  }
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const candleOpenTime = Date.parse('2026-05-04T12:25:00.000Z');
const candleCloseTime = candleOpenTime + FIVE_MINUTES_MS;

console.log('\nMarket data settlement guard');

{
  const result = assessCandleSettlement(candleOpenTime, candleCloseTime + 5000, FIVE_MINUTES_MS);
  assert(REQUIRED_SETTLEMENT_MS === 5000, `required settlement is 5000ms (got: ${REQUIRED_SETTLEMENT_MS})`);
  assert(result.requiredSettlementMs === 5000, `requiredSettlementMs logs 5000 (got: ${result.requiredSettlementMs})`);
  assert(result.settlementWaitMs === 5000, `settlementWaitMs logs 5000 at boundary (got: ${result.settlementWaitMs})`);
  assert(result.settlementPassed === true, 'settlement passes at 5 seconds');
}

{
  const result = assessCandleSettlement(candleOpenTime, candleCloseTime + 4999, FIVE_MINUTES_MS);
  assert(result.settlementWaitMs === 4999, `settlementWaitMs logs below-boundary value (got: ${result.settlementWaitMs})`);
  assert(result.settlementPassed === false, 'settlement still blocks below 5 seconds');
}

console.log(`\nTests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
