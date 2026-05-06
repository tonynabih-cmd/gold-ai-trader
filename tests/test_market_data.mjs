// tests/test_market_data.mjs
// Run: node tests/test_market_data.mjs

import {
  assessCandleSettlement,
  calculateCronSettlementDelayMs,
  CRON_SETTLEMENT_ALIGNMENT_TARGET_MS,
  REQUIRED_SETTLEMENT_MS,
} from '../lib/market_data.js';

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
  const result = assessCandleSettlement(candleOpenTime, candleCloseTime + 7000, FIVE_MINUTES_MS);
  assert(REQUIRED_SETTLEMENT_MS === 7000, `required settlement is 7000ms (got: ${REQUIRED_SETTLEMENT_MS})`);
  assert(result.requiredSettlementMs === 7000, `requiredSettlementMs logs 7000 (got: ${result.requiredSettlementMs})`);
  assert(result.settlementWaitMs === 7000, `settlementWaitMs logs 7000 at boundary (got: ${result.settlementWaitMs})`);
  assert(result.settlementPassed === true, 'settlement passes at 7 seconds');
}

{
  const result = assessCandleSettlement(candleOpenTime, candleCloseTime + 6999, FIVE_MINUTES_MS);
  assert(result.settlementWaitMs === 6999, `settlementWaitMs logs below-boundary value (got: ${result.settlementWaitMs})`);
  assert(result.settlementPassed === false, 'settlement still blocks below 7 seconds');
}

{
  const result = calculateCronSettlementDelayMs(candleCloseTime + 6000, FIVE_MINUTES_MS);
  assert(CRON_SETTLEMENT_ALIGNMENT_TARGET_MS === 8500, `cron alignment target is 8500ms (got: ${CRON_SETTLEMENT_ALIGNMENT_TARGET_MS})`);
  assert(result === 2500, `cron-job early call waits until 8.5s after close (got: ${result})`);
}

{
  const result = calculateCronSettlementDelayMs(candleCloseTime + 9000, FIVE_MINUTES_MS);
  assert(result === 0, `cron-job call after target does not wait (got: ${result})`);
}

console.log(`\nTests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
