// execution.js — Place and track orders on Capital.com.
// Session is created once in cron.js and passed in — no extra auth calls here.
// Only runs after risk.js returns 'APPROVED'.
//
// ── CFD SIZING MODEL (Capital.com GOLD) ──────────────────────────────────────
// Instrument : GOLD (XAU/USD CFD)
// Unit       : troy ounces (oz) — size field in the API is in oz
// Min size   : 0.01 oz
// Max leverage (retail): 20:1  →  margin rate = 5% of notional value
// Notional   : size (oz) × current price (USD/oz)
// Margin req : notional × 0.05
//
// P&L per $1 move in gold = size (oz) × $1 → e.g. 0.01 oz → $0.01/dollar move in gold
//
// RISK FORMULA (leverage-aware):
//   actualRiskDollars = size × stopDistance          (size in oz, stopDistance in $/oz)
//   This is independent of leverage — leverage only affects margin, NOT P&L per dollar.
//   So the old formula IS correct for P&L risk:
//     size = riskAmount / stopDistance
//   Leverage matters for: how much margin Capital.com holds from your balance.
//
// HARD CAPS (CRITICAL FINANCIAL SAFETY):
//   MAX single-trade risk = 2% of live balance — scales at any account size
//   MAX position size     = 1.0 oz
//   MIN position size     = 0.01 oz (Capital.com minimum)
//   MIN stop distance     = $0.50 (prevents gigantic positions from tiny stops)
//   Margin buffer         = available margin must be ≥ required margin × 1.5 (50% buffer)

import { fetchWithTimeout } from './fetch.js';
import { saveStateCritical } from './state.js';
import { randomUUID, createHash } from 'node:crypto';

// GOLD CFD Constants
const GOLD_MARGIN_RATE  = 0.05;   // 5% margin for retail (20:1 leverage)
const GOLD_LEVERAGE     = 20;     // Max retail leverage
const MIN_SIZE          = 0.01;   // Capital.com minimum lot size for GOLD (oz)
const MAX_SIZE          = 1.0;    // Hard cap: max oz per trade
const MAX_RISK_PCT      = 0.02;   // Max risk per trade as % of balance (2%)
const MIN_STOP_DISTANCE = 0.50;   // Minimum stop distance in $/oz
const MARGIN_BUFFER     = 1.5;    // Must have 1.5× required margin available

// ── Multi-Currency Configuration ──────────────────────────────────────────────
// The user's account is in AED, but GOLD is priced in USD.
// We must convert the AED balance to USD before calculating risk-based size.
// AED is pegged to USD at 3.6725.
const USD_AED_PEG = 3.6725;
const EXTREME_ATR_MULTIPLIER = 4;
const EXTREME_PRICE_PCT = 0.02;
const MAX_PORTFOLIO_WORST_CASE_EQUITY_PCT = 0.15;

function buildIdempotencyKey(signal) {
  const seed = `${signal.id}|${signal.action}|${signal.entryPrice}|${signal.stopLoss}|${signal.takeProfit}`;
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 24);
  return `gold-${hash}`;
}

function extractStrictFilledSize(confirmData) {
  const affected = Array.isArray(confirmData?.affectedDeals) ? confirmData.affectedDeals : [];
  if (affected.length === 0) {
    return { ok: false, reason: 'MISSING_FILL_BREAKDOWN', filledSize: null };
  }

  let sum = 0;
  for (const deal of affected) {
    const sz = Number(deal?.size ?? deal?.dealSize ?? deal?.filledSize);
    if (!Number.isFinite(sz) || sz <= 0) {
      return { ok: false, reason: 'INVALID_FILL_BREAKDOWN', filledSize: null };
    }
    sum += sz;
  }

  if (!Number.isFinite(sum) || sum <= 0) {
    return { ok: false, reason: 'INVALID_FILL_SUM', filledSize: null };
  }

  return { ok: true, reason: null, filledSize: sum };
}

function normalizeDirection(rawDirection) {
  const direction = String(rawDirection || '').toUpperCase();
  if (direction === 'BUY' || direction === 'SELL') return direction;
  return null;
}

function normalizePositiveSize(rawSize) {
  const size = Number(rawSize);
  if (!Number.isFinite(size) || size <= 0) return null;
  return size;
}

function sizesMatchExactly(left, right) {
  const a = normalizePositiveSize(left);
  const b = normalizePositiveSize(right);
  if (a === null || b === null) return false;
  return a.toFixed(6) === b.toFixed(6);
}

