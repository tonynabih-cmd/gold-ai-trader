// tests/test_execution.mjs — Unit tests for lib/execution.js (offline functions only)
// Run: node tests/test_execution.mjs
// 
// Tests offline execution helpers only — live broker calls are not exercised here.

import {
  calculatePositionSize,
  calculateScaleOutManagementPlan,
  calculateProgressiveStopPlan,
  createTradePathAudit,
  updateTradePathAudit,
  recordStopMoveAuditEvent,
  buildExitAudit,
  calculateFillSlippage,
  assessExecutionQuality
} from '../lib/execution.js';

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

section('Slippage gate: maxSlippage priority (snapshot.maxSlippage → maxExecutionSlippage → base fallback)');
{
  // Helper mirrors the logic from placeTrade
  function checkSlippage(snapshot, entryPrice, currentMarketPrice) {
    const maxSlippage = parseFloat(snapshot.maxSlippage ?? snapshot.maxExecutionSlippage) || 4.0;
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

  // fallback 4.0 when neither field present
  const r5 = checkSlippage({}, 2000, 2002.9);
  assert(r5.maxSlippage === 4.0, `fallback maxSlippage=4.0 when snapshot has no slippage fields`);
  assert(!r5.skip, `expectedSlippage=2.9 ≤ fallback 4.0 → do NOT skip`);

  const r6 = checkSlippage({}, 2000, 2004.1);
  assert(r6.skip, `expectedSlippage=4.1 > fallback 4.0 → skip`);

  // Works for SELL direction (negative price difference)
  const r7 = checkSlippage({ maxSlippage: 2.0 }, 2000, 1998.0);
  assert(!r7.skip, `SELL: expectedSlippage=2.0 (abs) ≤ maxSlippage=2.0 → do NOT skip`);

  const r8 = checkSlippage({ maxSlippage: 2.0 }, 2000, 1997.5);
  assert(r8.skip, `SELL: expectedSlippage=2.5 (abs) > maxSlippage=2.0 → skip`);
}

section('Passive fill slippage telemetry');
{
  const good = calculateFillSlippage(2000, 2000.20, 5);
  assert(good.absoluteSlippage === 0.2, `GOOD absolute slippage recorded (got ${good.absoluteSlippage})`);
  assert(good.slippageToATR === 0.04, `GOOD slippage/ATR recorded (got ${good.slippageToATR})`);
  assert(good.fillQuality === 'GOOD', `0.04 ATR slippage → GOOD (got ${good.fillQuality})`);

  const acceptable = calculateFillSlippage(2000, 2000.50, 5);
  assert(acceptable.fillQuality === 'ACCEPTABLE', `0.10 ATR slippage → ACCEPTABLE (got ${acceptable.fillQuality})`);

  const degraded = calculateFillSlippage(2000, 2001, 5);
  assert(degraded.fillQuality === 'DEGRADED', `0.20 ATR slippage → DEGRADED (got ${degraded.fillQuality})`);

  const unknown = calculateFillSlippage(2000, NaN, 5);
  assert(unknown.fillQuality === 'UNKNOWN', `missing fill price → UNKNOWN (got ${unknown.fillQuality})`);
  assert(unknown.absoluteSlippage === null, 'UNKNOWN telemetry does not synthesize slippage');
}

section('Execution quality scoring');
{
  const good = assessExecutionQuality({
    spread: 0.2,
    maxSpread: 0.8,
    slippage: 0.25,
    slippageLimit: 4,
    minStopDist: 0.5,
    atr: 5,
  });
  assert(good.score >= 85 && good.grade === 'GOOD', `Clean execution conditions score GOOD (got ${good.score}/${good.grade})`);

  const degraded = assessExecutionQuality({
    spread: 0.75,
    maxSpread: 0.8,
    slippage: 3.5,
    slippageLimit: 4,
    minStopDist: 10,
    atr: 5,
  });
  assert(degraded.score < 70 && degraded.grade === 'DEGRADED', `Crowded execution conditions score DEGRADED (got ${degraded.score}/${degraded.grade})`);
}

// ── Section 9: Progressive stop locking (R-multiple) ───────────────────────

section('Progressive stop locking: BUY thresholds');
{
  const trade = { action: 'BUY', entry: 2000, stopLoss: 1990, initialStopLoss: 1990 };

  const r1 = calculateProgressiveStopPlan(trade, { bid: 2010, offer: 2010.5 }, { minStopDistance: 0.5 });
  assert(r1.shouldModify, 'BUY: 1.0R profit should schedule an SL update');
  assert(r1.stopLevel === 2000, `BUY: 1.0R profit moves SL to break-even (got ${r1.stopLevel})`);
  assert(r1.lockedR === 0 && r1.triggerR === 1, `BUY: 1.0R stage selected (got trigger=${r1.triggerR}, lock=${r1.lockedR})`);

  const r15 = calculateProgressiveStopPlan(trade, { bid: 2015, offer: 2015.5 }, { minStopDistance: 0.5 });
  assert(r15.shouldModify, 'BUY: 1.5R profit should schedule an SL update');
  assert(r15.stopLevel === 2005, `BUY: 1.5R profit locks 0.5R (got ${r15.stopLevel})`);
  assert(r15.lockedR === 0.5 && r15.triggerR === 1.5, `BUY: 1.5R stage selected (got trigger=${r15.triggerR}, lock=${r15.lockedR})`);

  const r2 = calculateProgressiveStopPlan(trade, { bid: 2020, offer: 2020.5 }, { minStopDistance: 0.5 });
  assert(r2.shouldModify, 'BUY: 2.0R profit should schedule an SL update');
  assert(r2.stopLevel === 2010, `BUY: 2.0R profit locks 1.0R (got ${r2.stopLevel})`);
  assert(r2.lockedR === 1 && r2.triggerR === 2, `BUY: highest eligible stage wins at 2.0R (got trigger=${r2.triggerR}, lock=${r2.lockedR})`);
}

section('Progressive stop locking: SELL thresholds');
{
  const trade = { action: 'SELL', entry: 2000, stopLoss: 2010, initialStopLoss: 2010 };

  const r15 = calculateProgressiveStopPlan(trade, { bid: 1984.5, offer: 1985 }, { minStopDistance: 0.5 });
  assert(r15.shouldModify, 'SELL: 1.5R profit should schedule an SL update');
  assert(r15.stopLevel === 1995, `SELL: 1.5R profit locks 0.5R (got ${r15.stopLevel})`);

  const r2 = calculateProgressiveStopPlan(trade, { bid: 1979.5, offer: 1980 }, { minStopDistance: 0.5 });
  assert(r2.shouldModify, 'SELL: 2.0R profit should schedule an SL update');
  assert(r2.stopLevel === 1990, `SELL: 2.0R profit locks 1.0R (got ${r2.stopLevel})`);
}

section('Progressive stop locking: safety guards');
{
  const noBackward = calculateProgressiveStopPlan(
    { action: 'BUY', entry: 2000, stopLoss: 2012, initialStopLoss: 1990 },
    { bid: 2020, offer: 2020.5 },
    { minStopDistance: 0.5 }
  );
  assert(!noBackward.shouldModify && noBackward.reason === 'STOP_NOT_BETTER', `BUY: never move SL backwards (got ${noBackward.reason})`);

  const minDistanceBlocked = calculateProgressiveStopPlan(
    { action: 'BUY', entry: 2000, stopLoss: 1999.4, initialStopLoss: 1999.4 },
    { bid: 2000.6, offer: 2001.1 },
    { minStopDistance: 0.7 }
  );
  assert(!minDistanceBlocked.shouldModify && minDistanceBlocked.reason === 'BROKER_MIN_DISTANCE', `Broker min stop distance blocks too-close updates (got ${minDistanceBlocked.reason})`);

  const inferRiskFromCurrentStop = calculateProgressiveStopPlan(
    { action: 'BUY', entry: 2000, stopLoss: 1990 },
    { bid: 2015, offer: 2015.5 },
    { minStopDistance: 0.5 }
  );
  assert(inferRiskFromCurrentStop.shouldModify, 'Current stop can stand in for initial stop while still on the risk side');
  assert(inferRiskFromCurrentStop.riskSource === 'currentStopLoss', `Risk source falls back to current stop (got ${inferRiskFromCurrentStop.riskSource})`);

  const unknownInitialRisk = calculateProgressiveStopPlan(
    { action: 'BUY', entry: 2000, stopLoss: 2001 },
    { bid: 2015, offer: 2015.5 },
    { minStopDistance: 0.5 }
  );
  assert(!unknownInitialRisk.shouldModify && unknownInitialRisk.reason === 'UNKNOWN_INITIAL_RISK', `Moved stop without recorded initial risk is skipped safely (got ${unknownInitialRisk.reason})`);
}

section('v1.6 scale-out management plan');
{
  const baseTrade = {
    action: 'BUY',
    entry: 2000,
    stopLoss: 1990,
    initialStopLoss: 1990,
    initialSize: 0.10,
    size: 0.10,
    atr: 5,
    managementState: 'OPEN_FULL',
  };

  const tp1 = calculateScaleOutManagementPlan(baseTrade, { bid: 2006, offer: 2006.5 }, { minStopDistance: 0.5 });
  assert(tp1.shouldManage && tp1.actionType === 'PARTIAL_CLOSE', `0.6R schedules TP1 partial close (got ${tp1.actionType}/${tp1.reason})`);
  assert(tp1.closeSize === 0.04, `TP1 closes 40% of initial 0.10 size (got ${tp1.closeSize})`);
  assert(tp1.stopLevel === 1997.5, `TP1 protection moves stop to -0.25R (got ${tp1.stopLevel})`);
  assert(tp1.nextState === 'TP1_FILLED', `TP1 next state is TP1_FILLED (got ${tp1.nextState})`);

  const be = calculateScaleOutManagementPlan(
    { ...baseTrade, size: 0.06, partial1Filled: true, managementState: 'TP1_FILLED', stopLoss: 1997.5 },
    { bid: 2009, offer: 2009.5 },
    { minStopDistance: 0.5 }
  );
  assert(be.shouldManage && be.actionType === 'MODIFY_STOP', `0.9R after TP1 schedules BE stop (got ${be.actionType}/${be.reason})`);
  assert(be.stopLevel === 2000.5, `BE stop includes spread buffer (got ${be.stopLevel})`);
  assert(be.nextState === 'BE_ARMED', `BE next state is BE_ARMED (got ${be.nextState})`);

  const tp2 = calculateScaleOutManagementPlan(
    { ...baseTrade, size: 0.06, partial1Filled: true, managementState: 'BE_ARMED', stopLoss: 2000.5 },
    { bid: 2012, offer: 2012.5 },
    { minStopDistance: 0.5 }
  );
  assert(tp2.shouldManage && tp2.actionType === 'PARTIAL_CLOSE', `1.2R schedules TP2 partial close (got ${tp2.actionType}/${tp2.reason})`);
  assert(tp2.closeSize === 0.03, `TP2 closes 35% rounded down while preserving runner (got ${tp2.closeSize})`);
  assert(tp2.stopLevel === 2003.5, `TP2 locks +0.35R stop (got ${tp2.stopLevel})`);

  const trail = calculateScaleOutManagementPlan(
    { ...baseTrade, size: 0.03, partial1Filled: true, partial2Filled: true, managementState: 'TP2_FILLED', stopLoss: 2003.5 },
    { bid: 2016, offer: 2016.5 },
    { minStopDistance: 0.5 }
  );
  assert(trail.shouldManage && trail.stageKey === 'atr_trail_after_1_5r', `1.5R schedules ATR runner trail (got ${trail.stageKey}/${trail.reason})`);
  assert(trail.stopLevel === 2012, `0.8 ATR runner trail sets stop at 2012 (got ${trail.stopLevel})`);
}

// ── Section 10: Passive trade-path audit telemetry ───────────────────────────

section('Trade-path audit telemetry: milestones and excursions');
{
  const trade = {
    action: 'BUY',
    entry: 2000,
    stopLoss: 1990,
    initialStopLoss: 1990,
    takeProfit: 2025,
    size: 0.1,
  };
  trade.audit = createTradePathAudit(trade);

  assert(trade.audit.initialRiskDistance === 10, `Audit initial risk distance recorded (got ${trade.audit.initialRiskDistance})`);
  assert(trade.audit.initialTpR === 2.5, `Audit initial TP R recorded (got ${trade.audit.initialTpR})`);

  updateTradePathAudit(trade, { bid: 2012, offer: 2012.5 }, 123);
  assert(trade.audit.mfePriceDistance === 12, `BUY audit MFE price distance updates (got ${trade.audit.mfePriceDistance})`);
  assert(trade.audit.mfeR === 1.2, `BUY audit MFE R updates (got ${trade.audit.mfeR})`);
  assert(trade.audit.reached1R && trade.audit.reached1_2R, 'BUY audit records 1R and 1.2R milestones');
  assert(trade.audit.firstReached1RAt === 123 && trade.audit.firstReached1_2RAt === 123, 'BUY audit stores first milestone timestamps');

  updateTradePathAudit(trade, { bid: 2025, offer: 2025.5 }, 345);
  assert(trade.audit.reached2R && trade.audit.reached2_5R, 'BUY audit records 2R and 2.5R milestones');
  assert(trade.audit.firstReached2RAt === 345 && trade.audit.firstReached2_5RAt === 345, 'BUY audit stores first 2R/2.5R timestamps');

  updateTradePathAudit(trade, { bid: 1994, offer: 1994.5 }, 456);
  assert(trade.audit.maePriceDistance === 6, `BUY audit MAE price distance updates (got ${trade.audit.maePriceDistance})`);
  assert(trade.audit.maeR === 0.6, `BUY audit MAE R updates (got ${trade.audit.maeR})`);
}

section('Trade-path audit telemetry: stop events and exit audit');
{
  const trade = {
    action: 'SELL',
    entry: 2000,
    stopLoss: 2010,
    initialStopLoss: 2010,
    takeProfit: 1975,
    size: 0.1,
  };
  trade.audit = createTradePathAudit(trade);
  updateTradePathAudit(trade, { bid: 1984.5, offer: 1985 }, 789);

  const plan = calculateProgressiveStopPlan(trade, { bid: 1984.5, offer: 1985 }, { minStopDistance: 0.5 });
  const event = recordStopMoveAuditEvent(trade, plan, 900);
  assert(trade.audit.stopWasMoved && trade.audit.stopMoveCount === 1, 'Stop move audit event is recorded only when called');
  assert(event.stageKey === 'lock_0_5r_at_1_5r', `Stop move audit stores stage key (got ${event.stageKey})`);

  const exitAudit = buildExitAudit(trade, 9.18);
  assert(exitAudit.realizedR > 2.4 && exitAudit.realizedR < 2.6, `Exit audit realized R uses AED conversion (got ${exitAudit.realizedR})`);
  assert(exitAudit.exitReasonClass === 'TAKE_PROFIT', `Exit audit classifies near-TP exits (got ${exitAudit.exitReasonClass})`);
  assert(exitAudit.postTradeReasonTags.includes('TAKE_PROFIT'), `Exit audit tags post-trade reason (got ${exitAudit.postTradeReasonTags.join(',')})`);
  assert(exitAudit.gaveBackFromMfeR >= 0, `Exit audit gave-back field is numeric (got ${exitAudit.gaveBackFromMfeR})`);

  const unknownExit = buildExitAudit(trade, null);
  assert(unknownExit.realizedPnl === null && unknownExit.realizedR === null, 'Exit audit preserves null P&L as unknown telemetry');
  assert(unknownExit.exitReasonClass === 'UNKNOWN', `Null P&L exit remains UNKNOWN (got ${unknownExit.exitReasonClass})`);
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(60)}\n`);

if (failed > 0) process.exit(1);
