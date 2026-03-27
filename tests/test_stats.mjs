// test_stats.mjs — Unit tests for lib/stats.js
// Run: node tests/test_stats.mjs
// Verifies all invariants, metric calculations, and edge cases.

import { computeSessionStats } from '../lib/stats.js';

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

// ── Helpers to build mock logs ──────────────────────────────────────────────

function makeExecutedLog(action = 'BUY') {
  return {
    tradeExecuted: true,
    signalDetected: action,
    reason: null,
    entryType: action === 'BUY' ? 'crossover' : 'pullback',
    time: new Date().toISOString(),
  };
}

function makeSkippedLog(reason = 'SKIP: No signal generated this cycle') {
  return {
    tradeExecuted: false,
    signalDetected: 'NONE',
    reason,
    time: new Date().toISOString(),
  };
}

function makeRejectedLog(action = 'BUY', reason = 'SKIP: Daily trade limit reached (10/10)') {
  return {
    tradeExecuted: false,
    signalDetected: action,
    reason,
    time: new Date().toISOString(),
  };
}

function makeMarketSkipLog(reason = 'SKIP: Weekend - market closed') {
  return {
    tradeExecuted: false,
    signalDetected: 'NONE',
    reason,
    time: new Date().toISOString(),
  };
}

function makeClosureLog(pnl, action = 'BUY') {
  return {
    tradeExecuted: false,
    signalDetected: action === 'BUY' ? 'SELL' : 'BUY', // closure reverses direction
    reason: `CLOSED: Realized P&L: $${pnl.toFixed(2)}`,
    entryType: 'closure',
    result: { realizedPnl: pnl },
    time: new Date().toISOString(),
  };
}


// ═══════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════

section('Empty / null input');
{
  const stats = computeSessionStats([]);
  assert(stats.totalDecisions === 0, 'Empty logs → totalDecisions = 0');
  assert(stats.valid === true, 'Empty logs → valid = true');
  assert(stats.winRate === null, 'Empty logs → winRate = null');

  const stats2 = computeSessionStats(null);
  assert(stats2.totalDecisions === 0, 'null input → totalDecisions = 0');
}

section('Simple classification');
{
  const logs = [
    makeExecutedLog('BUY'),
    makeExecutedLog('SELL'),
    makeSkippedLog(),
    makeRejectedLog('BUY', 'SKIP: Spread too high ($0.55) - exceeds $0.40 limit'),
    makeMarketSkipLog('SKIP: Weekend - market closed'),
    makeMarketSkipLog('SKIP: Outside Golden Hour (11AM-8PM UAE / 07:00-16:00 UTC)'),
    makeClosureLog(5.50),
    makeClosureLog(-2.30),
  ];

  const stats = computeSessionStats(logs);

  assert(stats.totalLogs === 8, `totalLogs = 8 (got ${stats.totalLogs})`);
  assert(stats.executed === 2, `executed = 2 (got ${stats.executed})`);
  assert(stats.skipped === 1, `skipped = 1 (got ${stats.skipped})`);
  assert(stats.rejected === 1, `rejected = 1 (got ${stats.rejected})`);
  assert(stats.marketSkips === 2, `marketSkips = 2 (got ${stats.marketSkips})`);
  assert(stats.closures === 2, `closures = 2 (got ${stats.closures})`);
  assert(stats.buys === 1, `buys = 1 (got ${stats.buys})`);
  assert(stats.sells === 1, `sells = 1 (got ${stats.sells})`);
}

section('Invariant: totalDecisions = executed + skipped + rejected');
{
  const logs = [
    makeExecutedLog('BUY'),
    makeExecutedLog('BUY'),
    makeExecutedLog('SELL'),
    makeSkippedLog(),
    makeSkippedLog(),
    makeRejectedLog('SELL'),
    makeMarketSkipLog(),
    makeClosureLog(10),
  ];

  const stats = computeSessionStats(logs);

  assert(
    stats.totalDecisions === stats.executed + stats.skipped + stats.rejected,
    `totalDecisions(${stats.totalDecisions}) = executed(${stats.executed}) + skipped(${stats.skipped}) + rejected(${stats.rejected})`
  );
  assert(
    stats.executed === stats.buys + stats.sells,
    `executed(${stats.executed}) = buys(${stats.buys}) + sells(${stats.sells})`
  );
  assert(stats.valid === true, 'Invariants passed → valid = true');
}