function calculateDynamicWorstCaseMoveUsd(currentPrice, atr) {
  const px = Number(currentPrice);
  const atrValue = Number(atr);
  if (!Number.isFinite(px) || px <= 0) return null;
  if (!Number.isFinite(atrValue) || atrValue <= 0) return null;

  const atrExtremeMove = atrValue * EXTREME_ATR_MULTIPLIER;
  const pctExtremeMove = px * EXTREME_PRICE_PCT;
  const worstCaseMoveUsd = Math.max(atrExtremeMove, pctExtremeMove);

  if (!Number.isFinite(worstCaseMoveUsd) || worstCaseMoveUsd <= 0) return null;
  return worstCaseMoveUsd;
}

async function fetchDealConfirmation(session, dealReference) {
  const { baseUrl, cst, securityToken } = session;
  const res = await fetchWithTimeout(`${baseUrl}/api/v1/confirms/${dealReference}`, {
    headers: {
      'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
      'CST': cst,
      'X-SECURITY-TOKEN': securityToken,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`Order confirmation failed (HTTP ${res.status}): ${body}`);
  }
  return await res.json();
}

function calculatePortfolioWorstCaseRiskAED(openTrades, extraSize, worstCaseMoveUsd) {
  const move = Number(worstCaseMoveUsd);
  if (!Number.isFinite(move) || move <= 0) {
    return { ok: false, reason: 'INVALID_WORST_CASE_MOVE', riskAED: null };
  }

  const activeTrades = Array.isArray(openTrades) ? openTrades : [];
  let totalUsd = 0;

  for (const trade of activeTrades) {
    const size = normalizePositiveSize(trade?.size);
    const direction = normalizeDirection(trade?.action ?? trade?.direction);
    if (size === null || direction === null) {
      return { ok: false, reason: 'INVALID_OPEN_TRADE_FOR_RISK_MODEL', riskAED: null };
    }
    totalUsd += size * move;
  }

  const pendingSize = normalizePositiveSize(extraSize);
  if (pendingSize === null) {
    return { ok: false, reason: 'INVALID_PENDING_SIZE_FOR_RISK_MODEL', riskAED: null };
  }
  totalUsd += pendingSize * move;

  return { ok: true, reason: null, riskAED: totalUsd * USD_AED_PEG };
}

export async function verifyExecutionCertainty(session, botState) {
  try {
    if (botState.criticalFailure === true) {
      return { ok: false, reason: 'CRITICAL_FAILURE_ACTIVE' };
    }

    if (botState.pendingOrder && botState.pendingOrder.status !== 'cleared') {
      return { ok: false, reason: 'PENDING_ORDER_UNCERTAIN' };
    }

    const brokerPositions = await fetchBrokerPositions(session);
    if (brokerPositions === null) {
      return { ok: false, reason: 'BROKER_STATE_UNAVAILABLE' };
    }

    const brokerByRef = new Map();
    for (const p of brokerPositions) {
      const ref = p.position?.dealReference;
      if (!ref) {
        return { ok: false, reason: 'EXECUTION_STATE_UNCERTAIN:BROKER_POSITION_MISSING_REFERENCE' };
      }

      if (brokerByRef.has(ref)) {
        return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:DUPLICATE_BROKER_REFERENCE:${ref}` };
      }

      const brokerSize = normalizePositiveSize(p.position?.size ?? p.position?.dealSize);
      const brokerDirection = normalizeDirection(p.position?.direction);
      if (brokerSize === null || brokerDirection === null) {
        return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:INVALID_BROKER_POSITION:${ref}` };
      }

      brokerByRef.set(ref, {
        size: brokerSize,
        direction: brokerDirection,
      });
    }

    const localTrades = Array.isArray(botState.openTrades) ? botState.openTrades : [];
    const localByRef = new Map();
    for (const t of localTrades) {
      const ref = t?.dealReference;
      if (!ref) {
        return { ok: false, reason: 'EXECUTION_STATE_UNCERTAIN:LOCAL_TRADE_MISSING_REFERENCE' };
      }

      if (localByRef.has(ref)) {
        return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:DUPLICATE_LOCAL_REFERENCE:${ref}` };
      }

      const localSize = normalizePositiveSize(t?.size);
      const localDirection = normalizeDirection(t?.action ?? t?.direction);
      if (localSize === null || localDirection === null) {
        return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:INVALID_LOCAL_POSITION:${ref}` };
      }

      localByRef.set(ref, {
        size: localSize,
        direction: localDirection,
      });
    }

    for (const [ref, localPos] of localByRef) {
      const brokerPos = brokerByRef.get(ref);
      if (!brokerPos) {
        return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:LOCAL_NOT_ON_BROKER:${ref}` };
      }

      if (!sizesMatchExactly(localPos.size, brokerPos.size)) {
        return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:SIZE_MISMATCH:${ref}` };
      }

      if (localPos.direction !== brokerPos.direction) {
        return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:DIRECTION_MISMATCH:${ref}` };
      }
    }

    for (const ref of brokerByRef.keys()) {
      if (!localByRef.has(ref)) {
        return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:BROKER_NOT_LOCAL:${ref}` };
      }
    }

    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `EXECUTION_CERTAINTY_ERROR:${err.message}` };
  }
}


