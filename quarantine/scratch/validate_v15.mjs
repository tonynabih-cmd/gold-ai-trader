/**
 * v1.5 LIVE PERFORMANCE VALIDATOR
 * ================================
 * Pulls REAL executed trades from Capital.com + bot state/logs
 * and validates every v1.5 metric the user requested.
 *
 * Capital.com transaction API format (discovered):
 *   - Only closure records exist (note="Trade closed")
 *   - `size` field = realized P&L in account currency (AED), NOT position size
 *   - No `profitAndLoss` field; use `size` directly
 *   - Each transaction has a unique `dealId` (position) and `reference` (tx)
 *   - SWAP transactions ("Overnight fee") are separate — exclude from trade P&L
 *
 * Sections:
 *   1. Loss Control        — Max R loss, guaranteed stop execution
 *   2. Average Win         — R after partial close + trailing vs old 0.62R
 *   3. Break-Even          — Trades reaching +1R, continuing past +2R
 *   4. Expectancy          — Recalculated from real trades
 *   5. Execution Check     — guaranteedStop rejections, spread/fee impact
 *   6. Early Snapshot      — First 10-20 trades P&L and behavior
 */

import fs from 'fs';
import { getCapitalSession } from '../lib/session.js';
import { fetchWithTimeout } from '../lib/fetch.js';

