// tests/test_expectancy_defense.mjs
// Focused coverage for expectancy-defense controls in lib/risk.js.

import { checkRisk as checkRiskImpl, resetDirectionalLossCircuitOnTrendReset } from '../lib/risk.js';

let passed = 0;
let failed = 0;
const ALLOWED_NOW = new Date('2026-05-04T12:30:00.000Z');

function checkRisk(signal, botState, indicators, options = {}) {
  return checkRiskImpl(signal, botState, indicators, { now: ALLOWED_NOW, ...options });
}

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  OK ${message}`);
  } else {
    failed++;
    console.error(`  FAIL ${message}`);
  }
}

function makeSignal(overrides = {}) {
  const candleTime = Date.now();
  return {
    id: `${candleTime}_SELL_v1.5`,
    action: 'SELL',
    entryType: 'pullback',
    entryPrice: 1995,
    stopLoss: 2002.5,
    takeProfit: 1976.25,
    atr: 5,
    score: 80,
    setupConfidenceScore: 80,
    timestamp: candleTime,
    ...overrides,
  };
}

function makeBotState(overrides = {}) {
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
    directionalLossCircuit: {
      BUY: { active: false, activatedAt: 0, resetTrend: 'UP' },
      SELL: { active: false, activatedAt: 0, resetTrend: 'DOWN' },
    },
    ...overrides,
  };
}

function makeIndicators(overrides = {}) {
  return {
    atr: 5,
    atrAverage: 5,
    spread: 0.3,
    currEMA20: 2000,
    currEMA50: 2005,
    trend1h: 'DOWN',
    ...overrides,
  };
}

function makeLowPf5Outcomes() {
  const base = Date.now() - 3 * 24 * 60 * 60 * 1000;
  return [
    { pnl: 0.03, action: 'SELL', exitReason: 'NON_LOSS', closedAt: base, dealId: 'PF5_A' },
    { pnl: -1.73, action: 'SELL', exitReason: 'STOP_LOSS', closedAt: base + 5 * 60 * 1000, dealId: 'PF5_B' },
    { pnl: -1.72, action: 'SELL', exitReason: 'STOP_LOSS', closedAt: base + 10 * 60 * 1000, dealId: 'PF5_C' },
    { pnl: 3.71, action: 'SELL', exitReason: 'NON_LOSS', closedAt: base + 15 * 60 * 1000, dealId: 'PF5_D' },
    { pnl: -2.78, action: 'SELL', exitReason: 'STOP_LOSS', closedAt: base + 20 * 60 * 1000, dealId: 'PF5_E' },
  ];
}

function makeWindowKey(outcomes) {
  return outcomes.map(o => o.dealId || o.ref || `${o.action}:${o.closedAt}:${o.pnl}`).join('|');
}

process.env.BOT_ENABLED = 'true';
process.env.MAX_SPREAD = '0.5';

console.log('\nExpectancy-defense controls');

{
  const closedAt = Date.now() - 60 * 1000;
  const closedCandleTime = Math.floor(closedAt / (5 * 60 * 1000)) * (5 * 60 * 1000);
  const signal = makeSignal({ id: `${Date.now()}_SELL_v1.5` });
  const result = checkRisk(
    signal,
    makeBotState({ recentOutcomes: [{ pnl: -2, action: 'SELL', exitReason: 'STOP_LOSS', closedAt, closedCandleTime }] }),
    makeIndicators()
  );
  assert(result.includes('cooldown after stop loss'), `same-direction 3-candle cooldown fires (got: ${result})`);
}

{
  const result = checkRisk(
    makeSignal(),
    makeBotState({
      recentOutcomes: [
        { pnl: -2, action: 'SELL', exitReason: 'STOP_LOSS', closedAt: Date.now() - 40 * 60 * 1000 },
        { pnl: -3, action: 'SELL', exitReason: 'STOP_LOSS', closedAt: Date.now() - 30 * 60 * 1000 },
      ],
    }),
    makeIndicators()
  );
  assert(result.includes('circuit breaker active'), `2 same-direction stop losses pause trading (got: ${result})`);
}

{
  const state = makeBotState({
    directionalLossCircuit: {
      BUY: { active: false, activatedAt: 0, resetTrend: 'UP' },
      SELL: { active: true, activatedAt: Date.now(), resetTrend: 'DOWN' },
    },
  });
  const changed = resetDirectionalLossCircuitOnTrendReset(state, makeIndicators({ trend1h: 'UP' }));
  assert(changed === true && state.directionalLossCircuit.SELL.active === false, '1h trend reset clears SELL circuit');
}

{
  const result = checkRisk(
    makeSignal(),
    makeBotState({ openTrades: [{ action: 'SELL', entryType: 'pullback', entry: 1998, size: 0.1 }] }),
    makeIndicators()
  );
  assert(result.includes('pullback clustering blocked'), `same-direction open pullback blocks cluster entry (got: ${result})`);
}

{
  const result = checkRisk(
    makeSignal({ entryPrice: 1980, stopLoss: 1987.5, takeProfit: 1961.25 }),
    makeBotState(),
    makeIndicators({ currEMA20: 2000, atr: 5 })
  );
  assert(result.includes('extended 4.00 ATR'), `3.99/4.00 ATR chase is blocked (got: ${result})`);
}

{
  const state = makeBotState({
    recentOutcomes: [
      { pnl: -2.5, action: 'SELL', exitReason: 'STOP_LOSS', closedAt: Date.now() - 50 * 60 * 1000 },
      { pnl: 0.27, action: 'SELL', exitReason: 'NON_LOSS', closedAt: Date.now() - 40 * 60 * 1000 },
      { pnl: -4, action: 'SELL', exitReason: 'STOP_LOSS', closedAt: Date.now() - 30 * 60 * 1000 },
      { pnl: -1.94, action: 'SELL', exitReason: 'STOP_LOSS', closedAt: Date.now() - 20 * 60 * 1000 },
      { pnl: 0.37, action: 'SELL', exitReason: 'NON_LOSS', closedAt: Date.now() - 10 * 60 * 1000 },
    ],
  });
  const result = checkRisk(makeSignal(), state, makeIndicators());
  assert(result.includes('Rolling 5-trade profit factor'), `PF5 < 0.7 disables entries (got: ${result})`);
  assert(state.expectancyKillSwitch.active === true, 'PF5 kill switch records a pause state');
  const changed = resetDirectionalLossCircuitOnTrendReset(state, makeIndicators({ trend1h: 'UP' }));
  assert(changed === true && state.expectancyKillSwitch.active === false, 'PF5 kill switch resets on 1h trend reset');
}

{
  const state = makeBotState({
    expectancyKillSwitch: {
      active: true,
      activatedAt: Date.now() - 10 * 60 * 1000,
      activationTrend: null,
      windowKey: 'legacy-window',
      suppressedWindowKey: null,
    },
  });

  const pauseResult = checkRisk(makeSignal(), state, makeIndicators({ trend1h: 'DOWN' }));
  assert(pauseResult.includes('kill switch active'), `PF5 kill switch with missing activation trend still pauses (got: ${pauseResult})`);
  assert(state.expectancyKillSwitch.active === true && state.expectancyKillSwitch.activationTrend === 'DOWN', 'PF5 kill switch learns valid activation trend before reset');

  const unchanged = resetDirectionalLossCircuitOnTrendReset(state, makeIndicators({ trend1h: 'DOWN' }));
  assert(unchanged === false && state.expectancyKillSwitch.active === true, 'PF5 kill switch does not reset without a 1h trend change');

  const changed = resetDirectionalLossCircuitOnTrendReset(state, makeIndicators({ trend1h: 'UP' }));
  assert(changed === true && state.expectancyKillSwitch.active === false, 'PF5 kill switch resets after valid 1h trend change');
}

{
  const outcomes = makeLowPf5Outcomes();
  const windowKey = makeWindowKey(outcomes);
  const state = makeBotState({
    recentOutcomes: outcomes,
    expectancyKillSwitch: {
      active: true,
      activatedAt: Date.now() - 5 * 60 * 60 * 1000,
      activationTrend: 'DOWN',
      windowKey,
      suppressedWindowKey: null,
    },
  });

  const result = checkRisk(makeSignal(), state, makeIndicators({ trend1h: 'DOWN' }));
  assert(result.includes('kill switch active'), `PF5 kill switch remains active before quality re-entry/24h if trend unchanged (got: ${result})`);
  assert(state.expectancyKillSwitch.active === true, 'PF5 kill switch state remains active before quality re-entry/24h');
}

{
  const outcomes = makeLowPf5Outcomes();
  const windowKey = makeWindowKey(outcomes);
  const state = makeBotState({
    recentOutcomes: outcomes,
    expectancyKillSwitch: {
      active: true,
      activatedAt: Date.now() - (24 * 60 * 60 * 1000) - 1000,
      activationTrend: 'DOWN',
      windowKey,
      suppressedWindowKey: null,
    },
  });

  const changed = resetDirectionalLossCircuitOnTrendReset(state, makeIndicators({ trend1h: 'DOWN' }));
  assert(changed === true && state.expectancyKillSwitch.active === false, 'PF5 kill switch resets after 24h if trend unchanged');
  assert(state.expectancyKillSwitch.suppressedWindowKey === windowKey, '24h reset suppresses the old/current PF5 window key');
}

{
  const outcomes = makeLowPf5Outcomes();
  const windowKey = makeWindowKey(outcomes);
  const state = makeBotState({
    recentOutcomes: outcomes,
    expectancyKillSwitch: {
      active: true,
      activatedAt: Date.now() - (24 * 60 * 60 * 1000) - 1000,
      activationTrend: 'DOWN',
      windowKey,
      suppressedWindowKey: null,
    },
  });

  const result = checkRisk(makeSignal(), state, makeIndicators({ trend1h: 'DOWN' }));
  assert(!result.includes('Rolling 5-trade profit factor'), `same unchanged PF5 window does not immediately reactivate after 24h reset (got: ${result})`);
  assert(state.expectancyKillSwitch.active === false, 'PF5 kill switch remains inactive after suppressing unchanged old window');
  assert(state.expectancyKillSwitch.suppressedWindowKey === windowKey, 'checkRisk 24h reset suppresses old/current PF5 window key');
}

{
  const outcomes = makeLowPf5Outcomes();
  const windowKey = makeWindowKey(outcomes);
  const state = makeBotState({
    recentOutcomes: outcomes,
    expectancyKillSwitch: {
      active: true,
      activatedAt: Date.now() - 2 * 60 * 60 * 1000,
      activationTrend: 'DOWN',
      windowKey,
      suppressedWindowKey: null,
    },
  });

  const changed = resetDirectionalLossCircuitOnTrendReset(state, makeIndicators({ trend1h: 'UP' }));
  assert(changed === true && state.expectancyKillSwitch.active === false, 'existing trend-change reset still works before 24h');
  assert(state.expectancyKillSwitch.suppressedWindowKey === windowKey, 'trend-change reset still suppresses old/current PF5 window key');
}

{
  const outcomes = makeLowPf5Outcomes();
  const windowKey = makeWindowKey(outcomes);
  const state = makeBotState({
    recentOutcomes: outcomes,
    expectancyKillSwitch: {
      active: true,
      activatedAt: Date.now() - (6 * 60 * 60 * 1000) - 1000,
      activationTrend: 'DOWN',
      windowKey,
      suppressedWindowKey: null,
    },
  });

  const result = checkRisk(makeSignal(), state, makeIndicators({ trend1h: 'DOWN' }));
  assert(result === 'APPROVED', `quality re-entry can clear PF5 pause after 6h for 2.5R/high-confidence setups (got: ${result})`);
  assert(state.expectancyKillSwitch.active === false && state.expectancyKillSwitch.resetReason === 'QUALITY_REENTRY', 'PF5 quality re-entry records reset reason');
}

console.log(`\nTests: ${passed + failed} total, ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
