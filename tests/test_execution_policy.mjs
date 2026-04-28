import { buildExecutionPolicy } from '../lib/execution_policy.js';
import { calculatePositionSize } from '../lib/execution.js';

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

console.log('\n── Passive execution policy mapping ──');

{
  const policy = buildExecutionPolicy('APPROVED', 'NORMAL', 12345);
  assert(policy.decision === 'ALLOW', 'APPROVED maps to ALLOW');
  assert(policy.source === 'risk', 'source is risk');
  assert(policy.originalRiskDecision === 'APPROVED', 'original risk decision is preserved');
  assert(policy.reason === null, 'ALLOW policy has no blocking reason');
  assert(policy.timestamp === 12345, 'timestamp is preserved');
  assert(policy.riskMultiplier === 1.0, 'NORMAL keeps full risk multiplier');
}

{
  const policy = buildExecutionPolicy('APPROVED', 'VOLATILE', 12345);
  assert(policy.decision === 'LIMIT', 'APPROVED + VOLATILE maps to LIMIT');
  assert(policy.riskMultiplier === 0.5, 'VOLATILE halves risk multiplier');
}

{
  const policy = buildExecutionPolicy('APPROVED', 'EXTREME', 12345);
  assert(policy.decision === 'LIMIT', 'APPROVED + EXTREME maps to LIMIT');
  assert(policy.riskMultiplier === 0.25, 'EXTREME quarters risk multiplier');
}

for (const riskDecision of [
  'SKIP: No signal generated this cycle',
  'PAUSE: BUY cooldown after stop loss',
  'STOP: daily loss limit reached',
  'DISABLE: Equity drawdown reached limit',
]) {
  const policy = buildExecutionPolicy(riskDecision, 67890);
  assert(policy.decision === 'BLOCK', `${riskDecision.split(':')[0]} maps to BLOCK`);
  assert(policy.originalRiskDecision === riskDecision, 'BLOCK preserves original risk decision');
  assert(policy.reason === riskDecision, 'BLOCK reason mirrors original risk decision');
  assert(policy.riskMultiplier === null, 'BLOCK policy has no sizing multiplier');
}

console.log('\n── Policy multiplier sizing effect ──');

{
  const full = calculatePositionSize(3672.5, 25, 2000, 10000, buildExecutionPolicy('APPROVED', 'NORMAL').riskMultiplier);
  const volatile = calculatePositionSize(3672.5, 25, 2000, 10000, buildExecutionPolicy('APPROVED', 'VOLATILE').riskMultiplier);
  const extreme = calculatePositionSize(3672.5, 25, 2000, 10000, buildExecutionPolicy('APPROVED', 'EXTREME').riskMultiplier);

  assert(full.size === 0.8, `NORMAL keeps full size (got ${full.size})`);
  assert(volatile.size === 0.4, `VOLATILE halves size (got ${volatile.size})`);
  assert(extreme.size === 0.2, `EXTREME quarters size (got ${extreme.size})`);
}

console.log(`\nTests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