// ── fetchAccountData ──────────────────────────────────────────────────────────
// Fetch real-time account balance, equity, and available margin from Capital.com.
// Returns { balance, equity, availableMargin } or null on failure.
export async function fetchAccountData(session) {
  try {
    const { baseUrl, cst, securityToken } = session;
    const res = await fetchWithTimeout(`${baseUrl}/api/v1/accounts`, {
      headers: {
        'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
        'CST':              cst,
        'X-SECURITY-TOKEN': securityToken,
      },
    });
    if (!res.ok) return null;
    let data;
    try { data = await res.json(); } catch { return null; }
    const account = data.accounts?.[0];
    if (!account) return null;

    const balance         = parseFloat(account.balance?.balance);
    const equity          = parseFloat(account.balance?.equity ?? account.balance?.balance);
    const availableMargin = parseFloat(account.balance?.available);  // Capital.com: "available" = free margin

    if (isNaN(balance) || balance < 0) return null;
    return {
      balance,
      equity:          isNaN(equity) ? balance : equity,
      availableMargin: isNaN(availableMargin) ? balance : availableMargin,
    };
  } catch (err) {
    console.error('[EXEC] fetchAccountData error:', err.message);
    return null;
  }
}


// ── fetchBrokerPositions ──────────────────────────────────────────────────────
// Fetch ALL open positions from Capital.com. Used for state reconciliation.
export async function fetchBrokerPositions(session) {
  try {
    const { baseUrl, cst, securityToken } = session;
    const res = await fetchWithTimeout(`${baseUrl}/api/v1/positions`, {
      headers: {
        'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
        'CST':              cst,
        'X-SECURITY-TOKEN': securityToken,
      },
    });

    if (!res.ok) {
      console.warn(`[EXEC] fetchBrokerPositions: HTTP ${res.status}`);
      return null;
    }

    let data;
    try { data = await res.json(); } catch { return null; }
    const positions = data.positions || [];
    
    // Filter to GOLD positions only
    return positions.filter(p =>
      (p.market?.epic && p.market.epic.includes('GOLD')) ||
      (p.position?.instrumentName && p.position.instrumentName.includes('GOLD'))
    );
  } catch (err) {
    console.error('[EXEC] fetchBrokerPositions error:', err.message);
    return null;
  }
}


// ── syncBalance ───────────────────────────────────────────────────────────────
// Syncs BOTH balance (closed P&L only) and equity (includes unrealized P&L).
// Balance is the source of truth for performance tracking.
// Equity is used for risk monitoring only.
export async function syncBalance(session, botState) {
  try {
    const accountData = await fetchAccountData(session);
    if (!accountData) {
      console.error('[EXEC] Balance sync: failed to fetch account data');
      return botState;
    }

    const { balance: realBalance, equity: realEquity, availableMargin } = accountData;

    botState.balance         = realBalance;
    botState.equity          = realEquity;
    botState.availableMargin = availableMargin;

    console.log(
      `[EXEC] Balance synced: ` +
      `balance=AED ${realBalance.toFixed(2)} | ` +
      `equity=AED ${realEquity.toFixed(2)} | ` +
      `margin=AED ${availableMargin.toFixed(2)} | ` +
      `unrealizedPnL=AED ${(realEquity - realBalance).toFixed(2)}`
    );
    return botState;

  } catch (err) {
    console.error('[EXEC] Balance sync error:', err.message);
    return botState;
  }
}

/**
 * Fetches the actual realized P&L for a closed trade from Capital.com transaction history.
 * @param {Object} session - Capital.com session
 * @param {string} dealReference - The trade's unique deal reference
 * @param {number} [openedAt] - Optional timestamp when the trade was opened
 * @returns {Promise<number|null>} - The profit/loss in account currency, or null if not found
 */
