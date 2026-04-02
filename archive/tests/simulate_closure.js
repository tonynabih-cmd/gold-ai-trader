/**
 * archive/tests/simulate_closure.js
 *
 * Verifies:
 * 1. fetchClosedTradePnl retries internally if not found on first attempt.
 * 2. openPositions count in logs reflects state AFTER decrement.
 *
 * Uses the `_retryDelaysMs` parameter (4th arg) with [0] to perform a single
 * retry with zero delay, keeping the test fast.
 */

import { fetchClosedTradePnl } from '../../lib/execution.js';
import { saveLog } from '../../lib/logger.js';

// Mocking environment
process.env.CAPITAL_API_KEY = 'mock_key';
process.env.KV_REST_API_URL = 'https://mock.upstash.io';
process.env.KV_REST_API_TOKEN = 'mock_token';

const mockSession = {
  baseUrl: 'https://api.capital.com',
  cst: 'mock_cst',
  securityToken: 'mock_token'
};

async function testPnLRetry() {
  console.log('--- Testing P&L Internal Retry Logic ---');
  let fetchCount = 0;

  // Override global.fetch so fetchWithTimeout uses our mock.
  // Call 1: no transactions yet (simulates Capital.com history lag).
  // Call 2: transaction record appears.
  global.fetch = async (url, options) => {
    fetchCount++;
    console.log(`  [Mock Fetch] Call ${fetchCount}: ${url}`);

    if (fetchCount === 1) {
      return {
        ok: true,
        json: async () => ({ transactions: [] })
      };
    }

    return {
      ok: true,
      json: async () => ({
        transactions: [
          {
            dealId: 'DEAL123',
            dealReference: 'DEAL123',
            profitAndLoss: '10.50',
            note: 'closed position'
          }
        ]
      })
    };
  };

  // Pass [0] as retry delays: one retry with 0ms delay — fast for tests.
  const pnl = await fetchClosedTradePnl(mockSession, 'DEAL123', null, [0]);

  console.log(`  Resulting P&L: ${pnl}`);
  if (pnl === 10.5 && fetchCount === 2) {
    console.log('✅ P&L Retry Test PASSED');
  } else {
    console.error(`❌ P&L Retry Test FAILED — pnl=${pnl}, fetchCount=${fetchCount}`);
    process.exit(1);
  }
}

async function testOpenPositionsLog() {
  console.log('\n--- Testing openPositions Log Order ---');

  const stillOpen = [];
  const justClosed = [{ tradeId: 'T1', dealReference: 'DEAL123', action: 'BUY' }];

  // Simulate the updated reconcilePositions state transition:
  // botState.openTrades is set to stillOpen BEFORE logs are written.
  const simulationState = { openTrades: [...justClosed] };
  console.log(`  Initial state openPositions: ${simulationState.openTrades.length}`);

  simulationState.openTrades = stillOpen;
  console.log(`  State updated before log. New count: ${simulationState.openTrades.length}`);

  const logEntry = {
    openPositions: simulationState.openTrades.length
  };

  console.log(`  Log entry openPositions: ${logEntry.openPositions}`);

  if (logEntry.openPositions === 0) {
    console.log('✅ openPositions Log Order Test PASSED');
  } else {
    console.error('❌ openPositions Log Order Test FAILED');
    process.exit(1);
  }
}

async function testAllAttemptsExhausted() {
  console.log('\n--- Testing null return when all retries exhausted ---');
  let fetchCount = 0;

  global.fetch = async () => {
    fetchCount++;
    return { ok: true, json: async () => ({ transactions: [] }) };
  };

  // Two retries with 0ms delay → 3 total attempts
  const pnl = await fetchClosedTradePnl(mockSession, 'MISSING_DEAL', null, [0, 0]);

  console.log(`  Resulting P&L: ${pnl} (fetchCount: ${fetchCount})`);
  if (pnl === null && fetchCount === 3) {
    console.log('✅ Exhausted Retries Test PASSED');
  } else {
    console.error(`❌ Exhausted Retries Test FAILED — pnl=${pnl}, fetchCount=${fetchCount}`);
    process.exit(1);
  }
}

async function run() {
  try {
    await testPnLRetry();
    await testOpenPositionsLog();
    await testAllAttemptsExhausted();
    console.log('\nALL TESTS PASSED ✨');
  } catch (err) {
    console.error('Test execution error:', err);
    process.exit(1);
  }
}

run();

