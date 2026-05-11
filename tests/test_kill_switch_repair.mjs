import { checkRisk } from '../lib/risk.js';
import { KILL_SWITCH_POLICY, parseActivatedAtMs, repairExpiredKillSwitch } from '../lib/kill_switch.js';

let passed = 0;
let failed = 0;
const ALLOWED_NOW = new Date('2026-05-04T12:30:00.000Z');

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  OK ${message}`);
  } else {
    failed++;
    console.error(`  FAIL ${message}`);
  }
}

function makeState(overrides = {}) {
  return {
    botEnabled: true,
    stateIntegrityOk: true,
    criticalFailure: false,
    riskDataFresh: true,
    lastRiskSyncAt: Date.now(),
    balance: 1000,
    equity: 1000,
    availableMargin: 1000,
    peakBalance: 1000,
    dailyLoss: 0,
    openTrades: [],
    recentTradeIds: [],
    recentOutcomes: [],
    expectancyKillSwitch: {
      active: true,
      mode: 'RECOVERY',
      activatedAt: Date.now() - KILL_SWITCH_POLICY.expiryMs - 1000,
      activationTrend: 'DOWN',
      windowKey: null,
      suppressedWindowKey: null,
    },
    ...overrides,
  };
}

function makeIndicators(overrides = {}) {
  return {
    atr: 5,
    atrAverage: 5,
    spread: 0.2,
    currEMA20: 2000,
    currEMA50: 2005,
    trend1h: 'DOWN',
    ...overrides,
  };
}

function makeSignal(overrides = {}) {
  const ts = Date.now();
  return {
    id: `${ts}_SELL_test`,
    action: 'SELL',
    entryType: 'pullback',
    entryPrice: 1995,
    stopLoss: 2002.5,
    takeProfit: 1976.25,
    score: 80,
    setupConfidenceScore: 80,
    timestamp: ts,
    ...overrides,
  };
}

function makePfWindowOutcomes(windowSuffix = 'A', baseTime = Date.now() - 5 * 60 * 60 * 1000) {
  return [
    { pnl: 0.03, action: 'SELL', exitReason: 'NON_LOSS', closedAt: baseTime + 0, dealId: `PF_${windowSuffix}_1` },
    { pnl: -1.73, action: 'SELL', exitReason: 'STOP_LOSS', closedAt: baseTime + 1, dealId: `PF_${windowSuffix}_2` },
    { pnl: -1.72, action: 'SELL', exitReason: 'STOP_LOSS', closedAt: baseTime + 2, dealId: `PF_${windowSuffix}_3` },
    { pnl: 3.71, action: 'SELL', exitReason: 'NON_LOSS', closedAt: baseTime + 3, dealId: `PF_${windowSuffix}_4` },
    { pnl: -2.78, action: 'SELL', exitReason: 'STOP_LOSS', closedAt: baseTime + 4, dealId: `PF_${windowSuffix}_5` },
  ];
}

process.env.BOT_ENABLED = 'true';
process.env.MAX_SPREAD = '0.5';

console.log('\nKill switch repair');

{
  const iso = new Date(Date.now() - KILL_SWITCH_POLICY.expiryMs - 1000).toISOString();
  const state = makeState({ expectancyKillSwitch: { active: true, mode: 'RECOVERY', activatedAt: iso, windowKey: 'w1' } });
  const result = repairExpiredKillSwitch(state, Date.now());
  assert(result.repaired === true, 'ISO activatedAt older than 24h repairs');
  assert(state.expectancyKillSwitch.active === false, 'ISO repair clears active');
  assert(state.expectancyKillSwitch.resetReason === '24H_EXPIRED', 'ISO repair uses 24H_EXPIRED reason');
}

{
  const ms = Date.now() - KILL_SWITCH_POLICY.expiryMs - 1000;
  const state = makeState({ expectancyKillSwitch: { active: true, mode: 'RECOVERY', activatedAt: ms, windowKey: 'w2' } });
  const result = repairExpiredKillSwitch(state, Date.now());
  assert(result.repaired === true, 'ms activatedAt older than 24h repairs');
}

{
  const sec = Math.floor((Date.now() - KILL_SWITCH_POLICY.expiryMs - 1000) / 1000);
  const state = makeState({ expectancyKillSwitch: { active: true, mode: 'RECOVERY', activatedAt: sec, windowKey: 'w3' } });
  const result = repairExpiredKillSwitch(state, Date.now());
  assert(result.repaired === true, 'seconds activatedAt older than 24h repairs');
}

{
  const state = makeState({ expectancyKillSwitch: { active: true, mode: 'RECOVERY', activatedAt: 'not-a-time', windowKey: 'w4' } });
  const result = repairExpiredKillSwitch(state, Date.now());
  assert(result.repaired === true, 'invalid activatedAt repairs instead of indefinite freeze');
  assert(state.expectancyKillSwitch.resetReason === 'INVALID_ACTIVATED_AT_REPAIRED', 'invalid timestamp uses explicit repair reason');
}

{
  const outcomes = makePfWindowOutcomes('SAME');
  const state = makeState({
    expectancyKillSwitch: {
      active: false,
      mode: null,
      activatedAt: 0,
      windowKey: 'PF_SAME_1|PF_SAME_2|PF_SAME_3|PF_SAME_4|PF_SAME_5',
      suppressedWindowKey: 'PF_SAME_1|PF_SAME_2|PF_SAME_3|PF_SAME_4|PF_SAME_5',
    },
    recentOutcomes: outcomes,
  });
  const result = checkRisk(makeSignal(), state, makeIndicators(), { now: ALLOWED_NOW });
  assert(result === 'APPROVED', `same stale PF5 window does not instantly reactivate (got: ${result})`);
  assert(state.expectancyKillSwitch.active === false, 'same stale window keeps kill switch inactive');
}

{
  const outcomes = makePfWindowOutcomes('NEW');
  const state = makeState({
    expectancyKillSwitch: {
      active: false,
      mode: null,
      activatedAt: 0,
      windowKey: null,
      suppressedWindowKey: 'PF_OLD_1|PF_OLD_2|PF_OLD_3|PF_OLD_4|PF_OLD_5',
    },
    recentOutcomes: outcomes,
  });
  const result = checkRisk(makeSignal(), state, makeIndicators(), { now: ALLOWED_NOW });
  assert(result === 'APPROVED', `new PF5 window can reactivate recovery mode without blocking entry strategy (got: ${result})`);
  assert(state.expectancyKillSwitch.active === true, 'new PF5 window reactivates kill switch state');
}

{
  const parsedIso = parseActivatedAtMs('2026-05-01T00:00:00.000Z');
  const parsedMs = parseActivatedAtMs(String(Date.now() - 1000));
  const parsedSec = parseActivatedAtMs(String(Math.floor((Date.now() - 1000) / 1000)));
  assert(Number.isFinite(parsedIso) && parsedIso > 0, 'ISO parser returns ms timestamp');
  assert(Number.isFinite(parsedMs) && parsedMs > 0, 'numeric ms string parser returns ms timestamp');
  assert(Number.isFinite(parsedSec) && parsedSec > 0, 'numeric sec string parser returns ms timestamp');
}

console.log(`\nTests: ${passed + failed} total, ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
