// tests/test_order_rate_cap.mjs
// Run: node tests/test_order_rate_cap.mjs

import { checkRisk as checkRiskImpl } from '../lib/risk.js';

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
    console.error(`  FAIL: ${message}`);
  }
}

function makeSignal(overrides = {}) {
  return {
    action: 'BUY',
    entryPrice: 2000,
    stopLoss: 1990,
    takeProfit: 2030,
    score: 80,
    setupConfidenceScore: 80,
    id: `order_rate_${Date.now()}`,
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
    availableMargin: 800,
    peakBalance: 1000,
    dailyLoss: 0,
    dailyTrades: 0,
    openTrades: [],
    recentTradeIds: [],
    recentOrderKeys: [],
    recentOrderTimestamps: [],
    recentOutcomes: [],
    lastOrderTimestamp: 0,
    ...overrides,
  };
}

function makeIndicators(overrides = {}) {
  return {
    atr: 5,
    atrAverage: 4.5,
    spread: 0.3,
    currEMA20: 2000,
    currEMA50: 1995,
    trend1h: 'UP',
    ...overrides,
  };
}

process.env.BOT_ENABLED = 'true';
process.env.MAX_SPREAD = '0.5';

console.log('\n-- Hard opening-order rate cap --');

{
  const result = checkRisk(makeSignal(), makeBotState({ recentOrderTimestamps: [] }), makeIndicators());
  assert(result === 'APPROVED', `0 recent orders -> APPROVED (got: ${result})`);
}

{
  const now = Date.now();
  const result = checkRisk(
    makeSignal(),
    makeBotState({ recentOrderTimestamps: [now - 10_000] }),
    makeIndicators()
  );
  assert(result === 'APPROVED', `1 recent order -> APPROVED (got: ${result})`);
}

{
  const now = Date.now();
  const result = checkRisk(
    makeSignal(),
    makeBotState({ recentOrderTimestamps: [now - 20_000, now - 10_000] }),
    makeIndicators()
  );
  assert(result.includes('SKIP: Order rate cap reached'), `2 recent orders inside 60s -> SKIP (got: ${result})`);
}

{
  const now = Date.now();
  const state = makeBotState({ recentOrderTimestamps: [now - 120_000, now - 10_000] });
  const result = checkRisk(makeSignal(), state, makeIndicators());
  assert(result === 'APPROVED', `old timestamps older than 60s ignored -> APPROVED (got: ${result})`);
  assert(state.recentOrderTimestamps.length === 1, 'old timestamp is pruned from state');
}

console.log(`\nTests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