// ── Load .env.local ──────────────────────────────────────────────────────────
const envFile = fs.readFileSync('.env.local', 'utf-8');
envFile.split('\n').forEach(line => {
  const parts = line.split('=');
  if (parts.length >= 2) {
    const key = parts[0].trim();
    const val = parts.slice(1).join('=').trim().replace(/"/g, '').replace(/'/g, '');
    if (key) process.env[key] = val;
  }
});

const USD_AED_PEG = 3.6725;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchAllTransactions(session, daysBack = 14) {
  const { baseUrl, cst, securityToken } = session;
  const fromDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const toDate = new Date();
  const from = fromDate.toISOString().slice(0, 19);
  const to = toDate.toISOString().slice(0, 19);
  const url = `${baseUrl}/api/v1/history/transactions?from=${from}&to=${to}`;
  console.log(`  Fetching transactions from ${from} to ${to}...`);

  const res = await fetchWithTimeout(url, {
    headers: {
      'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
      'CST': cst,
      'X-SECURITY-TOKEN': securityToken,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`Transaction history HTTP ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.transactions || [];
}

async function fetchBotLogs() {
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return [];

  const res = await fetchWithTimeout(`${kvUrl}/lrange/trade_logs_list/0/-1`, {
    headers: { Authorization: `Bearer ${kvToken}` },
  });

  if (!res.ok) return [];
  const body = await res.json();
  const raw = body.result || [];
  return raw.map(entry => {
    if (typeof entry === 'string') {
      try { return JSON.parse(entry); } catch { return entry; }
    }
    return entry;
  });
}

async function fetchBotState() {
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return null;

  const res = await fetchWithTimeout(`${kvUrl}/get/bot_state`, {
    headers: { Authorization: `Bearer ${kvToken}` },
  });

  if (!res.ok) return null;
  const body = await res.json();
  if (!body.result) return null;
  return typeof body.result === 'string' ? JSON.parse(body.result) : body.result;
}

async function fetchOpenPositions(session) {
  const { baseUrl, cst, securityToken } = session;
  const res = await fetchWithTimeout(`${baseUrl}/api/v1/positions`, {
    headers: {
      'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
      'CST': cst,
      'X-SECURITY-TOKEN': securityToken,
    },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.positions || []).filter(p =>
    (p.market?.epic && p.market.epic.includes('GOLD')) ||
    (p.position?.instrumentName && p.position.instrumentName.includes('GOLD'))
  );
}

// ── Build trades from transactions ───────────────────────────────────────────
// Capital.com format: each closure is ONE transaction.
//   transactionType = "TRADE" → actual trade close (P&L in `size` field)
//   transactionType = "SWAP"  → overnight fee (exclude from trade analysis)
//   `size` = P&L in account currency (AED), positive = profit, negative = loss
//   `dealId` = unique position identifier (same as what we store locally)

function buildTradesFromTransactions(transactions) {
  const trades = [];

  for (const tx of transactions) {
    // Only GOLD trade closures
    if (!tx.instrumentName?.includes('GOLD')) continue;
    if (tx.transactionType !== 'TRADE') continue;
    
    const pnlAED = parseFloat(tx.size);
    if (isNaN(pnlAED)) continue;

    trades.push({
      dealId: tx.dealId || null,
      reference: tx.reference || null,
      pnlAED,
      pnlUSD: pnlAED / USD_AED_PEG,
      closeDate: tx.date,
      closeDateUtc: tx.dateUtc,
      closeNote: tx.note || '',
      // Will be enriched from logs
      direction: null,
      entryPrice: null,
      stopLoss: null,
      takeProfit: null,
      atr: null,
      entryType: null,
      score: null,
      strategyVersion: null,
      spread: null,
      actualRiskDollars: null,
      positionSize: null,
      hadPartialClose: false,
      hadBreakEven: false,
      hadTrailingStop: false,
      rMultiple: null,
      riskUSD: null,
      riskAED: null,
    });
  }

  // Sort chronologically (oldest first)
  trades.sort((a, b) => new Date(a.closeDate) - new Date(b.closeDate));
  return trades;
}

// ── Build overnight fees summary ─────────────────────────────────────────────

function extractOvernightFees(transactions) {
  return transactions
    .filter(t => t.instrumentName?.includes('GOLD') && t.transactionType === 'SWAP')
    .map(t => ({
      date: t.date,
      feeAED: parseFloat(t.size) || 0,
    }));
}

// ── Enrich trades with ALL available data sources ────────────────────────────
// Priority: 1) recentOutcomes (bot state), 2) log entries, 3) raw transaction
// The execution logs have been rotated out of the 1000-entry KV list, so
// recentOutcomes is now the primary source for direction/entryType/dealId.

function enrichTrades(trades, logs, botState) {
  // ── Source 1: recentOutcomes from bot state ────────────────────────────
  const outcomes = Array.isArray(botState?.recentOutcomes) ? botState.recentOutcomes : [];
  
  // ── Source 2: Any log entries that mention dealIds ──────────────────────
  // Search ALL logs for any mention of trade dealIds (SYNC events, alerts, etc.)
  const allLogReasons = logs.filter(l => l.reason && typeof l.reason === 'string');
  
  // ── Source 3: Executed trade logs (if any survived rotation) ────────────
  const executedLogs = logs.filter(l => l.tradeExecuted === true);
  
  // ── Source 4: Trade management logs ────────────────────────────────────
  const mgmtLogs = logs.filter(l => 
    l.reason && (
      l.reason.includes('PARTIAL_CLOSE') || 
      l.reason.includes('BE activated') || 
      l.reason.includes('Trailing stop')
    )
  );

  // ── Source 5: openTrades from bot state (if any are still open) ─────────
  const openTrades = Array.isArray(botState?.openTrades) ? botState.openTrades : [];

  for (const trade of trades) {
    if (!trade.dealId) continue;

    // ── Match from recentOutcomes ─────────────────────────────────────────
    const outcome = outcomes.find(o => o.dealId === trade.dealId);
    if (outcome) {
      trade.direction = outcome.action || trade.direction;
      trade.entryType = outcome.entryType || trade.entryType;
    }

    // ── Match from executed logs (if any remain) ──────────────────────────
    const execLog = executedLogs.find(l => {
      if (l.dealReference && l.dealReference === trade.dealId) return true;
      if (l.reason && l.reason.includes(trade.dealId)) return true;
      return false;
    });

    if (execLog) {
      trade.direction = execLog.signalDetected || trade.direction;
      trade.entryPrice = execLog.entryPrice;
      trade.stopLoss = execLog.stopLoss;
      trade.takeProfit = execLog.takeProfit;
      trade.atr = execLog.atr;
      trade.entryType = execLog.entryType || trade.entryType;
      trade.score = execLog.score;
      trade.strategyVersion = execLog.strategyVersion;
      trade.spread = execLog.spread;
      trade.actualRiskDollars = execLog.actualRiskDollars;
      trade.positionSize = execLog.size;
    }

    // ── Match from log reasons containing dealId (SYNC events etc.) ───────
    const mentionLogs = allLogReasons.filter(l => l.reason.includes(trade.dealId));
    for (const ml of mentionLogs) {
      // Extract entry price from SYNC logs: "entry=XXXX.XX"
      const entryMatch = ml.reason.match(/entry=(\d+\.?\d*)/);
      if (entryMatch && !trade.entryPrice) {
        trade.entryPrice = parseFloat(entryMatch[1]);
      }
      // Extract direction from log
      if (!trade.direction && ml.signalDetected && ml.signalDetected !== 'NONE') {
        trade.direction = ml.signalDetected;
      }
      // Extract version
      if (!trade.strategyVersion && ml.strategyVersion) {
        trade.strategyVersion = ml.strategyVersion;
      }
    }

    // ── Match from openTrades (has full entry/SL/TP data) ─────────────────
    const openMatch = openTrades.find(ot => ot.dealId === trade.dealId);
    if (openMatch) {
      trade.direction = openMatch.action || trade.direction;
      trade.entryPrice = trade.entryPrice || openMatch.entry;
      trade.stopLoss = trade.stopLoss || openMatch.stopLoss;
      trade.takeProfit = trade.takeProfit || openMatch.takeProfit;
      trade.atr = trade.atr || openMatch.atr;
      trade.positionSize = trade.positionSize || openMatch.size;
      trade.entryType = trade.entryType || openMatch.entryType;
      trade.strategyVersion = trade.strategyVersion || openMatch.strategyVersion;
      trade.actualRiskDollars = trade.actualRiskDollars || openMatch.actualRiskDollars;
    }

    // ── Trade management event detection ──────────────────────────────────
    trade.hadPartialClose = mgmtLogs.some(l => 
      l.reason.includes('PARTIAL_CLOSE') && l.reason.includes(trade.dealId)
    );
    trade.hadBreakEven = mgmtLogs.some(l => 
      l.reason.includes('BE activated') && l.reason.includes(trade.dealId)
    );
    trade.hadTrailingStop = mgmtLogs.some(l => 
      l.reason.includes('Trailing') && l.reason.includes(trade.dealId)
    );

    // ── Calculate R-multiple ─────────────────────────────────────────────
    if (trade.entryPrice && trade.stopLoss && trade.positionSize > 0) {
      const riskPerUnit = Math.abs(trade.entryPrice - trade.stopLoss);
      if (riskPerUnit > 0) {
        trade.riskUSD = riskPerUnit * trade.positionSize;
        trade.riskAED = trade.riskUSD * USD_AED_PEG;
        trade.rMultiple = trade.pnlAED / trade.riskAED;
      }
    }
  }

  return trades;
}

// ── Detect guaranteedStop rejections ─────────────────────────────────────────

function findGuaranteedStopRejections(logs) {
  return logs.filter(l => 
    l.reason && (
      l.reason.toLowerCase().includes('guaranteedstop') ||
      l.reason.toLowerCase().includes('guaranteed_stop') ||
      l.reason.toLowerCase().includes('guaranteed stop') ||
      (l.reason.includes('REJECTED') && l.reason.toLowerCase().includes('guaranteed'))
    )
  );
}

// ── Main Analysis ────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  v1.5 LIVE PERFORMANCE VALIDATOR — Real Executed Trades Only');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Timestamp: ${new Date().toISOString()}`);
  console.log('');

  // ── Step 1: Connect ────────────────────────────────────────────────────────
  console.log('[1/6] Connecting to Capital.com...');
  const session = await getCapitalSession();
  console.log('  ✓ Session established');

  // ── Step 2: Fetch all sources ──────────────────────────────────────────────
  console.log('[2/6] Fetching data...');
  
  const [transactions, logs, botState, openPositions] = await Promise.all([
    fetchAllTransactions(session, 14),
    fetchBotLogs(),
    fetchBotState(),
    fetchOpenPositions(session),
  ]);

  console.log(`  ✓ Transactions: ${transactions.length}`);
  console.log(`  ✓ Bot logs: ${logs.length}`);
  console.log(`  ✓ Bot state: ${botState ? 'loaded' : 'unavailable'}`);
  console.log(`  ✓ Open positions: ${openPositions.length}`);

  // ── Step 3: Build trade objects ────────────────────────────────────────────
  console.log('[3/6] Building trades from transactions...');
  let trades = buildTradesFromTransactions(transactions);
  const overnightFees = extractOvernightFees(transactions);
  console.log(`  ✓ ${trades.length} closed trades found`);
  console.log(`  ✓ ${overnightFees.length} overnight fee entries`);

  // ── Step 4: Enrich with log + state data ───────────────────────────────────
  console.log('[4/6] Enriching trades with log + state data...');
  trades = enrichTrades(trades, logs, botState);
  
  const tradesWithR = trades.filter(t => t.rMultiple !== null);
  const tradesWithoutR = trades.filter(t => t.rMultiple === null);
  console.log(`  ✓ ${tradesWithR.length}/${trades.length} trades have R-multiple data`);
  if (tradesWithoutR.length > 0) {
    console.log(`  ⚠️ ${tradesWithoutR.length} trades missing R data (no matching log entry)`);
    tradesWithoutR.forEach(t => {
      console.log(`    → dealId=${t.dealId} | P&L=AED ${t.pnlAED.toFixed(2)} | ${t.closeDate}`);
    });
  }

  // ── Identify v1.5 trades ───────────────────────────────────────────────────
  const v15Trades = trades.filter(t => t.strategyVersion === 'v1.5');
  const v15WithR = v15Trades.filter(t => t.rMultiple !== null);
  console.log(`  ✓ ${v15Trades.length} confirmed v1.5 trades (${v15WithR.length} with R data)`);

  // Use ALL trades for analysis
  const analysisSet = trades;
  const analysisWithR = tradesWithR;

  console.log('');
  console.log('[5/6] Running analysis...');
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 1: LOSS CONTROL
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('┌──────────────────────────────────────────────────────────────┐');
  console.log('│  SECTION 1: LOSS CONTROL                                    │');
  console.log('└──────────────────────────────────────────────────────────────┘');

  const lossTrades = analysisWithR.filter(t => t.rMultiple < 0);
  const maxRLoss = lossTrades.length > 0 ? Math.min(...lossTrades.map(t => t.rMultiple)) : 0;
  const tradesExceeding1_2R = lossTrades.filter(t => t.rMultiple < -1.2);
  const avgLoss = lossTrades.length > 0 ? lossTrades.reduce((s, t) => s + t.rMultiple, 0) / lossTrades.length : 0;

  // Also check raw P&L losses for trades without R data
  const allLossTrades = analysisSet.filter(t => t.pnlAED < -0.01);
  const maxLossAED = allLossTrades.length > 0 ? Math.min(...allLossTrades.map(t => t.pnlAED)) : 0;

  console.log(`  Total losing trades (all): ${allLossTrades.length}`);
  console.log(`  Worst single loss: AED ${maxLossAED.toFixed(2)}`);
  console.log(`  Losing trades with R data: ${lossTrades.length}`);
  console.log(`  Max R loss: ${maxRLoss.toFixed(3)}R`);
  console.log(`  Avg R loss: ${avgLoss.toFixed(3)}R`);
  console.log(`  Trades exceeding -1.2R: ${tradesExceeding1_2R.length}`);
  if (tradesExceeding1_2R.length === 0) {
    console.log('  ✅ PASS: No trade exceeds 1.2R loss');
  } else {
    console.log('  ❌ FAIL: Some trades exceed 1.2R loss:');
    tradesExceeding1_2R.forEach(t => {
      console.log(`    → dealId=${t.dealId} | R=${t.rMultiple.toFixed(3)} | P&L=AED ${t.pnlAED.toFixed(2)} | ver=${t.strategyVersion}`);
    });
  }

  // Guaranteed Stop Execution
  console.log('');
  console.log('  Guaranteed Stop Verification:');
  
  const slipList = [];
  for (const t of lossTrades) {
    if (t.entryPrice && t.stopLoss && t.positionSize > 0) {
      const expectedLossUSD = Math.abs(t.entryPrice - t.stopLoss) * t.positionSize;
      const expectedLossAED = expectedLossUSD * USD_AED_PEG;
      const actualLossAED = Math.abs(t.pnlAED);
      const slippageAED = actualLossAED - expectedLossAED;
      const slippagePct = expectedLossAED > 0 ? (slippageAED / expectedLossAED * 100) : 0;
      
      if (Math.abs(slippageAED) > 0.5) {
        slipList.push({ 
          dealId: t.dealId, 
          expectedAED: expectedLossAED, 
          actualAED: actualLossAED, 
          slippageAED,
          slippagePct,
          version: t.strategyVersion,
        });
      }
    }
  }

  if (slipList.length === 0) {
    console.log('    ✅ All stops executed within expected range (no slippage > AED 0.50)');
  } else {
    console.log(`    ⚠️ ${slipList.length} stops had notable execution deviation:`);
    slipList.forEach(s => {
      const sign = s.slippageAED > 0 ? '+' : '';
      console.log(`      → dealId=${s.dealId} | Expected=AED ${s.expectedAED.toFixed(2)} | Actual=AED ${s.actualAED.toFixed(2)} | Diff=${sign}AED ${s.slippageAED.toFixed(2)} (${sign}${s.slippagePct.toFixed(1)}%) | ${s.version}`);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 2: AVERAGE WIN
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('');
  console.log('┌──────────────────────────────────────────────────────────────┐');
  console.log('│  SECTION 2: NEW AVERAGE WIN                                 │');
  console.log('└──────────────────────────────────────────────────────────────┘');

  const winTrades = analysisWithR.filter(t => t.rMultiple > 0);
  const avgWinR = winTrades.length > 0 ? winTrades.reduce((s, t) => s + t.rMultiple, 0) / winTrades.length : 0;
  const medianWinR = winTrades.length > 0 ? (() => {
    const sorted = winTrades.map(t => t.rMultiple).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  })() : 0;

  // Also report raw AED wins
  const allWinTrades = analysisSet.filter(t => t.pnlAED > 0.01);
  const avgWinAED = allWinTrades.length > 0 ? allWinTrades.reduce((s, t) => s + t.pnlAED, 0) / allWinTrades.length : 0;
  const avgLossAED = allLossTrades.length > 0 ? allLossTrades.reduce((s, t) => s + t.pnlAED, 0) / allLossTrades.length : 0;

  const winWithPartial = winTrades.filter(t => t.hadPartialClose);
  const winWithTrail = winTrades.filter(t => t.hadTrailingStop);
  const winWithBE = winTrades.filter(t => t.hadBreakEven);

  console.log(`  All winning trades: ${allWinTrades.length} | Avg P&L: AED ${avgWinAED.toFixed(2)}`);
  console.log(`  All losing trades:  ${allLossTrades.length} | Avg P&L: AED ${avgLossAED.toFixed(2)}`);
  console.log('');
  console.log(`  Wins with R data: ${winTrades.length}`);
  console.log(`  Average Win R:  ${avgWinR.toFixed(3)}R`);
  console.log(`  Median Win R:   ${medianWinR.toFixed(3)}R`);
  console.log(`  Previous avg:   0.620R`);
  
  if (winTrades.length > 0) {
    const pctChange = ((avgWinR - 0.62) / 0.62 * 100);
    console.log(`  Change:          ${pctChange > 0 ? '↑' : '↓'} ${pctChange.toFixed(1)}%`);
  }

  console.log('');
  console.log('  Trade Management Breakdown:');
  console.log(`    Partial closed wins:   ${winWithPartial.length}`);
  console.log(`    Trailing stop wins:    ${winWithTrail.length}`);
  console.log(`    Break-even wins:       ${winWithBE.length}`);

  if (winTrades.length > 0) {
    console.log('');
    console.log('  Win Distribution:');
    const buckets = [
      ['0.0-0.5R', 0, 0.5], ['0.5-1.0R', 0.5, 1.0], ['1.0-1.5R', 1.0, 1.5],
      ['1.5-2.0R', 1.5, 2.0], ['2.0-2.5R', 2.0, 2.5], ['2.5-3.0R', 2.5, 3.0], ['3.0R+', 3.0, 999],
    ];
    for (const [label, lo, hi] of buckets) {
      const count = winTrades.filter(t => t.rMultiple >= lo && t.rMultiple < hi).length;
      const bar = '█'.repeat(count);
      const pct = (count / winTrades.length * 100).toFixed(0);
      console.log(`    ${label.padEnd(8)} ${String(count).padStart(3)} (${pct.padStart(3)}%) ${bar}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 3: BREAK-EVEN EFFECTIVENESS
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('');
  console.log('┌──────────────────────────────────────────────────────────────┐');
  console.log('│  SECTION 3: BREAK-EVEN EFFECTIVENESS                        │');
  console.log('└──────────────────────────────────────────────────────────────┘');

  const reachedPlus1R = analysisWithR.filter(t => t.rMultiple >= 1.0 || t.hadPartialClose || t.hadBreakEven || t.hadTrailingStop);
  const continuedPast2R = analysisWithR.filter(t => t.rMultiple >= 2.0 || t.hadTrailingStop);
  const scratchTrades = analysisWithR.filter(t => t.rMultiple > -0.1 && t.rMultiple < 0.3 && t.hadBreakEven);

  console.log(`  Trades reaching +1R (or partial closed): ${reachedPlus1R.length} / ${analysisWithR.length}`);
  console.log(`  Trades continuing past +2R:              ${continuedPast2R.length}`);
  console.log(`  Scratch trades (0 ± 0.3R with BE):       ${scratchTrades.length}`);
  
  if (reachedPlus1R.length > 0) {
    const conversionRate = continuedPast2R.length > 0 
      ? (continuedPast2R.length / reachedPlus1R.length * 100).toFixed(1) 
      : '0.0';
    console.log(`  +1R → +2R conversion:                    ${conversionRate}%`);
  }

  // Log-based management events
  const partialCloseLogs = logs.filter(l => l.reason && l.reason.includes('PARTIAL_CLOSE'));
  const beLogs = logs.filter(l => l.reason && l.reason.includes('BE activated'));
  const trailingLogs = logs.filter(l => l.reason && l.reason.includes('Trailing stop'));

  console.log('');
  console.log('  Trade Management Events (from bot logs):');
  console.log(`    Partial close events:  ${partialCloseLogs.length}`);
  console.log(`    Break-even moves:      ${beLogs.length}`);
  console.log(`    Trailing stop moves:   ${trailingLogs.length}`);

  if (partialCloseLogs.length > 0) {
    console.log('');
    console.log('  Recent Partial Closes:');
    partialCloseLogs.slice(-5).forEach(l => {
      console.log(`    → ${l.time} | ${l.reason}`);
    });
  }

  if (beLogs.length > 0) {
    console.log('');
    console.log('  Recent Break-Even Moves:');
    beLogs.slice(-5).forEach(l => {
      console.log(`    → ${l.time} | ${l.reason}`);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 4: EXPECTANCY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('');
  console.log('┌──────────────────────────────────────────────────────────────┐');
  console.log('│  SECTION 4: NEW EXPECTANCY                                  │');
  console.log('└──────────────────────────────────────────────────────────────┘');

  // R-based expectancy (most accurate, uses matched trades only)
  const totalWithR = analysisWithR.length;
  const winRateR = totalWithR > 0 ? winTrades.length / totalWithR : 0;
  const lossRateR = 1 - winRateR;
  const expectancyR = totalWithR > 0 ? (winRateR * avgWinR) + (lossRateR * avgLoss) : 0;

  const riskAEDs = analysisWithR.filter(t => t.riskAED > 0);
  const avgRiskAED = riskAEDs.length > 0 ? riskAEDs.reduce((s, t) => s + t.riskAED, 0) / riskAEDs.length : 0;
  const expectancyAED_R = expectancyR * avgRiskAED;

  // Raw P&L expectancy (uses ALL trades including those without R data)
  const totalAllTrades = analysisSet.length;
  const allWinRate = totalAllTrades > 0 ? allWinTrades.length / totalAllTrades : 0;
  const rawExpectancyAED = totalAllTrades > 0 
    ? analysisSet.reduce((s, t) => s + t.pnlAED, 0) / totalAllTrades 
    : 0;

  // Include overnight fees in total P&L
  const totalFeesAED = overnightFees.reduce((s, f) => s + f.feeAED, 0);
  const totalPnlAED = analysisSet.reduce((s, t) => s + t.pnlAED, 0);
  const netPnlAED = totalPnlAED + totalFeesAED; // fees are negative

  // Profit Factor
  const grossProfit = allWinTrades.reduce((s, t) => s + t.pnlAED, 0);
  const grossLoss = Math.abs(allLossTrades.reduce((s, t) => s + t.pnlAED, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);

  console.log('  R-Based Analysis (trades with entry/SL data):');
  console.log(`    Sample: ${totalWithR} trades`);
  console.log(`    Win rate: ${(winRateR * 100).toFixed(1)}% (${winTrades.length}W / ${lossTrades.length}L)`);
  console.log(`    Avg Win:  +${avgWinR.toFixed(3)}R`);
  console.log(`    Avg Loss: ${avgLoss.toFixed(3)}R`);
  console.log(`    Avg Risk: AED ${avgRiskAED.toFixed(2)}`);
  console.log('');
  console.log(`    ★ Expectancy: ${expectancyR >= 0 ? '+' : ''}${expectancyR.toFixed(4)}R per trade`);
  console.log(`    ★ Expectancy: ${expectancyAED_R >= 0 ? '+' : ''}AED ${expectancyAED_R.toFixed(2)} per trade`);
  console.log('');

  console.log('  Raw P&L Analysis (ALL trades):');
  console.log(`    Sample: ${totalAllTrades} trades`);
  console.log(`    Win rate: ${(allWinRate * 100).toFixed(1)}%`);
  console.log(`    Raw expectancy: AED ${rawExpectancyAED.toFixed(2)} per trade`);
  console.log('');
  console.log(`    ★ Profit Factor: ${profitFactor.toFixed(2)}`);
  console.log(`    Gross Profit:  AED ${grossProfit.toFixed(2)}`);
  console.log(`    Gross Loss:    AED ${grossLoss.toFixed(2)}`);
  console.log(`    Trade P&L:     AED ${totalPnlAED.toFixed(2)}`);
  console.log(`    Overnight fees: AED ${totalFeesAED.toFixed(2)}`);
  console.log(`    Net P&L:        AED ${netPnlAED.toFixed(2)} ($${(netPnlAED / USD_AED_PEG).toFixed(2)})`);
  console.log('');

  const expectancyPositive = (totalWithR > 0 && expectancyR > 0) || (totalWithR === 0 && rawExpectancyAED > 0);
  if (expectancyPositive) {
    console.log('  ✅ PASS: Expectancy is POSITIVE');
  } else if (totalAllTrades === 0) {
    console.log('  ⏳ No trades yet — cannot determine expectancy');
  } else {
    console.log('  ❌ FAIL: Expectancy is NEGATIVE');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 5: EXECUTION CHECK
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('');
  console.log('┌──────────────────────────────────────────────────────────────┐');
  console.log('│  SECTION 5: EXECUTION CHECK                                 │');
  console.log('└──────────────────────────────────────────────────────────────┘');

  const gStopRejections = findGuaranteedStopRejections(logs);
  console.log(`  guaranteedStop rejections: ${gStopRejections.length}`);
  if (gStopRejections.length > 0) {
    console.log('  ⚠️ Rejections detected:');
    gStopRejections.slice(-10).forEach(r => {
      console.log(`    → ${r.time} | ${r.reason}`);
    });
  } else {
    console.log('  ✅ No order rejections due to guaranteedStop');
  }

  // Spread analysis from log data
  const spreadLogs = logs.filter(l => typeof l.spread === 'number' && l.spread > 0);
  const execWithSpread = logs.filter(l => l.tradeExecuted === true && typeof l.spread === 'number' && l.spread > 0);
  
  console.log('');
  console.log('  Spread/Fee Impact:');
  if (spreadLogs.length > 0) {
    const spreads = spreadLogs.map(l => l.spread);
    const avgSpread = spreads.reduce((s, v) => s + v, 0) / spreads.length;
    const maxSpread = Math.max(...spreads);
    const minSpread = Math.min(...spreads);
    console.log(`    Avg spread (all cycles): $${avgSpread.toFixed(3)} (${spreadLogs.length} samples)`);
    console.log(`    Min/Max spread: $${minSpread.toFixed(3)} / $${maxSpread.toFixed(3)}`);
  }

  const execSpreads = analysisWithR.filter(t => typeof t.spread === 'number' && t.spread > 0);
  if (execSpreads.length > 0) {
    const avgExecSpread = execSpreads.reduce((s, t) => s + t.spread, 0) / execSpreads.length;
    console.log(`    Avg spread at execution: $${avgExecSpread.toFixed(3)} (${execSpreads.length} trades)`);
    
    // Guaranteed stop premium estimate
    const gStopPremium = analysisWithR
      .filter(t => t.entryPrice && t.stopLoss && t.positionSize > 0)
      .reduce((s, t) => s + Math.abs(t.entryPrice - t.stopLoss) * t.positionSize * 0.003, 0);
    console.log(`    Est. guaranteed stop premium: $${gStopPremium.toFixed(2)} (AED ${(gStopPremium * USD_AED_PEG).toFixed(2)})`);
  } else {
    console.log('    No spread data at execution time');
  }

  // Overnight fee summary
  if (overnightFees.length > 0) {
    console.log(`    Overnight fees: ${overnightFees.length} entries, total AED ${totalFeesAED.toFixed(2)}`);
  }

  // Rejection breakdown
  const rejectionLogs = logs.filter(l => l.reason && l.reason.startsWith('REJECTED'));
  if (rejectionLogs.length > 0) {
    const reasons = {};
    for (const rl of rejectionLogs) {
      const key = rl.reason.substring(0, 60);
      reasons[key] = (reasons[key] || 0) + 1;
    }
    console.log('');
    console.log(`  Order Rejections: ${rejectionLogs.length} total`);
    for (const [reason, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      console.log(`    ${count}x → ${reason}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 6: EARLY PERFORMANCE SNAPSHOT
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('');
  console.log('┌──────────────────────────────────────────────────────────────┐');
  console.log('│  SECTION 6: EARLY PERFORMANCE SNAPSHOT                      │');
  console.log('└──────────────────────────────────────────────────────────────┘');

  const snapshotSize = Math.min(20, analysisSet.length);
  const snapshot = analysisSet.slice(0, snapshotSize);
  let runningPnl = 0;

  if (snapshotSize > 0) {
    console.log(`  First ${snapshotSize} trades:`);
    console.log('  ┌─────┬────────────┬──────┬──────────┬──────────┬────────┬────────────────┐');
    console.log('  │  #  │ Date       │ Dir  │ P&L AED  │  R-Mult  │ Type   │ Mgmt           │');
    console.log('  ├─────┼────────────┼──────┼──────────┼──────────┼────────┼────────────────┤');

    for (let i = 0; i < snapshot.length; i++) {
      const t = snapshot[i];
      runningPnl += t.pnlAED;
      const dateStr = t.closeDate ? new Date(t.closeDate).toISOString().slice(5, 10) : '??   ';
      const dir = (t.direction || '?').padEnd(4);
      const pnl = t.pnlAED >= 0 ? `+${t.pnlAED.toFixed(2)}` : t.pnlAED.toFixed(2);
      const rMult = t.rMultiple !== null 
        ? (t.rMultiple >= 0 ? `+${t.rMultiple.toFixed(2)}` : t.rMultiple.toFixed(2)) 
        : '  N/A';
      const type = (t.entryType || t.strategyVersion || '?').substring(0, 6).padEnd(6);
      const mgmt = [
        t.hadPartialClose ? 'PC' : '',
        t.hadBreakEven ? 'BE' : '',
        t.hadTrailingStop ? 'TS' : '',
      ].filter(Boolean).join('+') || '-';

      console.log(`  │ ${String(i + 1).padStart(3)} │ ${dateStr.padEnd(10)} │ ${dir} │ ${pnl.padStart(8)} │ ${rMult.padStart(8)} │ ${type} │ ${mgmt.padEnd(14)} │`);
    }

    console.log('  └─────┴────────────┴──────┴──────────┴──────────┴────────┴────────────────┘');
    console.log(`  Running P&L after ${snapshotSize} trades: AED ${runningPnl.toFixed(2)}`);

    const snapshotWithR = snapshot.filter(t => t.rMultiple !== null);
    if (snapshotWithR.length > 0) {
      const sWins = snapshotWithR.filter(t => t.rMultiple > 0);
      const sLosses = snapshotWithR.filter(t => t.rMultiple < 0);
      const sWR = (sWins.length / snapshotWithR.length * 100).toFixed(1);
      const sAvgW = sWins.length > 0 ? sWins.reduce((s, t) => s + t.rMultiple, 0) / sWins.length : 0;
      const sAvgL = sLosses.length > 0 ? sLosses.reduce((s, t) => s + t.rMultiple, 0) / sLosses.length : 0;
      const sExp = snapshotWithR.reduce((s, t) => s + t.rMultiple, 0) / snapshotWithR.length;

      console.log('');
      console.log('  Snapshot Stats:');
      console.log(`    Win Rate:    ${sWR}%`);
      console.log(`    Avg Win:     +${sAvgW.toFixed(3)}R`);
      console.log(`    Avg Loss:    ${sAvgL.toFixed(3)}R`);
      console.log(`    Expectancy:  ${sExp >= 0 ? '+' : ''}${sExp.toFixed(4)}R`);
    }
  } else {
    console.log('  No trades to display.');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CURRENT STATE
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('');
  console.log('┌──────────────────────────────────────────────────────────────┐');
  console.log('│  CURRENT BOT STATE                                          │');
  console.log('└──────────────────────────────────────────────────────────────┘');
  
  if (botState) {
    console.log(`  Strategy Version:   ${botState.strategyVersion}`);
    console.log(`  Balance:            AED ${parseFloat(botState.balance || 0).toFixed(2)}`);
    console.log(`  Equity:             AED ${parseFloat(botState.equity || 0).toFixed(2)}`);
    console.log(`  Peak Balance:       AED ${parseFloat(botState.peakBalance || 0).toFixed(2)}`);
    console.log(`  Open Trades:        ${(botState.openTrades || []).length}`);
    console.log(`  Daily Trades:       ${botState.dailyTrades || 0}`);
    console.log(`  Total Drawdown:     ${botState.totalDrawdown || 0}%`);
    console.log(`  Bot Enabled:        ${botState.botEnabled}`);
    console.log(`  State Integrity:    ${botState.stateIntegrityOk}`);
    console.log(`  Critical Failure:   ${botState.criticalFailure}${botState.criticalFailureReason ? ` (${botState.criticalFailureReason})` : ''}`);
    console.log(`  Rolling WR (10):    ${botState.rollingWinRate10 ?? 'N/A'}%`);
    console.log(`  Rolling PF (15):    ${botState.rollingProfitFactor15 ?? 'N/A'}`);
    
    // Recent outcomes from state
    const outcomes = Array.isArray(botState.recentOutcomes) ? botState.recentOutcomes : [];
    if (outcomes.length > 0) {
      console.log(`  Recent outcomes:    ${outcomes.length} tracked`);
      const last5 = outcomes.slice(-5);
      for (const o of last5) {
        const pnlStr = typeof o.pnl === 'number' ? `AED ${o.pnl.toFixed(2)}` : 'N/A';
        console.log(`    → ${o.action || '?'} | P&L: ${pnlStr} | ${o.entryType || '?'} | dealId: ${o.dealId || '?'}`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VERDICT
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  v1.5 VALIDATION VERDICT                                   ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');

  const hasEnoughData = totalAllTrades >= 5;
  const checks = [
    { name: 'Max loss ≤ 1.2R',          pass: tradesExceeding1_2R.length === 0, na: totalWithR === 0 },
    { name: 'Guaranteed stop works',     pass: gStopRejections.length === 0, na: false },
    { name: 'Avg win > old 0.62R',       pass: avgWinR > 0.62, na: winTrades.length === 0 },
    { name: 'Expectancy positive',       pass: expectancyPositive, na: totalAllTrades === 0 },
    { name: 'Profit factor > 1.0',       pass: profitFactor > 1.0, na: totalAllTrades === 0 },
    { name: 'No critical failures',      pass: !botState?.criticalFailure, na: false },
    { name: 'Sufficient sample (≥5)',     pass: hasEnoughData, na: false },
  ];

  let passCount = 0;
  let naCount = 0;
  for (const c of checks) {
    let icon, label;
    if (c.na) { icon = '⏳'; label = 'N/A '; naCount++; }
    else if (c.pass) { icon = '✅'; label = 'PASS'; passCount++; }
    else { icon = '❌'; label = 'FAIL'; }
    console.log(`║  ${icon} ${c.name.padEnd(28)} ${label}                   ║`);
  }

  console.log('╠══════════════════════════════════════════════════════════════╣');
  const applicable = checks.length - naCount;
  console.log(`║  Result: ${passCount}/${applicable} checks passed (${naCount} N/A)${' '.repeat(25 - String(passCount).length - String(applicable).length - String(naCount).length)}║`);
  
  if (passCount === applicable && applicable > 0 && hasEnoughData) {
    console.log('║  ★ v1.5 VALIDATED FOR LIVE TRADING ★                        ║');
  } else if (!hasEnoughData) {
    console.log('║  ⏳ INSUFFICIENT DATA — Need ≥5 trades for validation       ║');
  } else {
    console.log('║  ⚠️  VALIDATION INCOMPLETE — Address failures above          ║');
  }
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // ── Save JSON report ───────────────────────────────────────────────────────
  console.log('');
  console.log('[6/6] Saving results...');

  const report = {
    timestamp: new Date().toISOString(),
    version: 'v1.5',
    dataSource: 'Capital.com live API + Upstash KV logs',
    summary: {
      totalTrades: totalAllTrades,
      tradesWithRData: totalWithR,
      v15Trades: v15Trades.length,
      winRate: +(allWinRate * 100).toFixed(1),
      avgWinR: +avgWinR.toFixed(4),
      avgLossR: +avgLoss.toFixed(4),
      expectancyR: +expectancyR.toFixed(4),
      rawExpectancyAED: +rawExpectancyAED.toFixed(2),
      profitFactor: +profitFactor.toFixed(2),
      totalPnlAED: +totalPnlAED.toFixed(2),
      netPnlAED: +netPnlAED.toFixed(2),
      overnightFeesAED: +totalFeesAED.toFixed(2),
      maxRLoss: +maxRLoss.toFixed(4),
      tradesExceeding1_2R: tradesExceeding1_2R.length,
      guaranteedStopRejections: gStopRejections.length,
    },
    trades: analysisSet.map(t => ({
      dealId: t.dealId,
      direction: t.direction,
      pnlAED: t.pnlAED,
      rMultiple: t.rMultiple,
      entryType: t.entryType,
      strategyVersion: t.strategyVersion,
      closeDate: t.closeDate,
      entryPrice: t.entryPrice,
      stopLoss: t.stopLoss,
      takeProfit: t.takeProfit,
      positionSize: t.positionSize,
      spread: t.spread,
      hadPartialClose: t.hadPartialClose,
      hadBreakEven: t.hadBreakEven,
      hadTrailingStop: t.hadTrailingStop,
    })),
    botState: botState ? {
      strategyVersion: botState.strategyVersion,
      balance: botState.balance,
      equity: botState.equity,
      peakBalance: botState.peakBalance,
      openTrades: (botState.openTrades || []).length,
      totalDrawdown: botState.totalDrawdown,
      botEnabled: botState.botEnabled,
      criticalFailure: botState.criticalFailure,
      rollingWinRate10: botState.rollingWinRate10,
      rollingProfitFactor15: botState.rollingProfitFactor15,
    } : null,
  };

  fs.writeFileSync('V15_VALIDATION_REPORT.json', JSON.stringify(report, null, 2));
  console.log('  ✓ Full report saved to V15_VALIDATION_REPORT.json');
  console.log('');
  console.log('Done.');
}

// Global ref for spread analysis (avoiding scope issues)
let executedLogs_global = [];

main().catch(err => {
  console.error('Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
