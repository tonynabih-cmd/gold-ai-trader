import { computeTailLossStats } from '../lib/stats.js';

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

console.log('\n── Passive CVaR tail-loss stats ──');

{
  const stats = computeTailLossStats([10, 2, 0]);
  assert(stats.cvar95 === 0, `no losses cvar95=0 (got ${stats.cvar95})`);
  assert(stats.worstLoss === 0, `no losses worstLoss=0 (got ${stats.worstLoss})`);
  assert(stats.averageLoss === 0, `no losses averageLoss=0 (got ${stats.averageLoss})`);
  assert(stats.lossCount === 0, `no losses lossCount=0 (got ${stats.lossCount})`);
}

{
  const stats = computeTailLossStats([5, -7, 3]);
  assert(stats.cvar95 === -7, `one loss uses worst loss as CVaR95 (got ${stats.cvar95})`);
  assert(stats.worstLoss === -7, `one loss worstLoss=-7 (got ${stats.worstLoss})`);
  assert(stats.averageLoss === -7, `one loss averageLoss=-7 (got ${stats.averageLoss})`);
  assert(stats.lossCount === 1, `one loss lossCount=1 (got ${stats.lossCount})`);
}

{
  const stats = computeTailLossStats([-2, -5, -1, 3]);
  assert(stats.cvar95 === -5, `fewer than 5 losses uses worst loss as CVaR95 (got ${stats.cvar95})`);
  assert(stats.worstLoss === -5, `multiple losses worstLoss=-5 (got ${stats.worstLoss})`);
  assert(stats.averageLoss === -2.67, `multiple losses averageLoss rounded (got ${stats.averageLoss})`);
  assert(stats.lossCount === 3, `multiple losses lossCount=3 (got ${stats.lossCount})`);
}

{
  const losses = Array.from({ length: 20 }, (_, i) => -(i + 1));
  const stats = computeTailLossStats(losses);
  assert(stats.cvar95 === -20, `20 losses worst 5 percent uses worst 1 loss (got ${stats.cvar95})`);
  assert(stats.worstLoss === -20, `20 losses worstLoss=-20 (got ${stats.worstLoss})`);
}

{
  const losses = Array.from({ length: 100 }, (_, i) => -(i + 1));
  const stats = computeTailLossStats(losses);
  assert(stats.cvar95 === -98, `100 losses worst 5 percent averages worst 5 losses (got ${stats.cvar95})`);
  assert(stats.lossCount === 100, `100 losses lossCount=100 (got ${stats.lossCount})`);
}

console.log(`\nTests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
