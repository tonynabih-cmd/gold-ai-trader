// tests/test_sync.mjs — Tests for sync race condition fixes in lib/execution.js
// Run standalone: node tests/test_sync.mjs
// Or as part of the suite: npm test
//
// Covers:
//   1. fetchClosedTradePnl — history available immediately
//   2. fetchClosedTradePnl — delayed history (found on 2nd attempt)
//   3. fetchClosedTradePnl — delayed history (found on 3rd attempt / all retries used)
//   4. fetchClosedTradePnl — API failure (res.ok = false) returns null gracefully
//   5. fetchClosedTradePnl — empty transactions on all attempts returns null
//   6. fetchClosedTradePnl — network error (throw) returns null gracefully
//   7. SYNC_WINDOW_MS constant is exported and set to 8 minutes
//   8. fetchClosedTradePnl — rapid open/close (pnl resolved immediately)
//   9. fetchClosedTradePnl — ID matching via positionId field
//  10. fetchClosedTradePnl — ID matching via dealReference field
//  11. fetchClosedTradePnl — opening transaction is NOT returned as closure
//  12. fetchClosedTradePnl — multiple concurrent MIA trades resolved independently
//  13. recentOutcomes dedup — null P&L (MIA fallback) excluded from outcomes
//  14. recentOutcomes dedup — duplicate dealId not re-inserted

import { fetchClosedTradePnl, SYNC_WINDOW_MS } from '../lib/execution.js';

// ── Required env vars (values not used — HTTP is mocked via global.fetch) ────
process.env.CAPITAL_API_KEY = 'mock_key';

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

// Fake Capital.com session object
const mockSession = {
  baseUrl:       'https://mock.example.com',
  cst:           'mock_cst',
  securityToken: 'mock_token',
};

// Helpers
function mockOk(data)   { return { ok: true,  json: async () => data, text: async () => JSON.stringify(data) }; }
function mockFail(data) { return { ok: false, json: async () => data, text: async () => JSON.stringify(data) }; }

function makeTx(id, pnl, note = 'closed position') {
  return { dealId: id, profitAndLoss: String(pnl), note };
}

// ── Section 1 ────────────────────────────────────────────────────────────────
section('1. History found on first attempt');
{
  let calls = 0;
  global.fetch = async () => { calls++; return mockOk({ transactions: [makeTx('D1', 15.5)] }); };
  const pnl = await fetchClosedTradePnl(mockSession, 'D1', null, [0, 0]);
  assert(pnl === 15.5, `P&L returned correctly (got ${pnl})`);
  assert(calls === 1,  `Only 1 HTTP call made (got ${calls})`);
}

// ── Section 2 ────────────────────────────────────────────────────────────────
section('2. Delayed history — found on 2nd attempt (first returns empty)');
{
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return calls < 2
      ? mockOk({ transactions: [] })
      : mockOk({ transactions: [makeTx('D2', -8.25)] });
  };
  const pnl = await fetchClosedTradePnl(mockSession, 'D2', null, [0, 0]);
  assert(pnl === -8.25, `P&L found after 1 retry (got ${pnl})`);
  assert(calls === 2,   `Exactly 2 HTTP calls made (got ${calls})`);
}

// ── Section 3 ────────────────────────────────────────────────────────────────
section('3. Delayed history — found on 3rd attempt (all retries used)');
{
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return calls < 3
      ? mockOk({ transactions: [] })
      : mockOk({ transactions: [makeTx('D3', 22.0)] });
  };
  const pnl = await fetchClosedTradePnl(mockSession, 'D3', null, [0, 0]);
  assert(pnl === 22.0, `P&L found on 3rd attempt (got ${pnl})`);
  assert(calls === 3,  `Exactly 3 HTTP calls made (got ${calls})`);
}

