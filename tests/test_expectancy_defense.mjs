// tests/test_expectancy_defense.mjs
// Focused coverage for expectancy-defense controls in lib/risk.js.

import { checkRisk, resetDirectionalLossCircuitOnTrendReset } from '../lib/risk.js';

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

function makeSignal(overrides = {}) {
  const candleTime = Date.now();
  return {
    id: `${candleTime}_SELL_v1.5`,
    action: 'SELL',
    entryType: 'pullback',
    entryPrice: 1995,
    stopLoss: 2002.5,
    takeProfit: 1982.5,
    atr: 5,
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
    makeSignal({ entryPrice: 1980, stopLoss: 1987.5, takeProfit: 1967.5 }),
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

console.log(`\nTests: ${passed + failed} total, ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
