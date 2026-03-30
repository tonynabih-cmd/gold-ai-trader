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
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY = 3000; // 3 seconds as requested

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { baseUrl, cst, securityToken } = session;
      
      // Look back 48 hours to find the closing transaction (widened from 24h)
      // If openedAt is available, we anchor to it (openedAt - 1h) to ensure we cover the entire trade life.
      let from;
      if (openedAt && !isNaN(openedAt)) {
        from = new Date(openedAt - 60 * 60 * 1000).toISOString().split('.')[0];
      } else {
        from = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().split('.')[0];
      }
      
      const to = new Date().toISOString().split('.')[0];
      const url = `${baseUrl}/api/v1/history/transactions?from=${from}&to=${to}`;

      console.log(`[EXEC] fetchClosedTradePnl (attempt ${attempt}): ref=${dealReference}`);
      
      const res = await fetchWithTimeout(url, {
        headers: {
          'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
          'CST':              cst,
          'X-SECURITY-TOKEN': securityToken,
        },
      });

      if (!res.ok) {
        console.warn(`[EXEC] fetchClosedTradePnl (attempt ${attempt}): HTTP ${res.status}`);
      } else {
        const data = await res.json();
        const transactions = data.transactions || [];
        
        console.log(`[EXEC] fetchClosedTradePnl: ${transactions.length} transactions in window`);
        
        // Find the transaction. Check both dealReference and dealId as they can vary by API version.
        const tx = transactions.find(t => 
          (t.dealReference === dealReference || t.dealId === dealReference || t.reference === dealReference) && 
          (t.profitAndLoss != null || (t.note?.includes('closed') && t.size != null))
        );
        
        if (tx) {
          const pnl = parseFloat(tx.profitAndLoss) || parseFloat(tx.size);
          console.log(`[EXEC] fetchClosedTradePnl: Found P&L for ${dealReference}: ${pnl}`);
          return pnl;
        }
      }

      if (attempt < MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
    } catch (err) {
      console.warn(`[EXEC] fetchClosedTradePnl (attempt ${attempt}) error: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
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
      error: `Even minimum size (${MIN_SIZE}oz) risks $${actualRiskUSD.toFixed(2)} (AED ${actualRiskAED.toFixed(2)}), exceeding ${(MAX_RISK_PCT * 100).toFixed(0)}% balance cap ($${maxRiskUSD.toFixed(2)})`,
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
    if (botState.stateIntegrityOk === false) {
      return { success: false, reason: 'ERROR: State integrity compromised — refusing to trade until manual review' };
    }

    const accountData = await fetchAccountData(session);
    if (!accountData) {
      return { success: false, reason: 'ERROR: Could not fetch account data for pre-trade margin check' };
    }
    const { balance, equity, availableMargin } = accountData;

    // ── PRE-TRADE: Log both balance and equity ────────────────────────────
    console.log(`[EXEC] Pre-trade account: balance=AED ${balance.toFixed(2)}, equity=AED ${equity.toFixed(2)}, margin=AED ${availableMargin.toFixed(2)}`);

    // ── Live slippage check ───────────────────────────────────────────────────
    try {
      const mktRes = await fetchWithTimeout(`${baseUrl}/api/v1/markets/GOLD`, {
        headers: {
          'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
          'CST':              cst,
          'X-SECURITY-TOKEN': securityToken,
        },
      });
      if (mktRes.ok) {
        const mktData = await mktRes.json();
        const snapshot = mktData.snapshot || {};
        const liveBid  = parseFloat(snapshot.bid);
        const liveAsk  = parseFloat(snapshot.offer ?? snapshot.ask);
        if (!isNaN(liveBid) && !isNaN(liveAsk)) {
          const livePrice = signal.action === 'BUY' ? liveAsk : liveBid;
          const slippage  = Math.abs(livePrice - signal.entryPrice);
          console.log(`[EXEC] Slippage check: signal=${signal.entryPrice.toFixed(2)}, live=${livePrice.toFixed(2)}, slippage=$${slippage.toFixed(2)}`);
          if (slippage > 1.00) {
            return { success: false, reason: `SKIP: Slippage too high ($${slippage.toFixed(2)}) — live price $${livePrice.toFixed(2)} vs signal $${signal.entryPrice.toFixed(2)}` };
          }
        } else {
          console.warn('[EXEC] Slippage check: could not parse live bid/ask — proceeding without slippage guard');
        }
      } else {
        console.warn(`[EXEC] Slippage check: markets endpoint returned ${mktRes.status} — proceeding without slippage guard`);
      }
    } catch (slippageErr) {
      console.warn(`[EXEC] Slippage check error: ${slippageErr.message} — proceeding without slippage guard`);
    }

    const stopDistance  = Math.abs(signal.entryPrice - signal.stopLoss);
    const currentPrice  = signal.entryPrice;
    const sizing        = calculatePositionSize(balance, stopDistance, currentPrice, availableMargin);

    if (sizing.error || sizing.size <= 0) {
      return { success: false, reason: `REJECTED: Position sizing failed — ${sizing.error}` };
    }

    const positionSize      = sizing.size;
    const actualRiskDollars = sizing.actualRiskDollars;
    const notionalValue     = sizing.notionalValue;
    const marginRequired    = sizing.marginRequired;

    const orderBody = {
      epic:          'GOLD',
      direction:     signal.action === 'BUY' ? 'BUY' : 'SELL',
      size:          positionSize,
      guaranteedStop: false,
      stopLevel:     parseFloat(signal.stopLoss.toFixed(2)),
      profitLevel:   parseFloat(signal.takeProfit.toFixed(2)),
    };

    let res;
    let result;
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[EXEC] placeTrade: Attempt ${attempt}/${MAX_RETRIES} for ${signal.action} ${positionSize}oz GOLD`);
        res = await fetchWithTimeout(`${baseUrl}/api/v1/positions`, {
          method: 'POST',
          headers: {
            'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
            'CST':              cst,
            'X-SECURITY-TOKEN': securityToken,
            'Content-Type':     'application/json',
          },
          body: JSON.stringify(orderBody),
        });

        try { result = await res.json(); } catch (e) {
          if (attempt < MAX_RETRIES) {
            console.warn(`[EXEC] placeTrade: invalid JSON response on attempt ${attempt}. Retrying...`);
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          return { success: false, reason: `REJECTED: Invalid JSON from Capital.com` };
        }

        if (!res.ok || result.errorCode) {
          const nonRetryableErrors = ['error.security.permissions-level-not-sufficient', 'error.balance.insufficient-funds'];
          if (nonRetryableErrors.includes(result.errorCode) || attempt === MAX_RETRIES) {
            return { success: false, reason: `REJECTED: ${result.errorCode || result.message}` };
          }
          console.warn(`[EXEC] placeTrade: error ${result.errorCode} on attempt ${attempt}. Retrying in 2s...`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        // If we reach here, it's successful
        break;
      } catch (err) {
        if (attempt === MAX_RETRIES) {
          throw err;
        }
        console.warn(`[EXEC] placeTrade: network error on attempt ${attempt}: ${err.message}. Retrying...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    const dealReference = result.dealReference;
    if (!dealReference) {
      return { success: false, reason: 'ERROR: No dealReference in order response' };
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
      entry:           signal.entryPrice,
      size:            positionSize,
      stopLoss:        signal.stopLoss,
      takeProfit:      signal.takeProfit,
      notionalValue,
      marginRequired,
      actualRiskDollars,
      openedAt:        Date.now(),
      strategyVersion: signal.strategyVersion || 'v1.1',
    };

    botState.openTrades.push(tradeRecord);
    botState.dailyTrades        = (botState.dailyTrades ?? 0) + 1;
    botState.lastOrderTimestamp = Date.now();

    // ── CRITICAL SAVE: Persist state immediately after trade open ──────────────
    // This prevents "discovered" trades — if the process crashes after this point,
    // the trade is already saved and will be found on next startup.
    console.log(`[EXEC] ✅ TRADE OPENED: ${signal.action} ${positionSize}oz GOLD @ ${signal.entryPrice.toFixed(2)} | SL=${signal.stopLoss.toFixed(2)} TP=${signal.takeProfit.toFixed(2)} | ref=${dealReference} | risk=$${actualRiskDollars.toFixed(2)}`);
    await saveStateCritical(botState, `trade_opened:${dealReference}`);

    return {
      success:          true,
      dealReference,
      size:             positionSize,
      entry:            signal.entryPrice,
      actualRiskDollars,
      notionalValue,
      marginRequired,
      leverage:         GOLD_LEVERAGE,
    };

  } catch (err) {
    console.error('[EXEC] placeTrade error:', err.message);
    return { success: false, reason: `ERROR: ${err.message}` };
  }
}
