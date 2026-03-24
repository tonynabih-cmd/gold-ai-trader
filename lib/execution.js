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
// Fetch real-time account balance AND available margin from Capital.com.
// Returns { balance, availableMargin } or null on failure.
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
    const availableMargin = parseFloat(account.balance?.available);  // Capital.com: "available" = free margin

    if (isNaN(balance) || balance < 0) return null;
    return {
      balance,
      availableMargin: isNaN(availableMargin) ? balance : availableMargin,
    };
  } catch (err) {
    console.error('fetchAccountData error:', err.message);
    return null;
  }
}


// ── syncBalance ───────────────────────────────────────────────────────────────
export async function syncBalance(session, botState) {
  try {
    const accountData = await fetchAccountData(session);
    if (!accountData) {
      console.error('Balance sync: failed to fetch account data');
      return botState;
    }

    const { balance: realBalance, availableMargin } = accountData;

    const prevBalance = parseFloat(botState.balance) || 0;
    botState.balance         = realBalance;
    botState.availableMargin = availableMargin;  // store for margin rule in risk.js

    // Update peak balance
    const prevPeak = parseFloat(botState.peakBalance) || 0;
    if (realBalance > prevPeak) botState.peakBalance = realBalance;

    // Total drawdown from peak
    const peak = parseFloat(botState.peakBalance);
    botState.totalDrawdown = (peak > 0 && realBalance < peak)
      ? parseFloat(((peak - realBalance) / peak * 100).toFixed(2))
      : 0;

    // Daily net loss from start-of-day balance
    const startOfDay = parseFloat(botState.startOfDayBalance) || prevBalance;
    botState.dailyLoss = (startOfDay > 0 && realBalance < startOfDay)
      ? parseFloat((startOfDay - realBalance).toFixed(2))
      : 0;

    console.log(
      `Balance synced: AED ${realBalance.toFixed(2)} | ` +
      `Available margin: AED ${availableMargin.toFixed(2)} | ` +
      `Peak: AED ${botState.peakBalance.toFixed(2)} | ` +
      `Drawdown: ${botState.totalDrawdown}%`
    );
    return botState;

  } catch (err) {
    console.error('Balance sync error:', err.message);
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
      
      console.log(`fetchClosedTradePnl (attempt ${attempt}): Fetching history from ${from} to ${to} for ref ${dealReference}`);
      
      const res = await fetchWithTimeout(url, {
        headers: {
          'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
          'CST':              cst,
          'X-SECURITY-TOKEN': securityToken,
        },
      });

      if (!res.ok) {
        console.warn(`fetchClosedTradePnl (attempt ${attempt}): HTTP ${res.status}`);
      } else {
        const data = await res.json();
        const transactions = data.transactions || [];
        
        // Debug logging for raw response (count and first 3 entries)
        console.log(`fetchClosedTradePnl: Found ${transactions.length} transactions in 48h window.`);
        if (transactions.length > 0) {
          console.log('fetchClosedTradePnl: First 3 entries (raw):', 
            JSON.stringify(transactions.slice(0, 3).map(t => ({
              dealId: t.dealId,
              dealReference: t.dealReference,
              pnl: t.profitAndLoss,
              type: t.type
            })), null, 2)
          );
        }

        // Find the transaction. Check both dealReference and dealId as they can vary by API version.
        const tx = transactions.find(t => 
          (t.dealReference === dealReference || t.dealId === dealReference) && 
          t.profitAndLoss != null
        );
        
        if (tx) {
          console.log(`fetchClosedTradePnl: Found P&L for ${dealReference} on attempt ${attempt}: ${tx.profitAndLoss}`);
          return parseFloat(tx.profitAndLoss);
        }
      }

      if (attempt < MAX_ATTEMPTS) {
        console.log(`fetchClosedTradePnl: P&L not found for ${dealReference} in ${transactions?.length || 0} entries. Retrying in ${RETRY_DELAY/1000}s... (Attempt ${attempt}/${MAX_ATTEMPTS})`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
    } catch (err) {
      console.warn(`fetchClosedTradePnl (attempt ${attempt}) error: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
    }
  }
  
  return null;
}


// ── calculatePositionSize ─────────────────────────────────────────────────────
// Leverage-aware and Currency-aware position sizing for Capital.com GOLD CFD.
//
// RISK MODEL:
//   1. Account is in AED. Gold price is in USD/oz.
//   2. We convert AED balance to USD equivalent using 3.6725 peg.
//   3. We determine target USD risk (1% of USD balance).
//   4. size = riskUSD / stopDistanceUSD
//
export function calculatePositionSize(balanceAED, stopDistanceUSD, currentPriceUSD, availableMarginAED) {
  // ── Validate inputs ──────────────────────────────────────────────────────
  if (isNaN(balanceAED) || balanceAED <= 0)          return { size: 0, error: 'Invalid balance' };
  if (isNaN(stopDistanceUSD) || stopDistanceUSD <= 0) return { size: 0, error: 'Invalid stop distance' };
  if (isNaN(currentPriceUSD) || currentPriceUSD <= 0) return { size: 0, error: 'Invalid current price' };

  // ── Currency Conversion ──────────────────────────────────────────────────
  const balanceUSD = balanceAED / USD_AED_PEG;

  // ── Minimum stop distance guard ──────────────────────────────────────────
  if (stopDistanceUSD < MIN_STOP_DISTANCE) {
    return {
      size:  0,
      error: `Stop distance $${stopDistanceUSD.toFixed(3)} is below minimum $${MIN_STOP_DISTANCE} — would create oversized position`,
    };
  }

  // ── Risk-based sizing (1% of balance, hard-capped at 2% of balance) ────────
  const maxRiskUSD        = balanceUSD * MAX_RISK_PCT;      // 2% of live balance
  const targetRiskUSD     = balanceUSD * 0.01;              // 1% of account
  const riskAmountUSD     = Math.min(targetRiskUSD, maxRiskUSD);
  const sizeFromRisk      = riskAmountUSD / stopDistanceUSD;

  // ── Apply size caps ──────────────────────────────────────────────────────
  let positionSize = Math.min(sizeFromRisk, MAX_SIZE);
  positionSize     = Math.max(positionSize, MIN_SIZE);
  positionSize     = parseFloat(positionSize.toFixed(2));

  // ── Actual risk at this size ─────────────────────────────────────────────
  const actualRiskUSD = parseFloat((positionSize * stopDistanceUSD).toFixed(2));
  const actualRiskAED = parseFloat((actualRiskUSD * USD_AED_PEG).toFixed(2));

  // ── Hard cap enforcement ─────────────────────────────────────────────────
  if (actualRiskUSD > maxRiskUSD) {
    return {
      size:  0,
      error: `Even minimum size (${MIN_SIZE}oz) risks $${actualRiskUSD.toFixed(2)} (AED ${actualRiskAED.toFixed(2)}), exceeding ${(MAX_RISK_PCT * 100).toFixed(0)}% balance cap ($${maxRiskUSD.toFixed(2)})`,
    };
  }

  // ── Margin calculation ───────────────────────────────────────────────────
  const notionalValueUSD    = positionSize * currentPriceUSD;
  const marginRequiredUSD   = notionalValueUSD * GOLD_MARGIN_RATE;
  const marginRequiredAED   = marginRequiredUSD * USD_AED_PEG;
  const marginWithBufferAED = marginRequiredAED * MARGIN_BUFFER;

  // ── Margin availability check ────────────────────────────────────────────
  if (availableMarginAED < marginWithBufferAED) {
    return {
      size:  0,
      error: `Insufficient margin: need AED ${marginWithBufferAED.toFixed(2)} (with ${MARGIN_BUFFER}× buffer), have AED ${availableMarginAED.toFixed(2)}`,
    };
  }

  return {
    size:              positionSize,
    actualRiskDollars: actualRiskUSD, // Used for logging as USD
    actualRiskAED,                   // High-fidelity local risk
    notionalValue:     parseFloat(notionalValueUSD.toFixed(2)),
    marginRequired:    parseFloat(marginRequiredAED.toFixed(2)), // Stored in AED for dashboard
    leverage:          GOLD_LEVERAGE,
    marginRate:        GOLD_MARGIN_RATE,
    error:             null,
  };
}


// ── placeTrade ────────────────────────────────────────────────────────────────
export async function placeTrade(session, signal, botState) {
  try {
    const { baseUrl, cst, securityToken } = session;

    // ── Validate signal fields ───────────────────────────────────────────────
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

    // ── Fetch live account data for sizing ───────────────────────────────────
    // We re-fetch here (not just rely on botState) to get the most up-to-date
    // available margin immediately before placing the order.
    const accountData = await fetchAccountData(session);
    if (!accountData) {
      return { success: false, reason: 'ERROR: Could not fetch account data for pre-trade margin check' };
    }
    const { balance, availableMargin } = accountData;

    // ── Calculate position size (leverage-aware, margin-checked) ────────────
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

    // ── Final hard risk cap check before touching the API ───────────────────
    // Belt-and-suspenders: abort if actualRiskDollars somehow exceeds 2% of balance.
    const maxRiskDollars = balance * MAX_RISK_PCT;
    if (actualRiskDollars > maxRiskDollars) {
      return {
        success: false,
        reason:  `SAFETY ABORT: actualRiskDollars $${actualRiskDollars} exceeds ${(MAX_RISK_PCT * 100).toFixed(0)}% balance cap ($${maxRiskDollars.toFixed(2)})`,
      };
    }

    // ── Build order ──────────────────────────────────────────────────────────
    // Capital.com requires stop/profit as price levels (not distances).
    // All prices rounded to 2 decimal places.
    const orderBody = {
      epic:          'GOLD',
      direction:     signal.action === 'BUY' ? 'BUY' : 'SELL',
      size:          positionSize,
      guaranteedStop: false,
      stopLevel:     parseFloat(signal.stopLoss.toFixed(2)),
      profitLevel:   parseFloat(signal.takeProfit.toFixed(2)),
    };

    console.log(
      `Placing ${signal.action} ${positionSize}oz GOLD | ` +
      `Entry≈$${currentPrice.toFixed(2)} | SL=$${orderBody.stopLevel} | TP=$${orderBody.profitLevel} | ` +
      `Risk=$${actualRiskDollars} | Notional=$${notionalValue} | Margin=$${marginRequired} | ` +
      `Available=$${availableMargin.toFixed(2)}`
    );

    // ── Send order to Capital.com ─────────────────────────────────────────────
    const res = await fetchWithTimeout(`${baseUrl}/api/v1/positions`, {
      method: 'POST',
      headers: {
        'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
        'CST':              cst,
        'X-SECURITY-TOKEN': securityToken,
        'Content-Type':     'application/json',
      },
      body: JSON.stringify(orderBody),
    });

    let result;
    try {
      result = await res.json();
    } catch (e) {
      const reason = `Invalid JSON from Capital.com (HTTP ${res.status})`;
      console.error(`Order rejected: ${reason}`);
      return { success: false, reason: `REJECTED: ${reason}` };
    }

    if (!res.ok || result.errorCode) {
      const reason = result.errorCode || result.message || `HTTP ${res.status}`;
      console.error(`Order rejected by Capital.com: ${reason}`);
      return { success: false, reason: `REJECTED: ${reason}` };
    }

    // ── Confirm deal ──────────────────────────────────────────────────────────
    const dealReference = result.dealReference;
    if (!dealReference) {
      console.error('Order may have filled but no dealReference returned:', JSON.stringify(result));
      return { success: false, reason: 'ERROR: No dealReference in order response — check Capital.com dashboard manually' };
    }

    // ── Update bot state ──────────────────────────────────────────────────────
    botState.recentTradeIds = Array.isArray(botState.recentTradeIds) ? botState.recentTradeIds : [];
    botState.recentTradeIds.push(signal.id);
    botState.recentTradeIds = botState.recentTradeIds.slice(-20);

    botState.openTrades = Array.isArray(botState.openTrades) ? botState.openTrades : [];
    botState.openTrades.push({
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
    });

    botState.dailyTrades        = parseInt(botState.dailyTrades ?? 0) + 1;
    botState.lastOrderTimestamp = Date.now();

    console.log(
      `Order confirmed: ${signal.action} ${positionSize}oz GOLD | ` +
      `dealRef: ${dealReference} | Risk: $${actualRiskDollars} | dailyTrades: ${botState.dailyTrades}`
    );

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
    console.error('placeTrade error:', err.message);
    return { success: false, reason: `ERROR: ${err.message}` };
  }
}