export async function fetchClosedTradePnl(session, dealReference, openedAt) {
  try {
    const { baseUrl, cst, securityToken } = session;

    let from;
    if (openedAt && !isNaN(openedAt)) {
      from = new Date(openedAt - 60 * 60 * 1000).toISOString().split('.')[0];
    } else {
      from = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().split('.')[0];
    }

    const to = new Date().toISOString().split('.')[0];
    const url = `${baseUrl}/api/v1/history/transactions?from=${from}&to=${to}`;

    const res = await fetchWithTimeout(url, {
      headers: {
        'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
        'CST': cst,
        'X-SECURITY-TOKEN': securityToken,
      },
    });

    if (!res.ok) return null;

    const data = await res.json();
    const transactions = Array.isArray(data.transactions) ? data.transactions : [];

    const tx = transactions.find(t => {
      const refMatch = t.dealReference === dealReference || t.dealId === dealReference || t.reference === dealReference;
      if (!refMatch) return false;
      const note = String(t.note || '').toLowerCase();
      return note.includes('closed') || t.profitAndLoss != null;
    });

    if (!tx) return null;
    const pnl = parseFloat(tx.profitAndLoss);
    return isNaN(pnl) ? null : pnl;
  } catch (_) {
    return null;
  }
}

/**
 * Fetches actual trade statistics from Capital.com transaction history.
 * SINGLE SOURCE OF TRUTH for all trade metrics.
 */