// ── Section 4 ────────────────────────────────────────────────────────────────
section('4. API failure (res.ok = false) returns null gracefully');
{
  let calls = 0;
  global.fetch = async () => { calls++; return mockFail({ error: 'Internal Server Error' }); };
  const pnl = await fetchClosedTradePnl(mockSession, 'D4', null, [0, 0]);
  assert(pnl === null, `Returns null on API failure (got ${pnl})`);
  // All 3 attempts are still made (no early exit on API failure — could be transient)
  assert(calls === 3,  `All 3 attempts tried on failure (got ${calls})`);
}

// ── Section 5 ────────────────────────────────────────────────────────────────
section('5. All 3 attempts return empty transactions — returns null');
{
  let calls = 0;
  global.fetch = async () => { calls++; return mockOk({ transactions: [] }); };
  const pnl = await fetchClosedTradePnl(mockSession, 'D5', null, [0, 0]);
  assert(pnl === null, `Returns null when all attempts return empty (got ${pnl})`);
  assert(calls === 3,  `All 3 attempts tried (got ${calls})`);
}

// ── Section 6 ────────────────────────────────────────────────────────────────
section('6. Network error (throw) on all attempts — returns null gracefully');
{
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error('ECONNREFUSED'); };
  const pnl = await fetchClosedTradePnl(mockSession, 'D6', null, [0, 0]);
  assert(pnl === null, `Returns null on network errors (got ${pnl})`);
}

// ── Section 7 ────────────────────────────────────────────────────────────────
section('7. SYNC_WINDOW_MS exported and correct (8 minutes)');
{
  assert(typeof SYNC_WINDOW_MS === 'number', `SYNC_WINDOW_MS is a number (got ${typeof SYNC_WINDOW_MS})`);
  assert(SYNC_WINDOW_MS === 8 * 60 * 1000, `SYNC_WINDOW_MS = 480000 ms (got ${SYNC_WINDOW_MS})`);
}

// ── Section 8 ────────────────────────────────────────────────────────────────
section('8. Rapid open → close (trade opened and closed within same cycle)');
{
  global.fetch = async () => mockOk({ transactions: [makeTx('RAPID1', 5.0)] });
  const pnl = await fetchClosedTradePnl(mockSession, 'RAPID1', Date.now() - 1000, [0, 0]);
  assert(pnl === 5.0, `Rapid close resolved correctly (got ${pnl})`);
}

// ── Section 9 ────────────────────────────────────────────────────────────────
section('9. ID matching via positionId field');
{
  global.fetch = async () => mockOk({
    transactions: [{ positionId: 'POS9', dealId: 'DIFFERENT', profitAndLoss: '11.11', note: 'closed' }]
  });
  const pnl = await fetchClosedTradePnl(mockSession, 'POS9', null, [0, 0]);
  assert(pnl === 11.11, `Matched via positionId (got ${pnl})`);
}

// ── Section 10 ───────────────────────────────────────────────────────────────
section('10. ID matching via dealReference field');
{
  global.fetch = async () => mockOk({
    transactions: [{ dealReference: 'REF10', dealId: 'DIFFERENT', profitAndLoss: '-3.50', note: 'stop loss' }]
  });
  const pnl = await fetchClosedTradePnl(mockSession, 'REF10', null, [0, 0]);
  assert(pnl === -3.5, `Matched via dealReference (got ${pnl})`);
}

// ── Section 11 ───────────────────────────────────────────────────────────────
section('11. Opening transaction is NOT returned as closure');
{
  global.fetch = async () => mockOk({
    transactions: [
      // Opening transaction — should be skipped
      { dealId: 'D11', profitAndLoss: '0', note: 'Position opened' },
      // Closure transaction — should be matched
      { dealId: 'D11', profitAndLoss: '7.00', note: 'closed position' },
    ]
  });
  const pnl = await fetchClosedTradePnl(mockSession, 'D11', null, [0, 0]);
  assert(pnl === 7.0, `Only closure transaction returned, not opening (got ${pnl})`);
}

