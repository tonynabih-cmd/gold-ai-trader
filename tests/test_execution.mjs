// tests/test_execution.mjs — Unit tests for lib/execution.js (offline functions only)
// Run: node tests/test_execution.mjs
// 
// Tests calculatePositionSize only — other functions require live network access.

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

function section(name) {
  console.log(`\n── ${name} ──`);
}

// AED/USD peg constant (same as execution.js)
const USD_AED = 3.6725;

// ── Section 1: Input validation ───────────────────────────────────────────────

section('Input validation');
{
  const r1 = calculatePositionSize(0, 10, 2000, 1000);
  assert(r1.size === 0 && r1.error, `Zero balance → error (got: ${r1.error})`);

  const r2 = calculatePositionSize(-100, 10, 2000, 1000);
  assert(r2.size === 0 && r2.error, `Negative balance → error`);

  const r3 = calculatePositionSize(1000, 0, 2000, 1000);
  assert(r3.size === 0 && r3.error, `Zero stop distance → error`);

  const r4 = calculatePositionSize(1000, 10, 0, 1000);
  assert(r4.size === 0 && r4.error, `Zero current price → error`);

  const r5 = calculatePositionSize(NaN, 10, 2000, 1000);
  assert(r5.size === 0 && r5.error, `NaN balance → error`);
}

// ── Section 2: Minimum stop distance enforcement ──────────────────────────────

section('Minimum stop distance ($0.50)');
{
  // Stop distance < $0.50 would create giant positions; must be rejected
  const r = calculatePositionSize(1000, 0.10, 2000, 1000);
  assert(r.size === 0 && r.error, `Stop < $0.50 → error (got: ${r.error})`);
  assert(r.error.includes('minimum'), `Error mentions minimum (got: ${r.error})`);
}

// ── Section 3: Risk amount is 0.5% of balance ────────────────────────────────

section('Risk target: 2% of AED balance');
{
  // balanceAED=3672.5 AED = 1000 USD
  // 2% of 1000 USD = $20 risk target
  // With $25 stop distance: size = $20 / $25 = 0.80 oz (below MAX_SIZE=1.0 oz cap)
  // actualRisk = 0.80 × $25 = $20 ≈ 2% of balance
  const balanceAED     = 3672.5;
  const stopDistUSD    = 25.0;
  const currentPrUSD   = 2000;
  const availMarginAED = 10000;  // plenty of margin

  const r = calculatePositionSize(balanceAED, stopDistUSD, currentPrUSD, availMarginAED);

  if (!r.error && r.size > 0) {
    const expectedRiskUSD = (balanceAED / USD_AED) * 0.02;
    const actualRisk      = r.actualRiskDollars;
    const diff            = Math.abs(actualRisk - expectedRiskUSD);
    assert(diff < 1.0, `Risk ≈ 2% of balance (expected ~$${expectedRiskUSD.toFixed(2)}, got $${actualRisk.toFixed(2)})`);
    assert(r.size >= 0.01, `Position size >= min (0.01 oz), got ${r.size}`);
    assert(r.size <= 1.0, `Position size <= max (1.0 oz), got ${r.size}`);
  } else {
    assert(false, `Sizing failed unexpectedly: ${r.error}`);
  }
}

// ── Section 4: Hard caps ──────────────────────────────────────────────────────

section('Hard caps: MIN_SIZE=0.01 oz, MAX_SIZE=1.0 oz');
{
  // Very large balance → risk would imply size > 1 oz, but must be capped at 1.0
  const r1 = calculatePositionSize(1_000_000, 5, 2000, 500_000);
  if (!r1.error) {
    assert(r1.size <= 1.0, `Large balance capped at MAX_SIZE=1.0 oz (got ${r1.size})`);
  }

  // Very tiny balance → risk implies size < 0.01, floored at MIN_SIZE
  // But might also fail the 1% cap check if min size risk > 1% balance
  const r2 = calculatePositionSize(10, 5, 2000, 100);
  if (!r2.error) {
    assert(r2.size >= 0.01, `Min size floor applied (got ${r2.size})`);
  }
  // (may error due to 1% cap with small balance — that's correct behavior)
}

// ── Section 5: Hard cap of 3% of balance ──────────────────────────────────────

section('Hard cap: even MIN_SIZE must not risk > 3% balance');
{
  // Balance = 100 AED = ~$27.2, hard cap 3% = ~$0.82
  // Min size = 0.01 oz. With stop=$100: risk = $0.01 × $100 = $1.00 > $0.82 → should reject
  const r = calculatePositionSize(100, 100, 2000, 1000);
  assert(r.size === 0 && r.error, `MIN_SIZE with stop=$100 exceeds 3% of balance → rejected`);
}

// ── Section 6: Margin buffer check ───────────────────────────────────────────