export async function fetchBrokerTradeStats(session) {
  try {
    const { baseUrl, cst, securityToken } = session;
    
    // Look back 30 days to capture ALL recent trades
    const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('.')[0];
    const to = new Date().toISOString().split('.')[0];
    
    // 1. Fetch Transactions
    const historyUrl = `${baseUrl}/api/v1/history/transactions?from=${from}&to=${to}`;
    const hRes = await fetchWithTimeout(historyUrl, {
      headers: { 'X-CAP-API-KEY': process.env.CAPITAL_API_KEY, 'CST': cst, 'X-SECURITY-TOKEN': securityToken },
    });

    // 2. Fetch Open Positions
    const posUrl = `${baseUrl}/api/v1/positions`;
    const pRes = await fetchWithTimeout(posUrl, {
      headers: { 'X-CAP-API-KEY': process.env.CAPITAL_API_KEY, 'CST': cst, 'X-SECURITY-TOKEN': securityToken },
    });

    if (!hRes.ok) {
      console.warn(`[EXEC] fetchBrokerTradeStats: history API error ${hRes.status}`);
      return null;
    }

    const hData = await hRes.json();
    const transactions = hData.transactions || [];
    const goldTransactions = transactions.filter(t => t.instrumentName?.includes('GOLD'));
    
    // 3. Process open positions
    let livePositions = [];
    if (pRes.ok) {
      const pData = await pRes.json();
      livePositions = (pData.positions || []).filter(p => 
        (p.market?.epic && p.market.epic.includes('GOLD')) || 
        (p.position?.instrumentName && p.position.instrumentName.includes('GOLD'))
      );
    }

    // UAE Time Constants for filtering
    const uaeNow = new Date(Date.now() + 4 * 60 * 60 * 1000);
    const todayStr = uaeNow.toISOString().slice(0, 10);
    
    let todayExecuted = 0;
    let todayBuys = 0;
    let todaySells = 0;
    const pnlsToday = [];
    const pnls30d = [];

    // Process closed trades
    goldTransactions.forEach(t => {
      let pnlValue = parseFloat(t.profitAndLoss);
      const isToday = new Date(new Date(t.date).getTime() + (4 * 60 * 60 * 1000)).toISOString().slice(0, 10) === todayStr;
      
      if (!isNaN(pnlValue)) {
        pnls30d.push(pnlValue);
        if (isToday) pnlsToday.push(pnlValue);
      }

      if (isToday && t.note?.includes('closed')) todayExecuted++;
    });

    // Process open trades
    livePositions.forEach(p => {
      const createdStr = p.position?.createdDate || p.position?.date;
      const isToday = createdStr && new Date(new Date(createdStr).getTime() + (4 * 60 * 60 * 1000)).toISOString().slice(0, 10) === todayStr;
      
      if (isToday) {
        todayExecuted++;
        const direction = p.position?.direction;
        if (direction === 'BUY') todayBuys++;
        else if (direction === 'SELL') todaySells++;
      }
    });

    const totalPnl   = pnls30d.reduce((sum, p) => sum + p, 0);
    const wins       = pnls30d.filter(p => p > 0.001).length;
    const winRate    = pnls30d.length > 0 ? parseFloat(((wins / pnls30d.length) * 100).toFixed(2)) : 0;
    const bestTrade  = pnls30d.length > 0 ? Math.max(...pnls30d) : 0;
    const worstTrade = pnls30d.length > 0 ? Math.min(...pnls30d) : 0;

    const sessionWins       = pnlsToday.filter(p => p > 0.001).length;
    const sessionWinRate    = pnlsToday.length > 0 ? parseFloat(((sessionWins / pnlsToday.length) * 100).toFixed(2)) : 0;
    const sessionBest       = pnlsToday.length > 0 ? Math.max(...pnlsToday) : 0;
    const sessionWorst      = pnlsToday.length > 0 ? Math.min(...pnlsToday) : 0;

    const sessionCount = pnlsToday.length;
    const finalSessionWorst = sessionCount > 0 ? Math.min(...pnlsToday) : 0;
    
    const grossProfitVal = pnls30d.filter(p => p > 0).reduce((sum, p) => sum + p, 0);
    const grossLossVal   = Math.abs(pnls30d.filter(p => p < 0).reduce((sum, p) => sum + p, 0));

    console.log(`[EXEC] fetchBrokerTradeStats: TodayExecuted ${todayExecuted} | WR ${sessionWinRate}%`);

    const todayNetPnl = pnlsToday.reduce((sum, p) => sum + p, 0);

    return {
      totalTrades: goldTransactions.length,
      totalPnl: parseFloat(totalPnl.toFixed(2)),
      grossProfit: parseFloat(grossProfitVal.toFixed(2)),
      grossLoss:   parseFloat(grossLossVal.toFixed(2)),
      wins, winRate, bestTrade, worstTrade, pnls: pnls30d,
      todayTrades: todayExecuted,
      todayNetPnl: parseFloat(todayNetPnl.toFixed(2)),
      todayBuys, todaySells,
      todayWinRate: sessionWinRate,
      todayBest: sessionBest,
      todayWorst: finalSessionWorst,
      syncedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[EXEC] fetchBrokerTradeStats error:', err.message);
    return null;
  }
}


// ── calculatePositionSize ─────────────────────────────────────────────────────
// Leverage-aware and Currency-aware position sizing for Capital.com GOLD CFD.
export function calculatePositionSize(balanceAED, stopDistanceUSD, currentPriceUSD, availableMarginAED) {
  if (isNaN(balanceAED) || balanceAED <= 0)          return { size: 0, error: 'Invalid balance' };
  if (isNaN(stopDistanceUSD) || stopDistanceUSD <= 0) return { size: 0, error: 'Invalid stop distance' };
  if (isNaN(currentPriceUSD) || currentPriceUSD <= 0) return { size: 0, error: 'Invalid current price' };

  const balanceUSD = balanceAED / USD_AED_PEG;

  if (stopDistanceUSD < MIN_STOP_DISTANCE) {
    return {
      size:  0,
      error: `Stop distance $${stopDistanceUSD.toFixed(3)} is below minimum $${MIN_STOP_DISTANCE} — would create oversized position`,
    };
  }

  const riskAmountUSD     = balanceUSD * 0.005;             // 0.5% of account
  const maxRiskUSD        = balanceUSD * 0.01;              // Hard limit 1% for safety
  const sizeFromRisk      = riskAmountUSD / stopDistanceUSD;

  let positionSize = Math.min(sizeFromRisk, MAX_SIZE);
  positionSize     = Math.max(positionSize, MIN_SIZE);
  positionSize     = parseFloat(positionSize.toFixed(2));

  const actualRiskUSD = parseFloat((positionSize * stopDistanceUSD).toFixed(2));
  const actualRiskAED = parseFloat((actualRiskUSD * USD_AED_PEG).toFixed(2));

  if (actualRiskUSD > maxRiskUSD) {
    return {
      size:  0,
      error: `Even minimum size (${MIN_SIZE}oz) risks $${actualRiskUSD.toFixed(2)} (AED ${actualRiskAED.toFixed(2)}), exceeding 1% balance cap ($${maxRiskUSD.toFixed(2)})`,
    };
  }

  const notionalValueUSD    = positionSize * currentPriceUSD;
  const marginRequiredUSD   = notionalValueUSD * GOLD_MARGIN_RATE;
  const marginRequiredAED   = marginRequiredUSD * USD_AED_PEG;
  const marginWithBufferAED = marginRequiredAED * MARGIN_BUFFER;

  if (availableMarginAED < marginWithBufferAED) {
    return {
      size:  0,
      error: `Insufficient margin: need AED ${marginWithBufferAED.toFixed(2)} (with ${MARGIN_BUFFER}× buffer), have AED ${availableMarginAED.toFixed(2)}`,
    };
  }

  return {
    size:              positionSize,
    actualRiskDollars: actualRiskUSD,
    actualRiskAED,
    notionalValue:     parseFloat(notionalValueUSD.toFixed(2)),
    marginRequired:    parseFloat(marginRequiredAED.toFixed(2)),
    leverage:          GOLD_LEVERAGE,
    marginRate:        GOLD_MARGIN_RATE,
    error:             null,
  };
}


// ── placeTrade ────────────────────────────────────────────────────────────────
export async function placeTrade(session, signal, botState) {
  try {
    const { baseUrl, cst, securityToken } = session;

    if (!signal || !signal.action || !signal.entryPrice || !signal.stopLoss || !signal.takeProfit) {
      return { success: false, reason: 'ERROR: Signal missing required fields' };
    }
    if (isNaN(signal.entryPrice) || isNaN(signal.stopLoss) || isNaN(signal.takeProfit)) {
      return { success: false, reason: 'ERROR: Signal contains NaN values' };
    }
    if (signal.action === 'BUY'  && signal.stopLoss >= signal.entryPrice) {
      return { success: false, reason: 'ERROR: BUY stop loss is not below entry price' };
    }
    if (signal.action === 'SELL' && signal.stopLoss <= signal.entryPrice) {
      return { success: false, reason: 'ERROR: SELL stop loss is not above entry price' };
    }

    // ── PRE-TRADE: Verify no duplicate trade for this signal ────────────────
    if (Array.isArray(botState.openTrades)) {
      const alreadyOpen = botState.openTrades.some(t => t.tradeId === signal.id);
      if (alreadyOpen) {
        return { success: false, reason: 'ERROR: Trade with this signal ID is already open' };
      }
    }

    // ── PRE-TRADE: Verify state integrity ──────────────────────────────────
    if (botState.stateIntegrityOk === false || botState.criticalFailure === true) {
      return { success: false, reason: 'ERROR: State integrity compromised — refusing to trade until manual review' };
    }

    if (botState.riskDataFresh !== true) {
      return { success: false, reason: 'ERROR: Risk data is stale — refusing to trade' };
    }

    if (botState.pendingOrder && botState.pendingOrder.status !== 'cleared') {
      return { success: false, reason: 'ERROR: Pending order state is unresolved' };
    }

    const idempotencyKey = buildIdempotencyKey(signal);
    botState.recentOrderKeys = Array.isArray(botState.recentOrderKeys) ? botState.recentOrderKeys : [];
    if (botState.recentOrderKeys.includes(idempotencyKey)) {
      return { success: false, reason: 'ERROR: Duplicate idempotency key detected' };
    }

    const accountData = await fetchAccountData(session);
    if (!accountData) {
      return { success: false, reason: 'ERROR: Could not fetch account data for pre-trade margin check' };
    }
    const { balance, equity, availableMargin } = accountData;

    // ── PRE-TRADE: Log both balance and equity ────────────────────────────
    console.log(`[EXEC] Pre-trade account: balance=AED ${balance.toFixed(2)}, equity=AED ${equity.toFixed(2)}, margin=AED ${availableMargin.toFixed(2)}`);

    // ── EQUITY SAFETY CHECK: Ensure equity is above minimum threshold ─────────
    // Equity includes unrealized P&L. If equity is too low, market downturn could trigger liquidation.
    const minEquitySafetyMarginAED = 150; // Minimum equity buffer to keep bot safe
    if (equity < minEquitySafetyMarginAED) {
      return { 
        success: false, 
        reason: `REJECTED: Equity (AED ${equity.toFixed(2)}) below safety threshold (AED ${minEquitySafetyMarginAED}). Account at liquidation risk.` 
      };
    }

    // ── Live slippage and spread check ───────────────────────────────────────
    const mktRes = await fetchWithTimeout(`${baseUrl}/api/v1/markets/GOLD`, {
      headers: {
        'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
        'CST': cst,
        'X-SECURITY-TOKEN': securityToken,
      },
    });

    if (!mktRes.ok) {
      return { success: false, reason: `REJECTED: Market snapshot unavailable (HTTP ${mktRes.status})` };
    }

    const mktData = await mktRes.json();
    const snapshot = mktData.snapshot || {};
    const liveBid = parseFloat(snapshot.bid);
    const liveAsk = parseFloat(snapshot.offer ?? snapshot.ask);

    if (isNaN(liveBid) || isNaN(liveAsk) || liveAsk <= liveBid) {
      return { success: false, reason: 'REJECTED: Invalid live bid/ask snapshot' };
    }

    const spread = liveAsk - liveBid;
    const maxSpread = parseFloat(process.env.MAX_SPREAD) || 0.40;
    if (spread > maxSpread) {
      return { success: false, reason: `REJECTED: Spread too wide ($${spread.toFixed(2)} > $${maxSpread.toFixed(2)})` };
    }

    const executionPrice = signal.action === 'BUY' ? liveAsk : liveBid;
    const slippage = Math.abs(executionPrice - signal.entryPrice);
    if (slippage > 1.00) {
      return { success: false, reason: `REJECTED: Slippage too high ($${slippage.toFixed(2)})` };
    }

    // ── Position sizing: Use ACTUAL EXECUTION PRICE, not signal price ─────────
    // This ensures sizing is accurate even if market moved between signal and execution
    const stopDistance  = Math.abs(executionPrice - signal.stopLoss);
    const currentPrice  = executionPrice;
    const sizing        = calculatePositionSize(balance, stopDistance, currentPrice, availableMargin);

    if (sizing.error || sizing.size <= 0) {
      return { success: false, reason: `REJECTED: Position sizing failed — ${sizing.error}` };
    }

    const positionSize      = sizing.size;
    const actualRiskDollars = sizing.actualRiskDollars;
    const notionalValue     = sizing.notionalValue;
    const marginRequired    = sizing.marginRequired;

    const worstCaseMoveUsd = calculateDynamicWorstCaseMoveUsd(currentPrice, signal?.atr);
    if (worstCaseMoveUsd === null) {
      botState.pendingOrder = null;
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = 'INVALID_WORST_CASE_RISK_INPUTS';
      await saveStateCritical(botState, 'invalid_worst_case_risk_inputs');
      return { success: false, reason: 'CRITICAL_FAILURE: Dynamic worst-case risk model inputs invalid' };
    }

    const portfolioWorstCase = calculatePortfolioWorstCaseRiskAED(botState.openTrades, positionSize, worstCaseMoveUsd);
    if (!portfolioWorstCase.ok) {
      botState.pendingOrder = null;
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = `INVALID_PORTFOLIO_RISK_MODEL:${portfolioWorstCase.reason}`;
      await saveStateCritical(botState, `invalid_portfolio_risk_model:${portfolioWorstCase.reason}`);
      return { success: false, reason: 'CRITICAL_FAILURE: Portfolio worst-case risk model invalid' };
    }

    const portfolioWorstCaseAED = portfolioWorstCase.riskAED;
    const maxAllowedWorstCaseAED = equity * MAX_PORTFOLIO_WORST_CASE_EQUITY_PCT;
    if (portfolioWorstCaseAED > maxAllowedWorstCaseAED) {
      return {
        success: false,
        reason: `REJECTED: Portfolio worst-case risk AED ${portfolioWorstCaseAED.toFixed(2)} exceeds limit AED ${maxAllowedWorstCaseAED.toFixed(2)}`,
      };
    }

    const orderBody = {
      epic:          'GOLD',
      direction:     signal.action === 'BUY' ? 'BUY' : 'SELL',
      size:          positionSize,
      guaranteedStop: false,
      stopLevel:     parseFloat(signal.stopLoss.toFixed(2)),
      profitLevel:   parseFloat(signal.takeProfit.toFixed(2)),
    };

    const requestId = randomUUID();
    botState.pendingOrder = {
      idempotencyKey,
      signalId: signal.id,
      requestId,
      status: 'submitting',
      expectedSize: positionSize,
      createdAt: Date.now(),
    };

    const pendingSaved = await saveStateCritical(botState, `pending_order:${idempotencyKey}`);
    if (!pendingSaved) {
      return { success: false, reason: 'CRITICAL_FAILURE: Pending order state save failed' };
    }

    const res = await fetchWithTimeout(`${baseUrl}/api/v1/positions`, {
      method: 'POST',
      headers: {
        'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
        'CST': cst,
        'X-SECURITY-TOKEN': securityToken,
        'Content-Type': 'application/json',
        'X-REQUEST-ID': requestId,
        'X-IDEMPOTENCY-KEY': idempotencyKey,
      },
      body: JSON.stringify(orderBody),
    });

    let result;
    try {
      result = await res.json();
    } catch (_) {
      botState.pendingOrder.status = 'unknown';
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = 'ORDER_RESPONSE_INVALID_JSON';
      await saveStateCritical(botState, 'order_response_invalid_json');
      return { success: false, reason: 'CRITICAL_FAILURE: Invalid order response payload' };
    }

    if (!res.ok || result.errorCode) {
      botState.pendingOrder.status = 'rejected';
      botState.pendingOrder.errorCode = result.errorCode || null;
      botState.pendingOrder.rejectedAt = Date.now();
      await saveStateCritical(botState, `order_rejected:${idempotencyKey}`);
      botState.pendingOrder = null;
      await saveStateCritical(botState, `order_rejected_clear:${idempotencyKey}`);
      return { success: false, reason: `REJECTED: ${result.errorCode || result.message || 'Order rejected'}` };
    }

    const dealReference = result.dealReference;
    if (!dealReference) {
      botState.pendingOrder.status = 'unknown';
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = 'ORDER_ACCEPTED_WITHOUT_REFERENCE';
      await saveStateCritical(botState, `order_unknown:${idempotencyKey}`);
      return { success: false, reason: 'CRITICAL_FAILURE: No dealReference in order response' };
    }

    let confirm;
    try {
      confirm = await fetchDealConfirmation(session, dealReference);
    } catch (err) {
      botState.pendingOrder.status = 'unknown';
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = `ORDER_CONFIRMATION_UNAVAILABLE:${dealReference}`;
      await saveStateCritical(botState, `confirm_unavailable:${dealReference}`);
      return { success: false, reason: `CRITICAL_FAILURE: ${err.message}` };
    }

    const dealStatus = String(confirm?.dealStatus || '').toUpperCase();
    if (dealStatus !== 'ACCEPTED') {
      botState.pendingOrder.status = 'unknown';
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = `ORDER_NOT_ACCEPTED:${dealStatus || 'UNKNOWN'}`;
      await saveStateCritical(botState, `order_not_accepted:${dealReference}`);
      return { success: false, reason: `CRITICAL_FAILURE: Order not accepted (${dealStatus || 'UNKNOWN'})` };
    }

    const fillValidation = extractStrictFilledSize(confirm);
    if (!fillValidation.ok) {
      botState.pendingOrder.status = 'critical_failure';
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = `CRITICAL_FILL_VALIDATION_FAILURE:${dealReference}:${fillValidation.reason}`;
      await saveStateCritical(botState, `critical_fill_validation_failure:${dealReference}:${fillValidation.reason}`);
      return { success: false, reason: 'CRITICAL_FAILURE: Missing or invalid fill breakdown' };
    }

    if (!sizesMatchExactly(fillValidation.filledSize, positionSize)) {
      botState.pendingOrder.status = 'partial_or_unknown_fill';
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = `PARTIAL_OR_UNKNOWN_FILL:${dealReference}`;
      await saveStateCritical(botState, `partial_or_unknown_fill:${dealReference}`);
      return { success: false, reason: 'CRITICAL_FAILURE: Partial or unknown fill detected' };
    }

    // ── CRITICAL: Record trade in local state IMMEDIATELY ─────────────────────
    botState.recentTradeIds = Array.isArray(botState.recentTradeIds) ? botState.recentTradeIds : [];
    botState.recentTradeIds.push(signal.id);
    botState.recentTradeIds = botState.recentTradeIds.slice(-20);

    botState.openTrades = Array.isArray(botState.openTrades) ? botState.openTrades : [];

    const tradeRecord = {
      tradeId:         signal.id,
      dealReference,
      pair:            'GOLD',
      action:          signal.action,
      entry:           executionPrice,
      size:            positionSize,
      stopLoss:        signal.stopLoss,
      takeProfit:      signal.takeProfit,
      notionalValue,
      marginRequired,
      actualRiskDollars,
      openedAt:        Date.now(),
      strategyVersion: signal.strategyVersion || 'v1.1',
      missingCount:    0,
    };

    botState.openTrades.push(tradeRecord);
    botState.dailyTrades        = (botState.dailyTrades ?? 0) + 1;
    botState.lastOrderTimestamp = Date.now();
    botState.pendingOrder = null;
    botState.recentOrderKeys.push(idempotencyKey);
    botState.recentOrderKeys = botState.recentOrderKeys.slice(-100);

    // ── CRITICAL SAVE: Persist state immediately after trade open ──────────────
    // This prevents "discovered" trades — if the process crashes after this point,
    // the trade is already saved and will be found on next startup.
    console.log(`[EXEC] ✅ TRADE OPENED: ${signal.action} ${positionSize}oz GOLD @ ${executionPrice.toFixed(2)} | SL=${signal.stopLoss.toFixed(2)} TP=${signal.takeProfit.toFixed(2)} | ref=${dealReference} | risk=$${actualRiskDollars.toFixed(2)}`);
    const saved = await saveStateCritical(botState, `trade_opened:${dealReference}`);
    if (!saved) {
      return { success: false, reason: 'CRITICAL_FAILURE: Trade executed but state save failed' };
    }

    return {
      success:          true,
      dealReference,
      size:             positionSize,
      entry:            executionPrice,
      actualRiskDollars,
      notionalValue,
      marginRequired,
      leverage:         GOLD_LEVERAGE,
      idempotencyKey,
    };

  } catch (err) {
    console.error('[EXEC] placeTrade error:', err.message);
    if (botState && botState.pendingOrder && botState.pendingOrder.status !== 'cleared') {
      botState.pendingOrder.status = 'unknown';
      botState.pendingOrder.error = err.message;
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = err?.code === 'FETCH_TIMEOUT'
        ? 'CRITICAL_TIMEOUT_DURING_ORDER'
        : 'CRITICAL_UNCERTAIN_ORDER_STATE';
      await saveStateCritical(botState, 'place_trade_exception');
      return { success: false, reason: `CRITICAL_FAILURE: ${botState.criticalFailureReason}` };
    }
    return { success: false, reason: `ERROR: ${err.message}` };
  }
}
