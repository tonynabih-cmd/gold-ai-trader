import { buildDelegationGap, classifyDelegationGapReason } from '../lib/delegation_gap.js';

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

console.log('\n── Passive delegation-gap telemetry ──');

{
  const gap = buildDelegationGap({
    signal: { action: 'BUY' },
    tradeExecuted: false,
    reason: 'PAUSE: BUY cooldown after stop loss',
    marketRegime: 'NORMAL',
    executionPolicy: { decision: 'BLOCK' },
    timestamp: 12345,
  });
  assert(gap.intendedAction === 'BUY', 'BUY intent is captured');
  assert(gap.category === 'risk_gate', `risk gate category captured (got ${gap.category})`);
  assert(gap.blockingReason === 'PAUSE: BUY cooldown after stop loss', 'blocking reason is preserved');
  assert(gap.marketRegime === 'NORMAL', 'market regime is preserved');
  assert(gap.executionPolicy?.decision === 'BLOCK', 'execution policy is preserved');
  assert(gap.timestamp === 12345, 'timestamp is preserved');
}

{
  const gap = buildDelegationGap({
    signal: { action: 'SELL' },
    tradeExecuted: false,
    reason: 'REJECTED: Order rejected',
  });
  assert(gap.category === 'execution_failure', `execution failure category captured (got ${gap.category})`);
}

{
  const noneGap = buildDelegationGap({
    signal: null,
    tradeExecuted: false,
    reason: 'SKIP: No signal generated this cycle',
  });
  assert(noneGap === null, 'no delegation gap for missing signal');
}

{
  const executedGap = buildDelegationGap({
    signal: { action: 'BUY' },
    tradeExecuted: true,
    reason: null,
  });
  assert(executedGap === null, 'no delegation gap for executed trade');
}

assert(classifyDelegationGapReason('SKIP: Duplicate candle') === 'data_guard', 'duplicate candle maps to data_guard');
assert(classifyDelegationGapReason('SKIP: high spread') === 'market_condition', 'spread maps to market_condition');
assert(classifyDelegationGapReason('something surprising') === 'unknown', 'unmatched reason maps to unknown');

console.log(`\nTests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