section('Margin buffer: 1.5× required margin');
{
  // Very low available margin → should reject
  const r = calculatePositionSize(5000, 10, 2000, 1);  // 1 AED available
  assert(r.size === 0 && r.error, `Insufficient margin → error (got: ${r.error})`);
  assert(r.error.includes('margin') || r.error.includes('Margin'), `Error mentions margin (got: ${r.error})`);
}

// ── Section 7: Return structure ───────────────────────────────────────────────

section('Return structure for successful sizing');
{
  const r = calculatePositionSize(3672.5, 10, 2000, 5000);

  if (!r.error && r.size > 0) {
    assert(typeof r.size            === 'number', 'size is a number');
    assert(typeof r.actualRiskDollars === 'number', 'actualRiskDollars is a number');
    assert(typeof r.actualRiskAED   === 'number', 'actualRiskAED is a number');
    assert(typeof r.notionalValue   === 'number', 'notionalValue is a number');
    assert(typeof r.marginRequired  === 'number', 'marginRequired is a number');
    assert(r.leverage               === 20,       'leverage is 20 for GOLD');
    assert(r.marginRate             === 0.05,     'marginRate is 0.05 (5%)');
    assert(r.error                  === null,     'error is null on success');

    // Verify notional = size × price
    const expectedNotional = r.size * 2000;
    assert(Math.abs(r.notionalValue - expectedNotional) < 0.01,
      `notionalValue = size × price (${r.notionalValue.toFixed(2)} ≈ ${expectedNotional.toFixed(2)})`);

    // Verify margin = notional × 5% × USD/AED
    const expectedMarginAED = r.notionalValue * 0.05 * USD_AED;
    assert(Math.abs(r.marginRequired - expectedMarginAED) < 1,
      `marginRequired = notional × 5% × USD_AED (${r.marginRequired.toFixed(2)} ≈ ${expectedMarginAED.toFixed(2)})`);
  }
}

// ── Section 8: Slippage gate logic ───────────────────────────────────────────

section('Slippage gate: maxSlippage priority (snapshot.maxSlippage → maxExecutionSlippage → 3.0)');
{
  // Helper mirrors the logic from placeTrade
  function checkSlippage(snapshot, entryPrice, currentMarketPrice) {
    const maxSlippage = parseFloat(snapshot.maxSlippage ?? snapshot.maxExecutionSlippage) || 3.0;
    const expectedSlippage = Math.abs(currentMarketPrice - entryPrice);
    return { expectedSlippage, maxSlippage, skip: expectedSlippage > maxSlippage };
  }

  // snapshot.maxSlippage takes priority
  const r1 = checkSlippage({ maxSlippage: 2.0, maxExecutionSlippage: 5.0 }, 2000, 2001.5);
  assert(r1.maxSlippage === 2.0, `maxSlippage=2.0 takes priority over maxExecutionSlippage`);
  assert(!r1.skip, `expectedSlippage=1.5 ≤ maxSlippage=2.0 → do NOT skip`);

  const r2 = checkSlippage({ maxSlippage: 2.0 }, 2000, 2002.5);
  assert(r2.skip, `expectedSlippage=2.5 > maxSlippage=2.0 → skip`);

  // snapshot.maxExecutionSlippage as fallback when maxSlippage absent
  const r3 = checkSlippage({ maxExecutionSlippage: 1.5 }, 2000, 2001.0);
  assert(r3.maxSlippage === 1.5, `maxExecutionSlippage=1.5 used when maxSlippage absent`);
  assert(!r3.skip, `expectedSlippage=1.0 ≤ maxExecutionSlippage=1.5 → do NOT skip`);

  const r4 = checkSlippage({ maxExecutionSlippage: 1.5 }, 2000, 2002.0);
  assert(r4.skip, `expectedSlippage=2.0 > maxExecutionSlippage=1.5 → skip`);

  // fallback 3.0 when neither field present
  const r5 = checkSlippage({}, 2000, 2002.9);
  assert(r5.maxSlippage === 3.0, `fallback maxSlippage=3.0 when snapshot has no slippage fields`);
  assert(!r5.skip, `expectedSlippage=2.9 ≤ fallback 3.0 → do NOT skip`);

  const r6 = checkSlippage({}, 2000, 2003.1);
  assert(r6.skip, `expectedSlippage=3.1 > fallback 3.0 → skip`);

  // Works for SELL direction (negative price difference)
  const r7 = checkSlippage({ maxSlippage: 2.0 }, 2000, 1998.0);
  assert(!r7.skip, `SELL: expectedSlippage=2.0 (abs) ≤ maxSlippage=2.0 → do NOT skip`);

  const r8 = checkSlippage({ maxSlippage: 2.0 }, 2000, 1997.5);
  assert(r8.skip, `SELL: expectedSlippage=2.5 (abs) > maxSlippage=2.0 → skip`);
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(60)}\n`);

if (failed > 0) process.exit(1);