section('Every log classified into exactly one bucket');
{
  const logs = [
    makeExecutedLog('BUY'),
    makeSkippedLog(),
    makeRejectedLog('SELL'),
    makeMarketSkipLog('SKIP: Friday close - weekend gap risk (after 8PM UAE)'),
    makeClosureLog(-1.5),
    makeMarketSkipLog('SKIP: Bot disabled via environment'),
    makeMarketSkipLog('SKIP: Concurrency lock active for candle 12345 - preventing duplicate trades'),
    makeMarketSkipLog('SKIP: Capital.com auth failed - timeout'),
    makeMarketSkipLog('SKIP: Balance not yet synced from Capital.com'),
  ];

  const stats = computeSessionStats(logs);
  const total = stats.executed + stats.skipped + stats.rejected + stats.marketSkips + stats.closures;

  assert(total === logs.length, `All ${logs.length} logs classified exactly once (got ${total})`);
  assert(stats.valid === true, 'No validation errors');
}

section('Win rate calculation');
{
  const logs = [
    makeClosureLog(10.00),   // win
    makeClosureLog(5.00),    // win
    makeClosureLog(-3.00),   // loss
    makeClosureLog(0.00),    // break-even
  ];

  const stats = computeSessionStats(logs);
  assert(stats.closedTrades === 4, `closedTrades = 4 (got ${stats.closedTrades})`);
  assert(stats.wins === 2, `wins = 2 (got ${stats.wins})`);
  assert(stats.losses === 1, `losses = 1 (got ${stats.losses})`);
  assert(stats.winRate === 50.0, `winRate = 50.0% (got ${stats.winRate})`);
  assert(stats.bestTrade === 10.00, `bestTrade = 10.00 (got ${stats.bestTrade})`);
  assert(stats.worstTrade === -3.00, `worstTrade = -3.00 (got ${stats.worstTrade})`);
  assert(stats.totalPnl === 12.00, `totalPnl = 12.00 (got ${stats.totalPnl})`);
}

section('Win rate = null when no closures');
{
  const logs = [
    makeExecutedLog('BUY'),
    makeSkippedLog(),
  ];

  const stats = computeSessionStats(logs);
  assert(stats.winRate === null, `winRate = null when no closures (got ${stats.winRate})`);
  assert(stats.bestTrade === null, `bestTrade = null when no closures (got ${stats.bestTrade})`);
  assert(stats.worstTrade === null, `worstTrade = null when no closures (got ${stats.worstTrade})`);
}

section('P&L parsed from reason string when result.realizedPnl is missing');
{
  const log = {
    tradeExecuted: false,
    signalDetected: 'SELL',
    reason: 'CLOSED: Realized P&L: $-4.56',
    entryType: 'closure',
    result: {},  // realizedPnl missing
    time: new Date().toISOString(),
  };

  const stats = computeSessionStats([log]);
  assert(stats.closures === 1, `closures = 1`);
  assert(stats.closedTrades === 1, `closedTrades = 1 (parsed from reason)`);
  assert(stats.worstTrade === -4.56, `worstTrade = -4.56 (parsed from reason, got ${stats.worstTrade})`);
}

section('Market skip variants');
{
  const variants = [
    'SKIP: Weekend - market closed',
    'SKIP: Outside Golden Hour (11AM-8PM UAE / 07:00-16:00 UTC)',
    'SKIP: Friday close - weekend gap risk (after 8PM UAE)',
    'SKIP: Concurrency lock active for candle 1711234567890 - preventing duplicate trades',
    'SKIP: Capital.com auth failed - timeout',
    'SKIP: Bot disabled via state (drawdown or performance threshold)',
    'SKIP: Balance not yet synced from Capital.com',
    'SKIP: Duplicate candle - already processed',
    'SKIP: No new candle available',
    'SKIP: Market data fetch failed',
    'SKIP: Insufficient candles for indicator calculation',
  ];

  const logs = variants.map(reason => makeMarketSkipLog(reason));
  const stats = computeSessionStats(logs);

  assert(stats.marketSkips === variants.length, `All ${variants.length} market skip variants classified correctly (got ${stats.marketSkips})`);
  assert(stats.totalDecisions === 0, `No decisions from pure market skips (got ${stats.totalDecisions})`);
}

