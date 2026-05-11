// tests/test_risk.mjs — Unit tests for lib/risk.js
// Run: node tests/test_risk.mjs

import {
  checkRisk as checkRiskImpl,
  HIGH_QUALITY_OVERRIDE_RR_THRESHOLD,
  HIGH_QUALITY_OVERRIDE_SCORE_THRESHOLD,
  MIN_RR_V2,
  SETUP_CONFIDENCE_MIN_V2,
} from '../lib/risk.js';
import { buildExecutionPolicy } from '../lib/execution_policy.js';
import { classifyTradingSession } from '../lib/session_filter.js';

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

const ALLOWED_NOW = new Date('2026-05-04T12:30:00.000Z');

function checkRisk(signal, botState, indicators, options = {}) {
  return checkRiskImpl(signal, botState, indicators, { now: ALLOWED_NOW, ...options });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Mirrors risk.js trading-hours rules exactly (Rule 3 + Rule 4 + Rule 5)
// so time-dependent tests know whether to expect rule-5-style SKIP or the rule's own result.
function isTradingHours() {
  const now  = new Date();
  const hour = now.getUTCHours();
  const min  = now.getUTCMinutes();
  const day  = now.getUTCDay();
  if (day === 0 || day === 6) return false;                           // weekend
  if (day === 5 && (hour > 16 || (hour === 16 && min > 5))) return false; // Friday close
  if (hour < 7 || hour > 18 || (hour === 18 && min > 5)) return false;   // outside session
  return true;
}

function makeSignal(overrides = {}) {
  return {
    action:     'BUY',
    entryPrice: 2000,
    stopLoss:   1990,
    takeProfit: 2030,
    score:      80,
    setupConfidenceScore: 80,
    id:         'test_signal_123',
    ...overrides,
  };
}

function makeBotState(overrides = {}) {
  return {
    botEnabled:        true,
    stateIntegrityOk:  true,
    criticalFailure:   false,
    riskDataFresh:     true,
    lastRiskSyncAt:    Date.now(),
    balance:           1000,
    equity:            1000,
    availableMargin:   800,
    peakBalance:       1000,
    dailyLoss:         0,
    dailyTrades:       0,
    openTrades:        [],
    recentTradeIds:    [],
    recentOrderKeys:   [],
    recentOutcomes:    [],
    lastOrderTimestamp: 0,
    brokerTotalTrades: 0,
    brokerGrossProfit: 0,
    brokerGrossLoss:   0,
    ...overrides,
  };
}

function makeIndicators(overrides = {}) {
  return {
    atr:          5.0,
    atrAverage:   4.5,
    spread:       0.30,
    currEMA20:    2000,
    currEMA50:    1995,
    prevEMA20:    1998,
    prevEMA50:    1996,
    slopePercent: 0.20,
    ...overrides,
  };
}

function makeActiveExpectancyKillState(overrides = {}) {
  return makeBotState({
    expectancyKillSwitch: {
      active: true,
      activatedAt: Date.now() - (6 * 60 * 60 * 1000) - 1000,
      activationTrend: 'UP',
      windowKey: 'pf-window',
      suppressedWindowKey: null,
    },
    ...overrides,
  });
}

function makeLowPf5Outcomes() {
  const base = ALLOWED_NOW.getTime() - 3 * 24 * 60 * 60 * 1000;
  return [
    { pnl: 0.03, action: 'SELL', exitReason: 'NON_LOSS', closedAt: base, dealId: 'PF5_A' },
    { pnl: -1.73, action: 'SELL', exitReason: 'STOP_LOSS', closedAt: base + 5 * 60 * 1000, dealId: 'PF5_B' },
    { pnl: -1.72, action: 'SELL', exitReason: 'STOP_LOSS', closedAt: base + 10 * 60 * 1000, dealId: 'PF5_C' },
    { pnl: 3.71, action: 'SELL', exitReason: 'NON_LOSS', closedAt: base + 15 * 60 * 1000, dealId: 'PF5_D' },
    { pnl: -2.78, action: 'SELL', exitReason: 'STOP_LOSS', closedAt: base + 20 * 60 * 1000, dealId: 'PF5_E' },
  ];
}

function makeWindowKey(outcomes) {
  return outcomes.map(o => o.dealId || `${o.action}:${o.closedAt}:${o.pnl}`).join('|');
}

// ── Pre-setup: ensure required env vars are set ───────────────────────────────
process.env.BOT_ENABLED = 'true';
process.env.MAX_SPREAD  = '0.5';

// ── Section 1: Environment kill switch ────────────────────────────────────────

section('Rule 1: Environment kill switch');
{
  const origBotEnabled = process.env.BOT_ENABLED;
  process.env.BOT_ENABLED = 'false';
  const result = checkRisk(makeSignal(), makeBotState(), makeIndicators());
  assert(result.includes('SKIP'), `BOT_ENABLED=false → SKIP (got: ${result})`);
  process.env.BOT_ENABLED = origBotEnabled;
}

// ── Section 2: State kill switches ───────────────────────────────────────────

section('Rules 2/2A/2B: State kill switches');
{
  const r2 = checkRisk(makeSignal(), makeBotState({ botEnabled: false }), makeIndicators());
  assert(r2.includes('SKIP'), `botEnabled=false → SKIP (got: ${r2})`);

  const r2a = checkRisk(makeSignal(), makeBotState({ stateIntegrityOk: false }), makeIndicators());
  assert(r2a.includes('STOP'), `stateIntegrityOk=false → STOP (got: ${r2a})`);

  const r2b = checkRisk(makeSignal(), makeBotState({ criticalFailure: true }), makeIndicators());
  assert(r2b.includes('STOP'), `criticalFailure=true → STOP (got: ${r2b})`);
}

// ── Section 3: Risk data freshness ────────────────────────────────────────────

section('Rule 2C: Risk data freshness');
{
  const rStale = checkRisk(makeSignal(), makeBotState({ riskDataFresh: false }), makeIndicators());
  assert(rStale.includes('STOP'), `riskDataFresh=false → STOP (got: ${rStale})`);

  const rExpired = checkRisk(makeSignal(), makeBotState({ lastRiskSyncAt: Date.now() - 7 * 60 * 1000 }), makeIndicators());
  assert(rExpired.includes('STOP'), `Risk data expired (>6 min) → STOP (got: ${rExpired})`);
}

// ── Section 4: Weekend / trading hours ────────────────────────────────────────

section('Rules 3/4/5: Weekend and trading hours');
{
  assert(classifyTradingSession(new Date('2026-05-04T07:00:00.000Z')).isAllowedSession === true, '07:00 UTC allowed');
  assert(classifyTradingSession(new Date('2026-05-04T10:30:00.000Z')).isAllowedSession === true, '10:30 UTC allowed');
  assert(classifyTradingSession(new Date('2026-05-04T10:31:00.000Z')).isAllowedSession === false, '10:31 UTC blocked');
  assert(classifyTradingSession(new Date('2026-05-04T12:30:00.000Z')).isAllowedSession === true, '12:30 UTC allowed');
  assert(classifyTradingSession(new Date('2026-05-04T16:00:00.000Z')).isAllowedSession === true, '16:00 UTC allowed');
  assert(classifyTradingSession(new Date('2026-05-04T18:00:00.000Z')).isAllowedSession === true, '18:00 UTC allowed');
  assert(classifyTradingSession(new Date('2026-05-04T18:01:00.000Z')).isAllowedSession === false, '18:01 UTC blocked');
  assert(classifyTradingSession(new Date('2026-05-04T22:00:00.000Z')).isAllowedSession === false, '22:00 UTC blocked');

  const allowed = checkRisk(makeSignal(), makeBotState(), makeIndicators(), { now: new Date('2026-05-04T07:00:00.000Z') });
  assert(allowed === 'APPROVED', `allowed session can approve otherwise valid signal (got: ${allowed})`);

  const blocked = checkRisk(makeSignal(), makeBotState(), makeIndicators(), { now: new Date('2026-05-04T10:31:00.000Z') });
  assert(blocked === 'SKIP: Outside allowed trading session', `blocked session gives clear reason (got: ${blocked})`);

  const rollover = checkRisk(makeSignal(), makeBotState(), makeIndicators(), { now: new Date('2026-05-04T22:00:00.000Z') });
  assert(rollover.includes('rollover protection'), `rollover protection gives clear reason (got: ${rollover})`);

  const marketClosed = classifyTradingSession(new Date('2026-05-02T22:00:00.000Z'), {
    marketClosedReason: 'MARKET_CLOSED: Gold weekend close (Saturday UTC)',
  });
  assert(marketClosed.sessionName === 'MARKET_CLOSED', `market-closed classification overrides session labels (got: ${marketClosed.sessionName})`);
  assert(marketClosed.sessionRejectReason === null, 'market-closed classification does not create session reject noise');

  const closedReason = 'MARKET_CLOSED: Gold weekend close (Saturday UTC)';
  const closedRisk = checkRisk(makeSignal(), makeBotState(), makeIndicators(), {
    now: new Date('2026-05-02T22:00:00.000Z'),
    marketClosedReason: closedReason,
  });
  assert(closedRisk === closedReason, `market-closed reason remains primary if risk is called (got: ${closedRisk})`);
}

section('Market regime entry filter');
{
  const deadByRatio = checkRisk(makeSignal(), makeBotState(), makeIndicators({
    atr: 0.59,
    atrAverage: 1.0,
    currEMA20: 2001,
    currEMA50: 2000,
  }));
  assert(deadByRatio === 'SKIP: Market regime DEAD blocks new entries', `DEAD blocks new entries (got: ${deadByRatio})`);

  const sideways = checkRisk(makeSignal(), makeBotState(), makeIndicators({
    atr: 1.0,
    atrAverage: 1.0,
    currEMA20: 2000.13,
    currEMA50: 2000,
  }));
  assert(sideways === 'SKIP: Market regime SIDEWAYS blocks new entries', `SIDEWAYS blocks new entries (got: ${sideways})`);

  const extreme = checkRisk(makeSignal(), makeBotState(), makeIndicators({
    atr: 2.61,
    atrAverage: 1.0,
    currEMA20: 2003,
    currEMA50: 2000,
  }));
  assert(extreme === 'SKIP: Market regime EXTREME blocks new entries', `EXTREME blocks new entries (got: ${extreme})`);

  const normal = checkRisk(makeSignal(), makeBotState(), makeIndicators({
    atr: 1.0,
    atrAverage: 1.0,
    currEMA20: 2001,
    currEMA50: 2000,
  }));
  assert(normal === 'APPROVED', `NORMAL allows next checks (got: ${normal})`);

  const active = checkRisk(makeSignal(), makeBotState(), makeIndicators({
    atr: 1.5,
    atrAverage: 1.0,
    currEMA20: 2002,
    currEMA50: 2000,
  }));
  assert(active === 'APPROVED', `ACTIVE allows next checks (got: ${active})`);
}

// ── Section 5: Signal validation ─────────────────────────────────────────────

section('Rules 6/7/8: Signal validation');
{
  const rNoSignal = checkRisk(null, makeBotState(), makeIndicators());
  assert(rNoSignal.includes('SKIP'), `null signal → SKIP (got: ${rNoSignal})`);

  const rNaN = checkRisk(makeSignal({ entryPrice: NaN }), makeBotState(), makeIndicators());
  assert(rNaN.includes('SKIP'), `NaN entryPrice → SKIP (got: ${rNaN})`);

  const rBadAction = checkRisk(makeSignal({ action: 'HOLD' }), makeBotState(), makeIndicators());
  assert(rBadAction.includes('SKIP'), `Invalid action → SKIP (got: ${rBadAction})`);

  const rBuySlAbove = checkRisk(
    makeSignal({ action: 'BUY', stopLoss: 2010 }),  // SL above entry
    makeBotState(), makeIndicators()
  );
  assert(rBuySlAbove.includes('SKIP'), `BUY SL above entry → SKIP (got: ${rBuySlAbove})`);

  const rSellSlBelow = checkRisk(
    makeSignal({ action: 'SELL', stopLoss: 1990 }),  // SL below entry
    makeBotState(), makeIndicators()
  );
  assert(rSellSlBelow.includes('SKIP'), `SELL SL below entry → SKIP (got: ${rSellSlBelow})`);
}

// ── Section 6: ATR pullback extension guard ───────────────────────────────────

section('Rule 5E: ATR pullback extension guard');
{
  const extendedPullback = checkRisk(
    makeSignal({ entryType: 'pullback', entryPrice: 1980, stopLoss: 1970, takeProfit: 2030 }),
    makeBotState(),
    makeIndicators({ currEMA20: 2000, atr: 5 })
  );
  assert(extendedPullback.includes('Pullback entry extended'), `extended pullback → SKIP (got: ${extendedPullback})`);

  const extendedNonPullback = checkRisk(
    makeSignal({ entryType: 'crossover', entryPrice: 1980, stopLoss: 1970, takeProfit: 2030 }),
    makeBotState(),
    makeIndicators({ currEMA20: 2000, atr: 5 })
  );
  assert(extendedNonPullback === 'APPROVED', `non-pullback is not blocked by extension guard (got: ${extendedNonPullback})`);
}

// ── Section 7: Spread check ───────────────────────────────────────────────────

section('Rule 11: Spread check');
{
  const rHighSpread = checkRisk(makeSignal(), makeBotState(), makeIndicators({ spread: 1.50 }));
  assert(rHighSpread.includes('SKIP'), `Spread too high → SKIP (got: ${rHighSpread})`);

  const rNaNSpread = checkRisk(makeSignal(), makeBotState(), makeIndicators({ spread: NaN }));
  assert(rNaNSpread.includes('SKIP'), `NaN spread → SKIP (got: ${rNaNSpread})`);

  const rNullSpread = checkRisk(makeSignal(), makeBotState(), makeIndicators({ spread: null }));
  assert(rNullSpread.includes('SKIP'), `null spread → SKIP (got: ${rNullSpread})`);
}

// ── Section 8: Daily trade cap ────────────────────────────────────────────────

section('Rule 12: Daily trade cap');
{
  const rDailyMax = checkRisk(makeSignal(), makeBotState({ dailyTrades: 10 }), makeIndicators());
  assert(rDailyMax.includes('SKIP'), `10 daily trades → SKIP (got: ${rDailyMax})`);
}

// ── Section 9: Anti-chop loss streak ─────────────────────────────────────────

section('Rule 12A: Anti-chop loss streak');
{
  // Mixed-direction losses do not activate the same-direction circuit.
  const mixedDirectionLosses = [
    { pnl: -5, action: 'BUY',  closedAt: Date.now() - 1000 },
    { pnl: -3, action: 'SELL', closedAt: Date.now() - 500 },
  ];
  const rMixedLosses = checkRisk(makeSignal(), makeBotState({ recentOutcomes: mixedDirectionLosses }), makeIndicators());
  assert(rMixedLosses === 'APPROVED', `mixed-direction losses do not block same-direction circuit (got: ${rMixedLosses})`);

  // Two same-direction losses activate the same-direction circuit.
  const sameDirectionLosses = [
    { pnl: -5, action: 'BUY', closedAt: Date.now() - 1000 },
    { pnl: -3, action: 'BUY', closedAt: Date.now() - 500 },
  ];
  const rSameDirectionLosses = checkRisk(makeSignal(), makeBotState({ recentOutcomes: sameDirectionLosses }), makeIndicators());
  assert(rSameDirectionLosses.includes('circuit breaker active'), `2 same-direction losses → circuit block (got: ${rSameDirectionLosses})`);

  // Two losses but LAST ONE is > 30 mins ago → NOT blocked
  const oldLosses = [
    { pnl: -5, action: 'BUY',  closedAt: Date.now() - 40 * 60 * 1000 },
    { pnl: -3, action: 'SELL', closedAt: Date.now() - 35 * 60 * 1000 },
  ];
  const rOldLosses = checkRisk(makeSignal(), makeBotState({ recentOutcomes: oldLosses }), makeIndicators());
  assert(!rOldLosses.includes('Anti-chop'), `Old losses (35m+ ago) do NOT trigger anti-chop (got: ${rOldLosses})`);

  // A WIN followed by a loss → only 1 loss in last 3 → should NOT block
  const recentOutcomesWithWin = [
    { pnl: -5, action: 'BUY',  closedAt: Date.now() - 3000 },  // loss (old)
    { pnl:  8, action: 'SELL', closedAt: Date.now() - 2000 },  // WIN — resets streak
    { pnl: -2, action: 'BUY',  closedAt: Date.now() - 1000 },  // loss (1 in last 3)
  ];
  const rAfterWin = checkRisk(makeSignal(), makeBotState({ recentOutcomes: recentOutcomesWithWin }), makeIndicators());
  // Only 1 of the last 3 is a loss → anti-chop should NOT fire
  assert(!rAfterWin.includes('Anti-chop'), `Win in recent outcomes — anti-chop does NOT fire (got: ${rAfterWin})`);
}

// ── Section 10: Daily loss limit ──────────────────────────────────────────────

section('Rule 13: Daily loss limit (5% of balance)');
{
  // 5% of 1000 = 50 AED; use 51 to exceed the limit
  const rDailyLoss = checkRisk(makeSignal(), makeBotState({ dailyLoss: 51, balance: 1000 }), makeIndicators());
  assert(rDailyLoss.includes('STOP'), `Daily loss at 5% limit → STOP (got: ${rDailyLoss})`);
}

// ── Section 11: Equity drawdown hard stop ─────────────────────────────────────

section('Rule 14: Equity drawdown hard stop (20%)');
{
  // Peak=1000, equity=799 → drawdown=20.1% → should disable
  const rDrawdown = checkRisk(makeSignal(), makeBotState({ peakBalance: 1000, equity: 799 }), makeIndicators());
  assert(rDrawdown.includes('DISABLE'), `20%+ drawdown → DISABLE (got: ${rDrawdown})`);
}

// ── Section 12: Insufficient balance ─────────────────────────────────────────

section('Rule 16: Insufficient balance');
{
  const rNoBalance = checkRisk(makeSignal(), makeBotState({ balance: 0 }), makeIndicators());
  assert(rNoBalance.includes('SKIP'), `Zero balance → SKIP (got: ${rNoBalance})`);

  const rLowBalance = checkRisk(makeSignal(), makeBotState({ balance: 50 }), makeIndicators());
  assert(rLowBalance.includes('SKIP'), `Balance < 80 AED → SKIP (got: ${rLowBalance})`);
}

// ── Section 13: Opening order rate cap ───────────────────────────────────────

section('Rule 8A: Opening order rate cap');
{
  const rOrderRateCap = checkRisk(
    makeSignal(),
    makeBotState({ recentOrderTimestamps: [Date.now() - 1000, Date.now() - 2000] }),
    makeIndicators()
  );
  assert(rOrderRateCap.includes('Order rate cap reached'), `2 recent opening orders inside 60s → SKIP (got: ${rOrderRateCap})`);
}

// ── Section 14: Max open positions ────────────────────────────────────────────

section('Rule 18: Max 2 open positions');
{
  const openTrades = [
    { dealReference: 'R1', action: 'BUY',  size: 0.01, entry: 2000 },
    { dealReference: 'R2', action: 'SELL', size: 0.01, entry: 2000 },
  ];
  const rMaxPositions = checkRisk(makeSignal(), makeBotState({ openTrades }), makeIndicators());
  assert(rMaxPositions.includes('SKIP'), `2 open positions → SKIP (got: ${rMaxPositions})`);
}

// ── Section 15: Duplicate trade ID ────────────────────────────────────────────

section('Rule 19: Duplicate trade ID');
{
  const signal = makeSignal({ id: 'KNOWN_SIGNAL' });
  const rDup = checkRisk(signal, makeBotState({ recentTradeIds: ['KNOWN_SIGNAL'] }), makeIndicators());
  assert(rDup.includes('SKIP'), `Duplicate signal ID → SKIP (got: ${rDup})`);
}

section('PF kill switch dominance');
{
  const result = checkRisk(
    makeSignal({ takeProfit: 2020, setupConfidenceScore: 65 }),
    makeBotState({
      expectancyKillSwitch: {
        active: true,
        activatedAt: Date.now() - 10 * 60 * 1000,
        activationTrend: 'UP',
        windowKey: 'pf-window',
        suppressedWindowKey: null,
      },
    }),
    makeIndicators({ trend1h: 'UP' })
  );
  assert(result === 'APPROVED', `PF5 recovery mode allows reduced-risk continuation when quality passes (got: ${result})`);
}

section('PF5 kill switch activation and 24h expiry');
{
  const outcomes = makeLowPf5Outcomes();
  const activationState = makeBotState({ recentOutcomes: outcomes });
  checkRisk(makeSignal(), activationState, makeIndicators());
  assert(activationState.expectancyKillSwitch?.active === true, 'PF5 kill switch activates when PF5 is below 0.70');
  assert(activationState.expectancyKillSwitch?.activatedAt === ALLOWED_NOW.getTime(), 'PF5 kill switch sets activatedAt on inactive→active transition');

  const existingActivatedAt = ALLOWED_NOW.getTime() - (2 * 60 * 60 * 1000);
  const stableState = makeBotState({
    recentOutcomes: outcomes,
    expectancyKillSwitch: {
      active: true,
      mode: 'RECOVERY',
      activatedAt: existingActivatedAt,
      activationTrend: 'UP',
      windowKey: makeWindowKey(outcomes),
      suppressedWindowKey: null,
    },
  });
  checkRisk(makeSignal(), stableState, makeIndicators({ trend1h: 'UP' }));
  assert(stableState.expectancyKillSwitch.activatedAt === existingActivatedAt, 'PF5 kill switch does not refresh activatedAt while already active');

  const oldActivatedAt = ALLOWED_NOW.getTime() - (24 * 60 * 60 * 1000) - 1000;
  const expiredState = makeBotState({
    recentOutcomes: outcomes,
    expectancyKillSwitch: {
      active: true,
      mode: 'RECOVERY',
      activatedAt: oldActivatedAt,
      activationTrend: 'UP',
      windowKey: makeWindowKey(outcomes),
      suppressedWindowKey: null,
    },
  });
  const expiredResult = checkRisk(makeSignal(), expiredState, makeIndicators({ trend1h: 'UP' }));
  assert(expiredState.expectancyKillSwitch.active === false, 'PF5 kill switch force-resets after 24h');
  assert(expiredState.expectancyKillSwitch.resetReason === '24H_EXPIRED', `PF5 kill switch 24h reset reason is 24H_EXPIRED (got: ${expiredState.expectancyKillSwitch.resetReason})`);
  assert(expiredResult === 'APPROVED', `24h expiry releases the PF5 trade block for normal risk checks (got: ${expiredResult})`);
}

section('High-quality override gate');
{
  assert(HIGH_QUALITY_OVERRIDE_SCORE_THRESHOLD === 70, `override score threshold is 70 (got: ${HIGH_QUALITY_OVERRIDE_SCORE_THRESHOLD})`);
  assert(HIGH_QUALITY_OVERRIDE_RR_THRESHOLD === 1.8, `override RR threshold is 1.8 (got: ${HIGH_QUALITY_OVERRIDE_RR_THRESHOLD})`);

  const highQualitySignal = makeSignal({ setupConfidenceScore: 70, score: 70, takeProfit: 2025 });
  const highQualityResult = checkRisk(highQualitySignal, makeActiveExpectancyKillState(), makeIndicators());
  assert(highQualityResult === 'APPROVED', `high-quality override clears PF pause only when safety gates pass (got: ${highQualityResult})`);
  assert(highQualitySignal.highQualityOverride === true, 'highQualityOverride logs true for score 70 and v1.6 RR with safety gates passing');
  assert(highQualitySignal.highQualityOverrideReason === 'ALL_HIGH_QUALITY_SAFETY_GATES_PASSED', `highQualityOverrideReason logs pass reason (got: ${highQualitySignal.highQualityOverrideReason})`);

  const lowScoreSignal = makeSignal({ setupConfidenceScore: 69, score: 69, takeProfit: 2025 });
  const lowScoreResult = checkRisk(lowScoreSignal, makeActiveExpectancyKillState(), makeIndicators());
  assert(lowScoreResult === 'APPROVED', `score 69 can trade in recovery because recovery threshold is 65 (got: ${lowScoreResult})`);
  assert(lowScoreSignal.highQualityOverride === false && lowScoreSignal.highQualityOverrideReason.includes('SCORE_BELOW_70'), `score block is logged (got: ${lowScoreSignal.highQualityOverrideReason})`);

  const lowRrSignal = makeSignal({ setupConfidenceScore: 80, takeProfit: 2017 });
  const lowRrResult = checkRisk(lowRrSignal, makeActiveExpectancyKillState(), makeIndicators());
  assert(lowRrResult.includes('below minimum 1.80R'), `RR below 1.8 remains blocked (got: ${lowRrResult})`);
  assert(lowRrSignal.highQualityOverride === false && lowRrSignal.highQualityOverrideReason.includes('RR_BELOW_OVERRIDE'), `RR block is logged (got: ${lowRrSignal.highQualityOverrideReason})`);

  const hardStopSignal = makeSignal({ setupConfidenceScore: 80, takeProfit: 2025 });
  const hardStopResult = checkRisk(hardStopSignal, makeBotState({ criticalFailure: true }), makeIndicators());
  assert(hardStopResult.includes('Critical failure active'), `override does not bypass hard kill stop (got: ${hardStopResult})`);
  assert(hardStopSignal.highQualityOverride === false && hardStopSignal.highQualityOverrideReason === 'KILL_SWITCH_HARD_STOP_ACTIVE', `hard stop override reason logs (got: ${hardStopSignal.highQualityOverrideReason})`);

  const dailyLossSignal = makeSignal({ setupConfidenceScore: 80, takeProfit: 2025 });
  const dailyLossResult = checkRisk(dailyLossSignal, makeBotState({ dailyLoss: 51, balance: 1000 }), makeIndicators());
  assert(dailyLossResult.includes('daily loss limit'), `override does not bypass daily loss stop (got: ${dailyLossResult})`);
  assert(dailyLossSignal.highQualityOverride === false && dailyLossSignal.highQualityOverrideReason.includes('DAILY_LOSS_STOP_ACTIVE'), `daily loss override reason logs (got: ${dailyLossSignal.highQualityOverrideReason})`);

  const staleDataSignal = makeSignal({ setupConfidenceScore: 80, takeProfit: 2025 });
  const staleDataResult = checkRisk(staleDataSignal, makeBotState({ riskDataFresh: false }), makeIndicators());
  assert(staleDataResult.includes('Risk data stale'), `override does not bypass stale data (got: ${staleDataResult})`);
  assert(staleDataSignal.highQualityOverride === false && staleDataSignal.highQualityOverrideReason === 'DATA_FRESHNESS_BLOCKED', `stale data override reason logs (got: ${staleDataSignal.highQualityOverrideReason})`);

  const spreadSignal = makeSignal({ setupConfidenceScore: 80, takeProfit: 2025 });
  const spreadResult = checkRisk(spreadSignal, makeBotState(), makeIndicators({ spread: 1.50 }));
  assert(spreadResult.includes('high spread'), `override does not bypass spread block (got: ${spreadResult})`);
  assert(spreadSignal.highQualityOverride === false && spreadSignal.highQualityOverrideReason.includes('SPREAD_FILTER_BLOCKED'), `spread override reason logs (got: ${spreadSignal.highQualityOverrideReason})`);

  const integritySignal = makeSignal({ setupConfidenceScore: 80, takeProfit: 2025 });
  const integrityResult = checkRisk(integritySignal, makeBotState({ stateIntegrityOk: false }), makeIndicators());
  assert(integrityResult.includes('State integrity compromised'), `override does not bypass state integrity failure (got: ${integrityResult})`);
  assert(integritySignal.highQualityOverride === false && integritySignal.highQualityOverrideReason === 'STATE_INTEGRITY_ISSUE', `state integrity override reason logs (got: ${integritySignal.highQualityOverrideReason})`);
}

section('Same-direction pullback clustering');
{
  const blockedSignal = makeSignal({ entryType: 'pullback' });
  const blocked = checkRisk(
    blockedSignal,
    makeBotState({ openTrades: [{ action: 'BUY', entryType: 'pullback', entry: 2000, audit: { reached1R: false } }] }),
    makeIndicators()
  );
  assert(blocked.includes('pullback clustering blocked'), `same-direction pullback without 1R proof blocks (got: ${blocked})`);
  assert(blockedSignal.sameDirectionOpenTrade === true, 'sameDirectionOpenTrade logs true when same-direction pullback is open');
  assert(blockedSignal.existingTradeReached1R === false, 'existingTradeReached1R logs false without proof');
  assert(blockedSignal.clusteringDecision === 'BLOCK', `clusteringDecision logs BLOCK (got: ${blockedSignal.clusteringDecision})`);

  const missingProofSignal = makeSignal({ entryType: 'pullback' });
  const missingProof = checkRisk(
    missingProofSignal,
    makeBotState({ openTrades: [{ action: 'BUY', entryType: 'pullback', entry: 2000 }] }),
    makeIndicators()
  );
  assert(missingProof.includes('pullback clustering blocked'), `missing reached1R proof blocks (got: ${missingProof})`);

  const allowedSignal = makeSignal({ entryType: 'pullback' });
  const allowed = checkRisk(
    allowedSignal,
    makeBotState({ openTrades: [{ action: 'BUY', entryType: 'pullback', entry: 2000, audit: { reached1R: true } }] }),
    makeIndicators()
  );
  assert(allowed === 'APPROVED', `same-direction pullback is allowed only after existing trade reached 1R (got: ${allowed})`);
  assert(allowedSignal.existingTradeReached1R === true, 'existingTradeReached1R logs true when proof exists');
  assert(allowedSignal.clusteringDecision === 'ALLOW', `clusteringDecision logs ALLOW (got: ${allowedSignal.clusteringDecision})`);

  const cappedSignal = makeSignal({ entryType: 'pullback' });
  const capped = checkRisk(
    cappedSignal,
    makeBotState({
      openTrades: [
        { action: 'BUY', entryType: 'pullback', entry: 2000, audit: { reached1R: true } },
        { action: 'SELL', entryType: 'pullback', entry: 1990, audit: { reached1R: true } },
      ],
    }),
    makeIndicators()
  );
  assert(capped.includes('Max 2 positions open'), `1R clustering allowance does not bypass max open positions (got: ${capped})`);
}

// ── Section 16: Signal score is telemetry, not a risk gate ───────────────────

section('Minimum setup confidence gate');
{
  assert(MIN_RR_V2 === 1.8, `MIN_RR_V2 is 1.8 (got: ${MIN_RR_V2})`);
  assert(SETUP_CONFIDENCE_MIN_V2 === 55, `SETUP_CONFIDENCE_MIN_V2 is 55 (got: ${SETUP_CONFIDENCE_MIN_V2})`);

  const rConfidence54 = checkRisk(makeSignal({ setupConfidenceScore: 54 }), makeBotState(), makeIndicators());
  assert(rConfidence54.includes('Setup confidence score 54.00 below minimum 55'), `Confidence 54 is blocked (got: ${rConfidence54})`);

  const rConfidence55 = checkRisk(makeSignal({ setupConfidenceScore: 55 }), makeBotState(), makeIndicators());
  assert(rConfidence55 === 'APPROVED', `Confidence 55 is allowed if all other conditions pass (got: ${rConfidence55})`);

  const rLowReward = checkRisk(makeSignal({ takeProfit: 2017.9 }), makeBotState(), makeIndicators());
  assert(rLowReward.includes('below minimum 1.80R'), `RR below 1.8 is blocked (got: ${rLowReward})`);

  const rBoundaryReward = checkRisk(makeSignal({ takeProfit: 2018 }), makeBotState(), makeIndicators());
  assert(rBoundaryReward === 'APPROVED', `RR 1.80 is allowed if all other conditions pass (got: ${rBoundaryReward})`);

  const allowedPolicy = buildExecutionPolicy(rConfidence55, 'NORMAL', 12345);
  assert(allowedPolicy.decision === 'ALLOW', `Execution policy reaches ALLOW only after all risk gates pass (got: ${allowedPolicy.decision})`);

  const lowConfidencePolicy = buildExecutionPolicy(rConfidence54, 'NORMAL', 12345);
  assert(lowConfidencePolicy.decision === 'BLOCK', `Execution policy blocks below-threshold confidence (got: ${lowConfidencePolicy.decision})`);

  const lowRewardPolicy = buildExecutionPolicy(rLowReward, 'NORMAL', 12345);
  assert(lowRewardPolicy.decision === 'BLOCK', `Execution policy blocks below-threshold RR (got: ${lowRewardPolicy.decision})`);
}

// ── Section 17: Approved path ─────────────────────────────────────────────────

section('Full approval path during golden hours');
{
  const result = checkRisk(makeSignal({ score: 3 }), makeBotState(), makeIndicators());
  assert(result === 'APPROVED', `All rules pass during allowed session → APPROVED (got: ${result})`);
}

// ── Section 18: Exception safety ─────────────────────────────────────────────

section('Exception safety');
{
  let threw = false;
  try {
    const result = checkRisk(undefined, undefined, undefined);
    assert(result.includes('SKIP') || result.includes('STOP'), `Undefined inputs → SKIP/STOP (no throw, got: ${result})`);
  } catch (_) {
    threw = true;
  }
  assert(!threw, 'checkRisk never throws — always returns string');
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(60)}\n`);

if (failed > 0) process.exit(1);
