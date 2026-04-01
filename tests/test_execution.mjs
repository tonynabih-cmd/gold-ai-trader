// tests/test_execution.mjs — Unit tests for lib/execution.js (offline functions only)
// Run: node tests/test_execution.mjs
// 
// Tests calculatePositionSize and extractBestEffortFilledSize only — other functions
// require live network access.

import { calculatePositionSize, extractBestEffortFilledSize } from '../lib/execution.js';

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

section('Risk target: 0.5% of AED balance');
{
  // balanceAED=3672.5 AED = 1000 USD
  // 0.5% of 1000 USD = $5 risk
  // With $10 stop distance: size = $5 / $10 = 0.5 oz
  const balanceAED     = 3672.5;
  const stopDistUSD    = 10.0;
  const currentPrUSD   = 2000;
  const availMarginAED = 10000;  // plenty of margin

  const r = calculatePositionSize(balanceAED, stopDistUSD, currentPrUSD, availMarginAED);

  if (!r.error && r.size > 0) {
    const expectedRiskUSD = (balanceAED / USD_AED) * 0.005;
    const actualRisk      = r.actualRiskDollars;
    const diff            = Math.abs(actualRisk - expectedRiskUSD);
    assert(diff < 1.0, `Risk ≈ 0.5% of balance (expected ~$${expectedRiskUSD.toFixed(2)}, got $${actualRisk.toFixed(2)})`);
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

// ── Section 5: Hard cap of 1% of balance ──────────────────────────────────────

section('Hard cap: even MIN_SIZE must not risk > 1% balance');
{
  // Balance = 100 AED = ~$27.2, 1% = $0.27
  // Min size = 0.01 oz. With stop=$10: risk = $0.01 × $10 = $0.10 ← OK, < $0.27
  // With stop=$50: risk = $0.01 × $50 = $0.50 > $0.27 → should reject
  const r = calculatePositionSize(100, 50, 2000, 1000);
  // Either size=0 (error) or size=0.01 but risk check rejects it
  assert(r.size === 0 || (r.actualRiskDollars <= (100 / USD_AED) * 0.01),
    `Risk capped at 1% of balance for small accounts`);
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

// ── Section 8: extractBestEffortFilledSize — happy paths ─────────────────────

section('extractBestEffortFilledSize: standard affectedDeals');
{
  // Standard Capital.com response with affectedDeals
  const r = extractBestEffortFilledSize({ affectedDeals: [{ size: 0.5 }] });
  assert(r.filledSize === 0.5, `Single deal size=0.5 → filledSize=0.5 (got ${r.filledSize})`);
  assert(r.source === 'affectedDeals', `source=affectedDeals (got ${r.source})`);
  assert(r.warnings.length === 0, `No warnings for clean response`);

  // Multiple deals summed
  const r2 = extractBestEffortFilledSize({ affectedDeals: [{ size: 0.3 }, { size: 0.2 }] });
  assert(Math.abs(r2.filledSize - 0.5) < 0.0001, `Multiple deals summed to 0.5 (got ${r2.filledSize})`);

  // dealSize variant
  const r3 = extractBestEffortFilledSize({ affectedDeals: [{ dealSize: 0.1 }] });
  assert(r3.filledSize === 0.1, `dealSize field accepted (got ${r3.filledSize})`);

  // filledSize variant
  const r4 = extractBestEffortFilledSize({ affectedDeals: [{ filledSize: 0.25 }] });
  assert(r4.filledSize === 0.25, `filledSize field accepted (got ${r4.filledSize})`);
}

section('extractBestEffortFilledSize: top-level fallbacks');
{
  // No affectedDeals, but top-level size
  const r = extractBestEffortFilledSize({ dealStatus: 'ACCEPTED', size: 0.5 });
  assert(r.filledSize === 0.5, `Top-level size fallback works (got ${r.filledSize})`);
  assert(r.source === 'topLevel', `source=topLevel (got ${r.source})`);
  assert(r.warnings.length > 0, `Warning emitted for fallback`);

  // Top-level dealSize
  const r2 = extractBestEffortFilledSize({ dealSize: 0.3 });
  assert(r2.filledSize === 0.3, `Top-level dealSize fallback (got ${r2.filledSize})`);

  // Top-level filledSize
  const r3 = extractBestEffortFilledSize({ filledSize: 0.1 });
  assert(r3.filledSize === 0.1, `Top-level filledSize fallback (got ${r3.filledSize})`);
}

// ── Section 9: extractBestEffortFilledSize — degraded/missing fields ─────────

section('extractBestEffortFilledSize: missing or null fields return null without throwing');
{
  // Null input
  const r1 = extractBestEffortFilledSize(null);
  assert(r1.filledSize === null, `null input → filledSize=null (not thrown)`);
  assert(r1.warnings.length > 0, `Warnings present for null input`);

  // Undefined input
  const r2 = extractBestEffortFilledSize(undefined);
  assert(r2.filledSize === null, `undefined input → filledSize=null (not thrown)`);

  // Empty object
  const r3 = extractBestEffortFilledSize({});
  assert(r3.filledSize === null, `Empty object → filledSize=null`);

  // affectedDeals present but all entries have invalid sizes
  const r4 = extractBestEffortFilledSize({ affectedDeals: [{ size: 'bad' }, { size: -1 }] });
  assert(r4.filledSize === null, `All-invalid affectedDeals → filledSize=null (not thrown)`);
  assert(r4.warnings.length > 0, `Warnings present for invalid deals`);

  // affectedDeals is not an array
  const r5 = extractBestEffortFilledSize({ affectedDeals: 'not-an-array' });
  assert(r5.filledSize === null, `affectedDeals non-array → filledSize=null (not thrown)`);

  // Zero-size deal
  const r6 = extractBestEffortFilledSize({ affectedDeals: [{ size: 0 }] });
  assert(r6.filledSize === null, `Zero-size deal → falls through to null (not thrown)`);

  // Top-level zero (explicit check of boundary for topSz > 0)
  const r7 = extractBestEffortFilledSize({ size: 0 });
  assert(r7.filledSize === null, `Top-level size=0 → filledSize=null (not thrown)`);
}

section('extractBestEffortFilledSize: mixed valid/invalid deals in affectedDeals');
{
  // One valid, one invalid — valid one should still be summed
  const r = extractBestEffortFilledSize({ affectedDeals: [{ size: 0.5 }, { size: 'bad' }] });
  assert(r.filledSize === 0.5, `Partial valid deals summed (got ${r.filledSize})`);
  assert(r.warnings.length > 0, `Warning for skipped invalid deal`);
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(60)}\n`);

if (failed > 0) process.exit(1);
