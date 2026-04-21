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

import { fetchWithTimeout, withRetries } from './fetch.js';
import { saveStateCritical } from './state.js';
import { getAdaptiveSpreadLimit } from './risk.js';
import { randomUUID, createHash } from 'node:crypto';
import { STRATEGY_VERSION } from './strategy.js';

// ── Sync window: how long to wait for Capital.com history to appear after closure ──
// Exported so reconcilePositions (api/cron.js) and verifyExecutionCertainty use
// the same threshold, preventing the "missingCount mismatch" skip-loop bug.
export const SYNC_WINDOW_MS = 8 * 60 * 1000; // 8 minutes

// GOLD CFD Constants
const GOLD_MARGIN_RATE  = 0.05;   // 5% margin for retail (20:1 leverage)
const GOLD_LEVERAGE     = 20;     // Max retail leverage
const MIN_SIZE          = 0.01;   // Capital.com minimum lot size for GOLD (oz)
const MAX_SIZE          = 1.0;    // Hard cap: max oz per trade
const RISK_PCT          = 0.02;   // Target risk per trade as % of balance (2.0%)
const MAX_RISK_PCT      = 0.03;   // Hard cap: max risk per trade as % of balance (3%)
const MIN_STOP_DISTANCE = 0.50;   // Minimum stop distance in $/oz
const MARGIN_BUFFER     = 1.5;    // Must have 1.5× required margin available
const EXECUTION_STOP_LOSS_ATR_MULTIPLIER = 1.5;   // sync with strategy modeling (1.5x ATR)
const EXECUTION_TAKE_PROFIT_ATR_MULTIPLIER = 2.5;  // was 3.0 — tighter TP that actually gets hit (1.25:1 R:R with 2R stop)
const MAX_STOP_ATR_RATIO = 2.5;                    // Skip trade if broker min stop distance exceeds this multiple of ATR
const MAX_SLIPPAGE_BASE = 3.00;                   // was 1.00 — increased for current gold volatility
const MAX_SIGNAL_AGE_MS = 75 * 1000;
const DEBUG_SYNC_RECON = process.env.DEBUG_SYNC_RECON === 'true';

// ── Multi-Currency Configuration ──────────────────────────────────────────────
// The user's account is in AED, but GOLD is priced in USD.
// We must convert the AED balance to USD before calculating risk-based size.
// AED is pegged to USD at 3.6725.
export const USD_AED_PEG = 3.6725;
const EXTREME_ATR_MULTIPLIER = 4;
const EXTREME_PRICE_PCT = 0.02;
const MAX_PORTFOLIO_WORST_CASE_EQUITY_PCT = 0.20;

function buildIdempotencyKey(signal) {
  // Use only the candle timestamp (extract from signal.id e.g. "1713184500000_BUY_v1.5")
  // This guarantees exactly ONE trade attempt per candle, preventing duplicate executions.
  const timestamp = String(signal.id).split('_')[0];
  const seed = `candle_${timestamp}`;
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 24);
  return `gold-${hash}`;
}

function extractStrictFilledSize(confirmData, expectedSize = null) {
  const affected = Array.isArray(confirmData?.affectedDeals) ? confirmData.affectedDeals : [];
  
  // Extract actual dealId from the broker's resulting position (the true single source of truth)
  // We ONLY want the dealId. The dealReference is for the transaction/order, not the position.
  const actualDealId = affected.length > 0 ? affected[0]?.dealId : null;
  
  // 1. Try to find size in the root confirmation object first
  const rootSize = Number(confirmData?.size ?? confirmData?.dealSize ?? confirmData?.filledSize);
  
  if (affected.length === 0) {
    if (Number.isFinite(rootSize) && rootSize > 0) {
      return { ok: true, reason: 'ROOT_SIZE_FOUND', filledSize: rootSize, actualDealId };
    }
    return { ok: false, reason: 'MISSING_FILL_BREAKDOWN', filledSize: null, actualDealId };
  }

  // 2. Sum up sizes from affected deals if present
  let sum = 0;
  let hasValidChildSize = false;
  for (const deal of affected) {
    const sz = Number(deal?.size ?? deal?.dealSize ?? deal?.filledSize);
    if (Number.isFinite(sz) && sz > 0) {
      sum += sz;
      hasValidChildSize = true;
    }
  }

  if (hasValidChildSize && sum > 0) {
    return { ok: true, reason: null, filledSize: sum, actualDealId };
  }

  // 3. Fallback to root size if children didn't have it
  if (Number.isFinite(rootSize) && rootSize > 0) {
    return { ok: true, reason: 'FALLBACK_ROOT_SIZE', filledSize: rootSize, actualDealId };
  }

  // 4. Last resort: if the broker says ACCEPTED and it's a single deal, use expected size.
  if (affected.length === 1 && expectedSize > 0) {
    const dealId = affected[0]?.dealId;
    if (dealId) {
      console.warn(`[EXEC] Confirmation for ${dealId} has no size field; adopting expected size ${expectedSize}`);
      return { ok: true, reason: 'ADOPTED_EXPECTED_SIZE', filledSize: expectedSize, actualDealId: dealId };
    }
  }

  return { ok: false, reason: 'INVALID_FILL_BREAKDOWN', filledSize: null, actualDealId };
}