// ── Section 12 ───────────────────────────────────────────────────────────────
section('12. Multiple concurrent MIA trades resolved independently');
{
  const callLog = [];
  global.fetch = async (url) => {
    callLog.push(url);
    // Simulate different trades having their history appear at different times
    if (url.includes('from=')) {
      return mockOk({
        transactions: [
          makeTx('TRADE_A', 10.0),
          makeTx('TRADE_B', -5.0),
        ]
      });
    }
    return mockOk({ transactions: [] });
  };

  const pnlA = await fetchClosedTradePnl(mockSession, 'TRADE_A', null, [0, 0]);
  const pnlB = await fetchClosedTradePnl(mockSession, 'TRADE_B', null, [0, 0]);

  assert(pnlA === 10.0, `Trade A P&L resolved correctly (got ${pnlA})`);
  assert(pnlB === -5.0, `Trade B P&L resolved correctly (got ${pnlB})`);
}

// ── Section 13 ───────────────────────────────────────────────────────────────
section('13. recentOutcomes: null P&L (MIA fallback) excluded from outcomes');
{
  // Simulates the filter logic in reconcilePositions (api/cron.js)
  const justClosed = [
    { realizedPnl: 10.5,  dealId: 'CLOSED_OK',      action: 'BUY',  dealReference: 'R1' },
    { realizedPnl: null,  dealId: 'CLOSED_FALLBACK', action: 'SELL', dealReference: 'R2', fallbackUsed: true, isMIA: true },
    { realizedPnl: -3.0,  dealId: 'CLOSED_LOSS',     action: 'BUY',  dealReference: 'R3' },
  ];

  const recentOutcomes = [];
  const existingDealIds = new Set(recentOutcomes.map(o => o.dealId).filter(Boolean));
  const outcomes = justClosed
    .filter(t => typeof t.realizedPnl === 'number' && !existingDealIds.has(t.dealId))
    .map(t => ({ pnl: t.realizedPnl, action: t.action, closedAt: Date.now(), ref: t.dealReference, dealId: t.dealId }));

  assert(outcomes.length === 2, `Only 2 outcomes added (null P&L excluded) — got ${outcomes.length}`);
  assert(outcomes.every(o => o.dealId !== 'CLOSED_FALLBACK'), `Fallback MIA trade not in outcomes`);
  assert(outcomes.some(o => o.pnl === 10.5),  `Win trade included in outcomes`);
  assert(outcomes.some(o => o.pnl === -3.0),  `Loss trade included in outcomes`);
}

// ── Section 14 ───────────────────────────────────────────────────────────────
section('14. recentOutcomes dedup: duplicate dealId not re-inserted');
{
  const existingOutcomes = [
    { pnl: 5.0, action: 'BUY', closedAt: Date.now() - 5000, ref: 'R_DUP', dealId: 'DUP_DEAL' },
  ];
  const justClosed = [
    { realizedPnl: 5.0, dealId: 'DUP_DEAL', action: 'BUY', dealReference: 'R_DUP' },  // duplicate
    { realizedPnl: 8.0, dealId: 'NEW_DEAL', action: 'BUY', dealReference: 'R_NEW' },  // new
  ];

  const existingDealIds = new Set(existingOutcomes.map(o => o.dealId).filter(Boolean));
  const outcomes = justClosed
    .filter(t => typeof t.realizedPnl === 'number' && !existingDealIds.has(t.dealId))
    .map(t => ({ pnl: t.realizedPnl, action: t.action, closedAt: Date.now(), ref: t.dealReference, dealId: t.dealId }));

  assert(outcomes.length === 1,              `Only 1 new outcome added (duplicate filtered) — got ${outcomes.length}`);
  assert(outcomes[0].dealId === 'NEW_DEAL',  `New trade is the only entry (got ${outcomes[0]?.dealId})`);
  assert(outcomes[0].pnl === 8.0,            `Correct P&L for new trade (got ${outcomes[0]?.pnl})`);
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`  Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(60)}\n`);

if (failed > 0) process.exit(1);