section('Non-market-skip risk rejections are classified as REJECTED');
{
  // These are risk.js rejections AFTER the strategy generated a signal
  const riskReasons = [
    'SKIP: Spread too high ($0.55) - exceeds $0.40 limit',
    'SKIP: Daily trade limit reached (5/10)',
    'SKIP: ATR out of range (0.5-50) (ATR 0.35)',
    'SKIP: ATR spike - possible news event (15.20 vs avg 5.30)',
    'SKIP: Cooldown active (3 min remaining)',
    'SKIP: Max 2 positions open (currently 2)',
    'SKIP: Signal score too low (1/required 2)',
    'SKIP: Price moved too fast (slippage: $1.50)',
  ];

  const logs = riskReasons.map(reason => makeRejectedLog('BUY', reason));
  const stats = computeSessionStats(logs);

  assert(stats.rejected === riskReasons.length, `All ${riskReasons.length} risk rejections classified as REJECTED (got ${stats.rejected})`);
  assert(stats.marketSkips === 0, `None classified as market skip (got ${stats.marketSkips})`);
}

section('Realistic mixed workload');
{
  // Simulates a typical day: many market skips, few decisions, couple of closures
  const logs = [];

  // 200 market skips (weekend + after-hours)
  for (let i = 0; i < 200; i++) logs.push(makeMarketSkipLog());

  // 30 strategy evaluations with no signal (holds)
  for (let i = 0; i < 30; i++) logs.push(makeSkippedLog());

  // 5 risk rejections
  for (let i = 0; i < 5; i++) logs.push(makeRejectedLog('BUY'));

  // 3 executed (2 BUY, 1 SELL)
  logs.push(makeExecutedLog('BUY'));
  logs.push(makeExecutedLog('BUY'));
  logs.push(makeExecutedLog('SELL'));

  // 2 closures (1 win, 1 loss)
  logs.push(makeClosureLog(8.50));
  logs.push(makeClosureLog(-3.20));

  const stats = computeSessionStats(logs);

  assert(stats.totalLogs === 240, `totalLogs = 240 (got ${stats.totalLogs})`);
  assert(stats.totalDecisions === 38, `totalDecisions = 38 (30+5+3) (got ${stats.totalDecisions})`);
  assert(stats.executed === 3, `executed = 3 (got ${stats.executed})`);
  assert(stats.skipped === 30, `skipped = 30 (got ${stats.skipped})`);
  assert(stats.rejected === 5, `rejected = 5 (got ${stats.rejected})`);
  assert(stats.marketSkips === 200, `marketSkips = 200 (got ${stats.marketSkips})`);
  assert(stats.closures === 2, `closures = 2 (got ${stats.closures})`);
  assert(stats.buys === 2, `buys = 2 (got ${stats.buys})`);
  assert(stats.sells === 1, `sells = 1 (got ${stats.sells})`);
  assert(stats.winRate === 50.0, `winRate = 50.0% (got ${stats.winRate})`);
  assert(stats.bestTrade === 8.50, `bestTrade = 8.50 (got ${stats.bestTrade})`);
  assert(stats.worstTrade === -3.20, `worstTrade = -3.20 (got ${stats.worstTrade})`);
  assert(stats.valid === true, 'All invariants pass');

  // Cross-check
  assert(
    stats.totalDecisions === stats.executed + stats.skipped + stats.rejected,
    `Invariant: ${stats.totalDecisions} = ${stats.executed} + ${stats.skipped} + ${stats.rejected}`
  );
  assert(
    stats.executed === stats.buys + stats.sells,
    `Invariant: ${stats.executed} = ${stats.buys} + ${stats.sells}`
  );
  const allClassified = stats.executed + stats.skipped + stats.rejected + stats.marketSkips + stats.closures;
  assert(
    allClassified === stats.totalLogs,
    `All classified: ${allClassified} = ${stats.totalLogs}`
  );
}