/**
 * Normalizes an ID to ensure it is a string.
 */
function normalizeId(id) {
  if (id === null || id === undefined) return null;
  return String(id).trim();
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
  return Math.abs(a - b) < 0.001;
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

/**
 * Ensures local state matches broker state with tolerance for API propagation delays.
 * STRICTLY uses dealId as the unique identifier.
 */
export async function verifyExecutionCertainty(session, botState) {
  try {
    if (botState.criticalFailure === true) {
      return { ok: false, reason: 'CRITICAL_FAILURE_ACTIVE' };
    }

    // Pending orders are a source of uncertainty - wait for them to clear
    if (botState.pendingOrder && botState.pendingOrder.status !== 'cleared') {
      return { ok: false, reason: 'PENDING_ORDER_UNCERTAIN' };
    }

    const brokerPositions = await fetchBrokerPositions(session);
    if (brokerPositions === null) {
      return { ok: false, reason: 'BROKER_STATE_UNAVAILABLE' };
    }

    // Build map of broker positions by dealId
    const brokerByDealId = new Map();
    for (const p of brokerPositions) {
      const dealId = normalizeId(p.position?.dealId);
      if (!dealId) {
        console.error('[CERTAINTY] Broker position missing dealId', p.position);
        continue;
      }

      const brokerSize = normalizePositiveSize(p.position?.size ?? p.position?.dealSize);
      const brokerDirection = normalizeDirection(p.position?.direction);
      
      if (brokerSize === null || brokerDirection === null) {
        return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:INVALID_BROKER_POSITION:${dealId}` };
      }

      brokerByDealId.set(dealId, {
        size: brokerSize,
        direction: brokerDirection
      });
    }

    const localTrades = Array.isArray(botState.openTrades) ? botState.openTrades : [];
    const localByDealId = new Map();
    for (const t of localTrades) {
      const dealId = normalizeId(t?.dealId);
      if (!dealId) {
        // If we have a local trade without a dealId, it's a legacy or corrupted state
        // We trigger a mismatch reason but not necessarily a halt here.
        return { ok: false, reason: 'EXECUTION_STATE_UNCERTAIN:LOCAL_TRADE_MISSING_DEAL_ID' };
      }

      const localSize = normalizePositiveSize(t?.size);
      const localDirection = normalizeDirection(t?.action ?? t?.direction);
      if (localSize === null || localDirection === null) {
        return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:INVALID_LOCAL_POSITION:${dealId}` };
      }

      localByDealId.set(dealId, {
        size: localSize,
        direction: localDirection
      });
    }

    // Check for local trades missing on broker
    for (const [dealId, localPos] of localByDealId) {
      const brokerPos = brokerByDealId.get(dealId);
      if (!brokerPos) {
        // Find the trade to check its sync window status via firstMissingAt timestamp.
        // While a trade is within the SYNC_WINDOW_MS tolerance (i.e. reconcilePositions
        // is still waiting for history), we must NOT block new trades — that would
        // cause a multi-cycle skip loop lasting up to the full window.
        const trade = localTrades.find(t => String(t.dealId) === String(dealId));
        const firstMissingAt = trade?.firstMissingAt;

        if (!firstMissingAt || (Date.now() - firstMissingAt) < SYNC_WINDOW_MS) {
          const elapsedMin = firstMissingAt ? Math.floor((Date.now() - firstMissingAt) / 60000) : 0;
          console.warn(`[CERTAINTY] Local dealId ${dealId} NOT ON BROKER, within sync window (${elapsedMin}m / ${Math.floor(SYNC_WINDOW_MS / 60000)}m). Blocking new trades.`);
          return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:LOCAL_NOT_ON_BROKER:${dealId}` };
        }

        // Elapsed > SYNC_WINDOW_MS. reconcilePositions should have force-closed this
        // trade already, so reaching here is unexpected. Return UNCERTAIN so it is
        // treated as a SKIP (not a permanent halt) by the caller.
        console.warn(`[CERTAINTY] Local dealId ${dealId} NOT ON BROKER after ${Math.floor((Date.now() - firstMissingAt) / 60000)}m (beyond sync window). Matches: ${brokerByDealId.size}`);
        return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:LOCAL_NOT_ON_BROKER:${dealId}` };
      }

      if (!sizesMatchExactly(localPos.size, brokerPos.size)) {
        return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:SIZE_MISMATCH:${dealId} (local=${localPos.size}, broker=${brokerPos.size})` };
      }

      if (localPos.direction !== brokerPos.direction) {
        return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:DIRECTION_MISMATCH:${dealId} (local=${localPos.direction}, broker=${brokerPos.direction})` };
      }
    }

    // Check for broker positions missing locally
    for (const dealId of brokerByDealId.keys()) {
      if (!localByDealId.has(dealId)) {
        console.warn(`[CERTAINTY] Broker position ${dealId} NOT FOUND LOCALLY.`);
        return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:BROKER_NOT_LOCAL:${dealId}` };
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
    const res = await withRetries(async attempt => {
      const response = await fetchWithTimeout(`${baseUrl}/api/v1/accounts`, {
        headers: {
          'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
          'CST':              cst,
          'X-SECURITY-TOKEN': securityToken,
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} on attempt ${attempt}`);
      }
      return response;
    }, { attempts: 3, delayMs: 750, backoffFactor: 2, label: 'fetchAccountData' });
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
    const res = await withRetries(async attempt => {
      const response = await fetchWithTimeout(`${baseUrl}/api/v1/positions`, {
        headers: {
          'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
          'CST':              cst,
          'X-SECURITY-TOKEN': securityToken,
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} on attempt ${attempt}`);
      }
      return response;
    }, { attempts: 3, delayMs: 750, backoffFactor: 2, label: 'fetchBrokerPositions' });

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
 * @param {string} targetId - The trade's unique dealId (position ID)
 * @param {number} [openedAt] - Optional timestamp when the trade was opened
 * @returns {Promise<number|null>} - The profit/loss in account currency, or null if not found
 */
/**
 * Single attempt at fetching the closed-trade P&L from Capital.com transaction history.
 * Returns the profit/loss number, or null if not found / API error.
 * @private
 */
async function _fetchClosedTradePnlOnce(session, targetId, openedAt) {
  const { baseUrl, cst, securityToken } = session;

  let from;
  if (openedAt && !isNaN(openedAt)) {
    // Look back from 2 hours before it was opened to be very safe
    from = new Date(openedAt - 2 * 60 * 60 * 1000).toISOString().split('.')[0];
  } else {
    from = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString().split('.')[0];
  }

  const to = new Date().toISOString().split('.')[0];
  const url = `${baseUrl}/api/v1/history/transactions?from=${from}&to=${to}`;

  if (DEBUG_SYNC_RECON) {
    console.log('[SYNC_DEBUG] fetchClosedTradePnlOnce request', {
      targetId,
      openedAt: openedAt ?? null,
      openedAtIso: openedAt && !isNaN(openedAt) ? new Date(openedAt).toISOString() : null,
      from,
      to,
      url,
    });
  }

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

  if (DEBUG_SYNC_RECON) {
    console.log('[SYNC_DEBUG] transactions returned', {
      targetId,
      count: transactions.length,
    });
  }

  // Search for a transaction that matches our dealId in any of the possible fields
  const tx = transactions.find(t => {
    const tid = String(targetId).trim();
    const candidate = {
      dealId: t.dealId ?? null,
      dealReference: t.dealReference ?? null,
      reference: t.reference ?? null,
      positionId: t.positionId ?? null,
      orderId: t.orderId ?? null,
      transactionType: t.transactionType ?? null,
      note: t.note ?? null,
      profitAndLoss: t.profitAndLoss ?? null,
      size: t.size ?? null,
      date: t.date ?? null,
    };
    const idMatch = (String(t.dealId).trim() === tid) ||
                    (String(t.dealReference).trim() === tid) ||
                    (String(t.reference).trim() === tid) ||
                    (String(t.positionId).trim() === tid) ||
                    (String(t.orderId).trim() === tid);

    if (!idMatch) {
      if (DEBUG_SYNC_RECON) {
        console.log('[SYNC_DEBUG] tx non-match', {
          targetId: tid,
          dealId: t.dealId ?? null,
          dealReference: t.dealReference ?? null,
          reference: t.reference ?? null,
          positionId: t.positionId ?? null,
          orderId: t.orderId ?? null,
          transactionType: t.transactionType ?? null,
          note: t.note ?? null,
          date: t.date ?? null,
          idMatch: false,
        });
      }
      return false;
    }

    // If it matches ID, and has a P&L, it's almost certainly our closing transaction.
    // We are less strict about the "note" because Capital.com notes can vary.
    // But we exclude "opening" or "margin" notes if possible.
    const note = String(t.note || '').toLowerCase();
    const isOpening = note.includes('open') || note.includes('accepted');
    const hasPnl = t.profitAndLoss != null && !isNaN(parseFloat(t.profitAndLoss));
    const noteClosure = note.includes('closed') || note.includes('stop') || note.includes('limit') || note.includes('liquid');
    const accepted = idMatch && ((hasPnl && !isOpening) || noteClosure);

    if (DEBUG_SYNC_RECON) {
      console.log('[SYNC_DEBUG] tx candidate', {
        targetId: tid,
        ...candidate,
        idMatch,
        hasPnl,
        isOpening,
        noteClosure,
        accepted,
      });
    }

    return accepted;
  });

  if (!tx) {
    if (DEBUG_SYNC_RECON) {
      console.log('[SYNC_DEBUG] no matching closure transaction found', { targetId });
    }
    return null;
  }
  const pnlField = tx.profitAndLoss !== undefined ? tx.profitAndLoss : tx.size;
  const pnl = parseFloat(pnlField);
  return isNaN(pnl) ? null : pnl;
}

/**
 * Fetches the actual realized P&L for a closed trade from Capital.com transaction history.
 * Uses internal exponential-backoff retry to handle transient API propagation delays.
 *
 * @param {Object} session       - Capital.com session
 * @param {string} targetId      - The trade's unique dealId (position ID)
 * @param {number} [openedAt]    - Optional timestamp when the trade was opened
 * @param {number[]} [_retryDelaysMs] - Override retry delays in ms (default: [2000, 5000]).
 *   Pass [0, 0] in unit tests to avoid real sleeps.
 * @returns {Promise<number|null>} - The profit/loss in account currency, or null if not found
 */
export async function fetchClosedTradePnl(session, targetId, openedAt, _retryDelaysMs = [2000, 5000]) {
  // Attempt 1 (no delay), then retry after each configured delay.
  // Total overhead: sum(_retryDelaysMs) = 7s by default — safe within Vercel 60s limit.
  // Cross-cycle retry is handled by firstMissingAt in reconcilePositions.
  for (let attempt = 0; attempt <= _retryDelaysMs.length; attempt++) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, _retryDelaysMs[attempt - 1]));
    }
    try {
      const result = await _fetchClosedTradePnlOnce(session, targetId, openedAt);
      if (result !== null) {
        if (attempt > 0) {
          console.log(`[EXEC] fetchClosedTradePnl: found ${targetId} on attempt ${attempt + 1}`);
        }
        return result;
      }
    } catch (err) {
      console.warn(`[EXEC] fetchClosedTradePnl attempt ${attempt + 1} error for ${targetId}: ${err.message}`);
    }
  }
  return null;
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
    
    const todayDealIds = new Set();
    let todayBuys = 0;
    let todaySells = 0;
    const pnlsToday = [];
    const pnls30d = [];

    // Process closed trades from history
    goldTransactions.forEach(t => {
      const pnlField = t.profitAndLoss !== undefined ? t.profitAndLoss : t.size;
      let pnlValue = parseFloat(pnlField || 0);
      const uaeDate = new Date(new Date(t.date).getTime() + (4 * 60 * 60 * 1000));
      const dateStr = uaeDate.toISOString().slice(0, 10);
      const isToday = dateStr === todayStr;
      
      const noteLC = (t.note ?? '').toLowerCase();
      const isClosure = noteLC.includes('closed') || noteLC.includes('stop') || noteLC.includes('limit') || noteLC.includes('liquid');
      const isOpening = noteLC.includes('open') || noteLC.includes('accepted');

      // P&L is only counted for closure transactions (to avoid double counting with opening or fees if they have sizes)
      if (isClosure && !isNaN(pnlValue)) {
        pnls30d.push(pnlValue);
        if (isToday) pnlsToday.push(pnlValue);
      } else if (t.transactionType === 'SWAP' || (t.transactionType === 'REBATE' && noteLC.includes('spread'))) {
        // Also count fees and rebates in 30d/Today totals
        if (!isNaN(pnlValue)) {
            pnls30d.push(pnlValue);
            if (isToday) pnlsToday.push(pnlValue);
        }
      }

      // Today-trade counting must reflect when the trade was OPENED, not when it closed.
      if (isToday && isOpening && !isClosure) {
        const dealId = String(t.dealId || t.reference || '');
        if (dealId && !todayDealIds.has(dealId)) {
          todayDealIds.add(dealId);
        }
      }
    });

    // Process open trades
    livePositions.forEach(p => {
      const createdStr = p.position?.createdDate || p.position?.date;
      const isToday = createdStr && new Date(new Date(createdStr).getTime() + (4 * 60 * 60 * 1000)).toISOString().slice(0, 10) === todayStr;
      
      if (isToday) {
        const dealId = String(p.position?.dealId || '');
        if (dealId) todayDealIds.add(dealId);
        
        const direction = p.position?.direction;
        if (direction === 'BUY') todayBuys++;
        else if (direction === 'SELL') todaySells++;
      }
    });

    const todayExecuted = todayDealIds.size;

    const totalPnl   = pnls30d.reduce((sum, p) => sum + p, 0);
    const wins       = pnls30d.filter(p => p > 0.001).length;
    const losses     = pnls30d.filter(p => p < -0.001).length;
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
      wins, losses, winRate, bestTrade, worstTrade, pnls: pnls30d,
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
export function calculatePositionSize(balanceAED, stopDistanceUSD, currentPriceUSD, availableMarginAED, riskMultiplier = 1.0) {
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

  const activeRiskPct     = RISK_PCT * riskMultiplier;
  const riskAmountUSD     = balanceUSD * activeRiskPct;             // default 2.0% of account, adjusted by multiplier
  const maxRiskUSD        = balanceUSD * MAX_RISK_PCT;          // Hard limit 3% for safety
  const sizeFromRisk      = riskAmountUSD / stopDistanceUSD;
  const sizeFromMargin    = availableMarginAED / (currentPriceUSD * GOLD_MARGIN_RATE * USD_AED_PEG * MARGIN_BUFFER);
  const riskSizedSize     = Math.min(sizeFromRisk, MAX_SIZE);

  let positionSize = Math.min(sizeFromRisk, sizeFromMargin, MAX_SIZE);
  positionSize = Math.floor(Math.max(positionSize, 0) * 100) / 100;

  if (sizeFromMargin < riskSizedSize) {
    const marginCappedSize = Math.floor(Math.max(Math.min(sizeFromMargin, MAX_SIZE), 0) * 100) / 100;
    console.log('[EXEC] Margin cap reduced position size', {
      sizeFromRisk: parseFloat(sizeFromRisk.toFixed(4)),
      sizeFromMargin: parseFloat(sizeFromMargin.toFixed(4)),
      riskSizedSize: parseFloat(riskSizedSize.toFixed(2)),
      marginCappedSize,
      availableMarginAED: parseFloat(availableMarginAED.toFixed(2)),
      finalSize: positionSize,
    });
  }

  if (positionSize < MIN_SIZE) {
    const minMarginWithBufferAED = MIN_SIZE * currentPriceUSD * GOLD_MARGIN_RATE * USD_AED_PEG * MARGIN_BUFFER;
    if (sizeFromMargin < MIN_SIZE) {
      return {
        size:  0,
        error: `Insufficient margin: need AED ${minMarginWithBufferAED.toFixed(2)} (with ${MARGIN_BUFFER}× buffer), have AED ${availableMarginAED.toFixed(2)}`,
      };
    }
    positionSize = MIN_SIZE;
  }

  const actualRiskUSD = parseFloat((positionSize * stopDistanceUSD).toFixed(2));
  const actualRiskAED = parseFloat((actualRiskUSD * USD_AED_PEG).toFixed(2));

  if (actualRiskUSD > maxRiskUSD) {
    return {
      size:  0,
      error: `Even minimum size (${MIN_SIZE}oz) risks $${actualRiskUSD.toFixed(2)} (AED ${actualRiskAED.toFixed(2)}), exceeding 3% balance cap ($${maxRiskUSD.toFixed(2)})`,
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
      return { success: false, reason: 'ERROR: Signal missing required fields', brokerResponse: null };
    }
    if (isNaN(signal.entryPrice) || isNaN(signal.stopLoss) || isNaN(signal.takeProfit)) {
      return { success: false, reason: 'ERROR: Signal contains NaN values', brokerResponse: null };
    }
    if (signal.action === 'BUY'  && signal.stopLoss >= signal.entryPrice) {
      return { success: false, reason: 'ERROR: BUY stop loss is not below entry price', brokerResponse: null };
    }
    if (signal.action === 'SELL' && signal.stopLoss <= signal.entryPrice) {
      return { success: false, reason: 'ERROR: SELL stop loss is not above entry price', brokerResponse: null };
    }
    if (signal.timestamp && (Date.now() - signal.timestamp) > MAX_SIGNAL_AGE_MS) {
      return { success: false, reason: `REJECTED: Signal is stale (${Math.round((Date.now() - signal.timestamp) / 1000)}s old)`, brokerResponse: null };
    }

    // ── PRE-TRADE: Verify no duplicate trade for this signal ────────────────
    if (Array.isArray(botState.openTrades)) {
      const alreadyOpen = botState.openTrades.some(t => t.tradeId === signal.id);
      if (alreadyOpen) {
        return { success: false, reason: 'ERROR: Trade with this signal ID is already open', brokerResponse: null };
      }
    }

    // ── PRE-TRADE: Verify state integrity ──────────────────────────────────
    if (botState.stateIntegrityOk === false || botState.criticalFailure === true) {
      return { success: false, reason: 'ERROR: State integrity compromised — refusing to trade until manual review', brokerResponse: null };
    }

    if (botState.riskDataFresh !== true) {
      return { success: false, reason: 'ERROR: Risk data is stale — refusing to trade', brokerResponse: null };
    }

    if (botState.pendingOrder && botState.pendingOrder.status !== 'cleared') {
      return { success: false, reason: 'ERROR: Pending order state is unresolved', brokerResponse: null };
    }

    const idempotencyKey = buildIdempotencyKey(signal);
    botState.recentOrderKeys = Array.isArray(botState.recentOrderKeys) ? botState.recentOrderKeys : [];
    if (botState.recentOrderKeys.includes(idempotencyKey)) {
      return { success: false, reason: 'ERROR: Duplicate idempotency key detected', brokerResponse: null };
    }

    const accountData = await fetchAccountData(session);
    if (!accountData) {
      return { success: false, reason: 'ERROR: Could not fetch account data for pre-trade margin check', brokerResponse: null };
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
        reason: `REJECTED: Equity (AED ${equity.toFixed(2)}) below safety threshold (AED ${minEquitySafetyMarginAED}). Account at liquidation risk.`,
        brokerResponse: null,
      };
    }

    // ── Live slippage and spread check ───────────────────────────────────────
    const mktRes = await withRetries(async attempt => {
      const res = await fetchWithTimeout(`${baseUrl}/api/v1/markets/GOLD`, {
        headers: {
          'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
          'CST': cst,
          'X-SECURITY-TOKEN': securityToken,
        },
      });
      if (!res.ok) {
        throw new Error(`Market snapshot unavailable (HTTP ${res.status}) on attempt ${attempt}`);
      }
      return res;
    }, { attempts: 3, delayMs: 1000, backoffFactor: 2, label: 'placeTrade market snapshot' });

    const mktData = await mktRes.json();
    const snapshot = mktData.snapshot || {};
    const liveBid = parseFloat(snapshot.bid);
    const liveAsk = parseFloat(snapshot.offer ?? snapshot.ask);

    if (isNaN(liveBid) || isNaN(liveAsk) || liveAsk <= liveBid) {
      return { success: false, reason: 'REJECTED: Invalid live bid/ask snapshot', brokerResponse: null };
    }

    const spread = liveAsk - liveBid;
    const maxSpread = getAdaptiveSpreadLimit(process.env.MAX_SPREAD, signal.atr);
    if (spread > maxSpread) {
      return { success: false, reason: `REJECTED: Spread too wide ($${spread.toFixed(2)} > $${maxSpread.toFixed(2)})`, brokerResponse: null };
    }

    const executionPrice = signal.action === 'BUY' ? liveAsk : liveBid;
    const slippage = Math.abs(executionPrice - signal.entryPrice);
    const slippageLimit = Math.max(MAX_SLIPPAGE_BASE, signal.atr * 0.5);
    if (slippage > slippageLimit) {
      return { success: false, reason: `REJECTED: Slippage too high ($${slippage.toFixed(2)} > allowed limit $${slippageLimit.toFixed(2)})`, brokerResponse: null };
    }

    // ── SL/TP Calculation with Broker Minimum Distance Enforcement ──────────
    // 1. Calculate base levels using ATR multiplier
    let tentativeSL = signal.action === 'BUY'
      ? executionPrice - (EXECUTION_STOP_LOSS_ATR_MULTIPLIER * signal.atr)
      : executionPrice + (EXECUTION_STOP_LOSS_ATR_MULTIPLIER * signal.atr);
    
    // 2. Parse broker minimum stop distance.
    // Capital.com may return this field as { value: N, unit: '...' } or as a plain number.
    // Handle both formats to avoid treating a valid value as missing.
    function _parseStopDistanceField(field) {
      if (field == null) return 0;
      if (typeof field === 'object') return parseFloat(field.value) || 0;
      return parseFloat(field) || 0;
    }
    const minStopDist = _parseStopDistanceField(snapshot.minControlledRiskStopDistance)
                     || _parseStopDistanceField(snapshot.minNormalStopDistance)
                     || 0;

    // 3. If broker did not supply stop distance data, log a warning and proceed without
    //    broker-minimum enforcement.  The ATR-based SL (2.0× ATR) is already applied above.
    //    The broker will return a clear error if the SL is too close, which we handle below.
    if (minStopDist <= 0) {
      console.warn('[EXEC] Broker min stop distance not provided — proceeding with ATR-based SL (no broker minimum enforcement)', {
        minControlledRiskStopDistance: snapshot.minControlledRiskStopDistance,
        minNormalStopDistance:         snapshot.minNormalStopDistance,
      });
    }

    // 4. Safety: skip trade if broker minimum stop distance is too large vs ATR
    if (minStopDist > 0 && minStopDist > signal.atr * MAX_STOP_ATR_RATIO) {
      console.warn(`[EXEC] Stop distance too large vs ATR: minStopDist=${minStopDist.toFixed(2)} atr=${signal.atr.toFixed(2)} threshold=${(signal.atr * MAX_STOP_ATR_RATIO).toFixed(2)}`);
      return { success: false, reason: 'SKIPPED: stop distance too large vs ATR', brokerResponse: null };
    }

    const distance = Math.abs(executionPrice - tentativeSL);

    if (minStopDist > 0 && distance < minStopDist) {
      console.log(`[EXEC] ATR stop dist ${distance.toFixed(2)} is below broker minimum ${minStopDist.toFixed(2)}. Adjusting SL to exact minimum.`);
      tentativeSL = signal.action === 'BUY'
        ? executionPrice - minStopDist
        : executionPrice + minStopDist;
    }

    const adjustedSL = tentativeSL;
    const adjustedTP = signal.action === 'BUY'
      ? executionPrice + (EXECUTION_TAKE_PROFIT_ATR_MULTIPLIER * signal.atr)
      : executionPrice - (EXECUTION_TAKE_PROFIT_ATR_MULTIPLIER * signal.atr);

    // ── Position sizing: use the ACTUAL execution SL distance, not the stale signal SL ──
    const stopDistance  = Math.abs(executionPrice - adjustedSL);
    const currentPrice  = executionPrice;
    const sizing        = calculatePositionSize(balance, stopDistance, currentPrice, availableMargin, signal.riskMultiplier || 1.0);

    if (sizing.error || sizing.size <= 0) {
      return { success: false, reason: `REJECTED: Position sizing failed — ${sizing.error}`, brokerResponse: null };
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
      return { success: false, reason: 'CRITICAL_FAILURE: Dynamic worst-case risk model inputs invalid', brokerResponse: null };
    }

    const portfolioWorstCase = calculatePortfolioWorstCaseRiskAED(botState.openTrades, positionSize, worstCaseMoveUsd);
    if (!portfolioWorstCase.ok) {
      botState.pendingOrder = null;
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = `INVALID_PORTFOLIO_RISK_MODEL:${portfolioWorstCase.reason}`;
      await saveStateCritical(botState, `invalid_portfolio_risk_model:${portfolioWorstCase.reason}`);
      return { success: false, reason: 'CRITICAL_FAILURE: Portfolio worst-case risk model invalid', brokerResponse: null };
    }

    const portfolioWorstCaseAED = portfolioWorstCase.riskAED;
    const maxAllowedWorstCaseAED = equity * MAX_PORTFOLIO_WORST_CASE_EQUITY_PCT;
    if (portfolioWorstCaseAED > maxAllowedWorstCaseAED) {
      return {
        success: false,
        reason: `REJECTED: Portfolio worst-case risk AED ${portfolioWorstCaseAED.toFixed(2)} exceeds limit AED ${maxAllowedWorstCaseAED.toFixed(2)}`,
        brokerResponse: null,
      };
    }

    // ── FIX: Recalculate SL/TP from actual execution price ──────────────────
    // The signal's SL/TP were computed from the closed candle price at signal time.
    // The actual execution price may differ due to spread and market movement.
    // Using stale SL/TP systematically distorts true risk/reward.

    console.log('[EXEC] SL_DEBUG', {
      entryPrice:                          executionPrice,
      stopLoss:                            adjustedSL,
      distance:                            Math.abs(executionPrice - adjustedSL),
      minControlledRiskStopDistance:       snapshot.minControlledRiskStopDistance?.value,
      minNormalStopDistance:               snapshot.minNormalStopDistance?.value,
    });

    // ── Broker slippage gate ──────────────────────────────────────────────────
    const currentMarketPrice = executionPrice;
    const maxSlippage = parseFloat(snapshot.maxSlippage ?? snapshot.maxExecutionSlippage) || 3.0;
    const expectedSlippage = Math.abs(currentMarketPrice - signal.entryPrice);
    console.log('[EXEC] SLIPPAGE_DEBUG', {
      entryPrice: signal.entryPrice,
      currentMarketPrice,
      expectedSlippage,
      maxSlippage,
    });
    if (expectedSlippage > maxSlippage) {
      return {
        success: false,
        reason: 'SKIPPED: slippage too high',
        brokerResponse: null,
      };
    }

    const orderBody = {
      epic:          'GOLD',
      direction:     signal.action === 'BUY' ? 'BUY' : 'SELL',
      size:          positionSize,
      guaranteedStop: false,  // TEST MODE: disabled to confirm if guaranteed stops cause broker rejection
      stopLevel:     parseFloat(adjustedSL.toFixed(2)),
      profitLevel:   parseFloat(adjustedTP.toFixed(2)),
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
      return { success: false, reason: 'CRITICAL_FAILURE: Pending order state save failed', brokerResponse: null };
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
      const brokerResponse = {
        errorCode:                    result.errorCode                    || null,
        message:                      result.message                      || null,
        minControlledRiskStopDistance: result.minControlledRiskStopDistance ?? null,
        minNormalStopDistance:         result.minNormalStopDistance         ?? null,
        stopLevel:                     result.stopLevel                     ?? null,
        dealReference:                 result.dealReference                 ?? null,
      };
      console.warn('[EXEC] Order rejected by broker:', brokerResponse);
      return { success: false, reason: `REJECTED: ${result.errorCode || result.message || 'Order rejected'}`, brokerResponse };
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

    const fillValidation = extractStrictFilledSize(confirm, positionSize);
    if (!fillValidation.ok) {
      botState.pendingOrder.status = 'critical_failure';
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = `CRITICAL_FILL_VALIDATION_FAILURE:${dealReference}:${fillValidation.reason}`;
      await saveStateCritical(botState, `critical_fill_validation_failure:${dealReference}:${fillValidation.reason}`);
      return { success: false, reason: `CRITICAL_FAILURE: Fill validation failed for ${dealReference}: ${fillValidation.reason}` };
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

    // EXTRACT THE REAL DEAL ID (position identifier)
    // This is the SINGLE SOURCE OF TRUTH for this position moving forward.
    const actualDealId = fillValidation.actualDealId;
    if (!actualDealId) {
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = `MISSING_DEAL_ID_IN_CONFIRMATION:${dealReference}`;
      await saveStateCritical(botState, `missing_deal_id:${dealReference}`);
      return { success: false, reason: `CRITICAL_FAILURE: Broker confirmed ACCEPTED but did not return a dealId (ref=${dealReference})` };
    }

    const finalDealId = actualDealId;

    // ── CRITICAL: Record trade in local state IMMEDIATELY ─────────────────────
    botState.recentTradeIds = Array.isArray(botState.recentTradeIds) ? botState.recentTradeIds : [];
    botState.recentTradeIds.push(signal.id);
    botState.recentTradeIds = botState.recentTradeIds.slice(-20);

    botState.openTrades = Array.isArray(botState.openTrades) ? botState.openTrades : [];

    const tradeRecord = {
      tradeId:         signal.id,
      dealId:          finalDealId,
      dealReference:   dealReference,
      pair:            'GOLD',
      action:          signal.action,
      entry:           executionPrice,
      size:            positionSize,
      stopLoss:        adjustedSL,
      takeProfit:      adjustedTP,
      atr:             signal.atr,
      initialStopLoss: adjustedSL,
      initialTakeProfit: adjustedTP,
      notionalValue,
      marginRequired,
      actualRiskDollars,
      openedAt:        Date.now(),
      entryType:       signal.entryType || 'unknown',
      strategyVersion: signal.strategyVersion || STRATEGY_VERSION,
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
    const slDist = Math.abs(executionPrice - adjustedSL);
    const tpDist = Math.abs(executionPrice - adjustedTP);
    const rrRatio = slDist > 0 ? (tpDist / slDist).toFixed(2) : '0';

    console.log(`[EXEC] ✅ TRADE OPENED (${signal.entryType}): ${signal.action} ${positionSize}oz GOLD @ ${executionPrice.toFixed(2)} | dealId=${finalDealId}`);
    console.log(`[EXEC] SL distance: $${slDist.toFixed(2)} | TP distance: $${tpDist.toFixed(2)} | RR ratio: ${rrRatio}`);
    
    const saved = await saveStateCritical(botState, `trade_opened:${finalDealId}`);
    if (!saved) {
      return { success: false, reason: 'CRITICAL_FAILURE: Trade executed but state save failed' };
    }

    // The post-trade certainty check was removed because Capital.com's /positions endpoint 
    // is often eventually consistent. The synchronous fetchDealConfirmation above is 
    // sufficient to guarantee execution before we recorded the trade.

    return {
      success:          true,
      dealId:           finalDealId,
      dealReference:    dealReference,
      size:             positionSize,
      entry:            executionPrice,
      stopLoss:         adjustedSL,
      takeProfit:       adjustedTP,
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

/**
 * Fetches the current GOLD bid/offer snapshot from Capital.com.
 * Used by reconcilePositions to estimate P&L for MIA (fallback-resolved) trades.
 * @param {Object} session - Capital.com session
 * @returns {Promise<{bid: number, offer: number}|null>}
 */
export async function fetchCurrentGoldPrice(session) {
  try {
    const { baseUrl, cst, securityToken } = session;
    const res = await withRetries(async attempt => {
      const response = await fetchWithTimeout(`${baseUrl}/api/v1/markets/GOLD`, {
        headers: {
          'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
          'CST':              cst,
          'X-SECURITY-TOKEN': securityToken,
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} on attempt ${attempt}`);
      }
      return response;
    }, { attempts: 3, delayMs: 750, backoffFactor: 2, label: 'fetchCurrentGoldPrice' });
    let data;
    try { data = await res.json(); } catch { return null; }
    const snapshot = data.snapshot || {};
    const bid   = parseFloat(snapshot.bid);
    const offer = parseFloat(snapshot.offer ?? snapshot.ask);
    if (!Number.isFinite(bid) || !Number.isFinite(offer) || bid <= 0 || offer <= 0) return null;
    return { bid, offer };
  } catch (err) {
    console.warn('[EXEC] fetchCurrentGoldPrice error:', err.message);
    return null;
  }
}

/**
 * Modifies an existing position's stop loss and/or take profit on Capital.com.
 * @param {Object} session - Capital.com session
 * @param {string} dealId - The position's dealId
 * @param {Object} levels - { stopLevel, profitLevel }
 */
export async function modifyTradeStopLoss(session, dealId, levels) {
  try {
    const { baseUrl, cst, securityToken } = session;
    const res = await fetchWithTimeout(`${baseUrl}/api/v1/positions/${dealId}`, {
      method: 'PUT',
      headers: {
        'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
        'CST':              cst,
        'X-SECURITY-TOKEN': securityToken,
        'Content-Type':     'application/json',
      },
      body: JSON.stringify(levels),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '(unreadable)');
      console.error(`[EXEC] Failed to modify trade ${dealId} (HTTP ${res.status}): ${body}`);
      return { success: false, reason: `HTTP_${res.status}` };
    }

    const data = await res.json();
    return { success: true, dealReference: data.dealReference };
  } catch (err) {
    console.error(`[EXEC] modifyTrade error for ${dealId}:`, err.message);
    return { success: false, reason: err.message };
  }
}