section('Broker stats override closure logs');
{
  // Simulate: closure logs have incomplete P&L, but broker stats have the real data
  const logs = [
    makeExecutedLog('BUY'),
    makeExecutedLog('SELL'),
    makeClosureLog(5.0),   // only 1 closure log with P&L
    makeSkippedLog(),
  ];

  // Broker stats from Capital.com (the real source of truth)
  const brokerStats = {
    brokerTotalTrades: 17,
    brokerWins: 8,
    brokerLosses: 9,
    brokerWinRate: 47.06,
    brokerBestTrade: 120.50,
    brokerWorstTrade: -45.30,
    brokerTotalPnl: 449.24,
  };

  const stats = computeSessionStats(logs, brokerStats);

  assert(stats.winRate === 47.06, `Broker winRate = 47.06% (got ${stats.winRate})`);
  assert(stats.closedTrades === 17, `Broker closedTrades = 17 (got ${stats.closedTrades})`);
  assert(stats.bestTrade === 120.50, `Broker bestTrade = 120.50 (got ${stats.bestTrade})`);
  assert(stats.worstTrade === -45.30, `Broker worstTrade = -45.30 (got ${stats.worstTrade})`);
  assert(stats.totalPnl === 449.24, `Broker totalPnl = 449.24 (got ${stats.totalPnl})`);
  assert(stats.wins === 8, `Broker wins = 8 (got ${stats.wins})`);
  assert(stats.losses === 9, `Broker losses = 9 (got ${stats.losses})`);
  assert(stats.source === 'broker', `Source = broker (got ${stats.source})`);

  // Log classification should still work independently
  assert(stats.executed === 2, `executed still = 2 (got ${stats.executed})`);
  assert(stats.closures === 1, `closures still = 1 (got ${stats.closures})`);
  assert(stats.valid === true, 'Invariants still pass');
}

section('Capital.com screenshot match (17 trades, 47.06% win rate, +AED 449.24)');
{
  // Exact values from user's Capital.com screenshot
  const brokerStats = {
    brokerTotalTrades: 17,
    brokerWins: 8,
    brokerLosses: 9,
    brokerWinRate: 47.06,
    brokerBestTrade: 150.00,
    brokerWorstTrade: -80.00,
    brokerTotalPnl: 449.24,
  };

  const logs = [makeSkippedLog()]; // minimal logs
  const stats = computeSessionStats(logs, brokerStats);

  assert(stats.winRate === 47.06, `Win rate matches Capital.com: 47.06% (got ${stats.winRate})`);
  assert(stats.closedTrades === 17, `Total trades matches Capital.com: 17 (got ${stats.closedTrades})`);
  assert(stats.totalPnl === 449.24, `P&L matches Capital.com: +AED 449.24 (got ${stats.totalPnl})`);
  assert(stats.bestTrade !== null, `Best trade is NOT null (got ${stats.bestTrade})`);
  assert(stats.worstTrade !== null, `Worst trade is NOT null (got ${stats.worstTrade})`);
  assert(stats.source === 'broker', `Data source is broker (got ${stats.source})`);
}

section('Broker stats with empty logs');
{
  const brokerStats = {
    brokerTotalTrades: 5,
    brokerWins: 3,
    brokerLosses: 2,
    brokerWinRate: 60.0,
    brokerBestTrade: 50.00,
    brokerWorstTrade: -20.00,
    brokerTotalPnl: 100.00,
  };

  const stats = computeSessionStats([], brokerStats);
  assert(stats.winRate === 60.0, `Broker winRate with empty logs = 60.0% (got ${stats.winRate})`);
  assert(stats.bestTrade === 50.00, `Broker bestTrade with empty logs = 50.00 (got ${stats.bestTrade})`);
  assert(stats.source === 'broker', `Source = broker even with empty logs (got ${stats.source})`);
}

section('No broker stats → falls back to closure logs');
{
  const logs = [
    makeClosureLog(10.00),
    makeClosureLog(-5.00),
  ];

  const stats = computeSessionStats(logs, null);
  assert(stats.winRate === 50.0, `Fallback winRate from closure logs = 50.0% (got ${stats.winRate})`);
  assert(stats.bestTrade === 10.00, `Fallback bestTrade = 10.00 (got ${stats.bestTrade})`);
  assert(stats.worstTrade === -5.00, `Fallback worstTrade = -5.00 (got ${stats.worstTrade})`);
  assert(stats.source === 'logs', `Source = logs (got ${stats.source})`);
}


// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}`);
console.log(`  Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(60)}\n`);

if (failed > 0) {
  process.exit(1);
}

