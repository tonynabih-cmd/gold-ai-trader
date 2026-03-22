// execution.js — Place and track orders on Capital.com.
// Session is created once in cron.js and passed in — no extra auth calls here.
// Only runs after risk.js returns 'APPROVED'.

const FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function syncBalance(session, botState) {
  try {
    const { baseUrl, cst, securityToken } = session;

    const res = await fetchWithTimeout(`${baseUrl}/api/v1/accounts`, {
      headers: {
        'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
        'CST':              cst,
        'X-SECURITY-TOKEN': securityToken,
      },
    });

    if (!res.ok) {
      console.error(`Balance sync HTTP error: ${res.status}`);
      return botState;
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      console.error('Balance sync: failed to parse JSON response');
      return botState;
    }
    const account = data.accounts?.[0];
    if (!account) {
      console.error('Balance sync: no account found in response');
      return botState;
    }

    const realBalance = parseFloat(account.balance?.balance); // Fix: use total balance, not available margin
    if (isNaN(realBalance) || realBalance < 0) {
      console.error(`Balance sync: invalid balance value: ${account.balance?.available}`);
      return botState;
    }

    const prevBalance = parseFloat(botState.balance) || 0;
    botState.balance  = realBalance;

    // Update peak balance — never let it go below real balance
    const prevPeak = parseFloat(botState.peakBalance) || 0;
    if (realBalance > prevPeak) {
      botState.peakBalance = realBalance;
    }

    // Calculate total drawdown from peak
    const peak = parseFloat(botState.peakBalance);
    if (peak > 0 && realBalance < peak) {
      botState.totalDrawdown = parseFloat(((peak - realBalance) / peak * 100).toFixed(2));
    } else {
      botState.totalDrawdown = 0;
    }

    // Track daily loss — only accumulate losses, never subtract gains
    if (prevBalance > 0 && realBalance < prevBalance) {
      const loss = prevBalance - realBalance;
      const currentDailyLoss = parseFloat(botState.dailyLoss ?? 0);
      botState.dailyLoss = parseFloat(
        ((isNaN(currentDailyLoss) ? 0 : currentDailyLoss) + loss).toFixed(2)
      );
    }

    console.log(`Balance synced: $${realBalance.toFixed(2)} (peak: $${botState.peakBalance.toFixed(2)}, drawdown: ${botState.totalDrawdown}%)`);
    return botState;

  } catch (err) {
    console.error('Balance sync error:', err.message);
    return botState; // Non-fatal — keep going with last known balance
  }
}

export async function placeTrade(session, signal, botState) {
  try {
    const { baseUrl, cst, securityToken } = session;

    // ── Validate signal fields before touching the broker API ───────────────
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

    // ── Dynamic position sizing — 1% risk ───────────────────────────────────
    const balance      = parseFloat(botState.balance);
    if (isNaN(balance) || balance <= 0) {
      return { success: false, reason: 'ERROR: Invalid balance for position sizing' };
    }

    const riskAmount   = balance * 0.01; // 1% of account
    const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);

    // Guard against tiny or zero stop distance which would create an enormous position
    if (stopDistance < 0.30 || stopDistance === 0 || isNaN(stopDistance)) {
      return { success: false, reason: `ERROR: Stop distance invalid or too small (${stopDistance?.toFixed?.(3) || 'N/A'}) - would create oversized position` };
    }

    // Raw size from risk formula
    let positionSize = riskAmount / stopDistance;

    // Floor: Capital.com Gold minimum deal size is 1 oz for CFDs on most accounts.
    // Adjust this if your account has a different minimum (check Capital.com platform).
    const MIN_SIZE = 0.01;

    // Ceiling: cap at 1% of balance converted to oz (conservative safety cap)
    // Prevents runaway sizing on unusual inputs
    const MAX_SIZE = Math.max(MIN_SIZE, (balance / 500));

    positionSize = Math.max(MIN_SIZE, Math.min(positionSize, MAX_SIZE));
    positionSize = parseFloat(positionSize.toFixed(2));

    // Warn if we had to apply the minimum (means account is too small for 1% risk)
    if (positionSize === MIN_SIZE) {
      const actualRiskPercent = ((MIN_SIZE * stopDistance) / balance * 100).toFixed(2);
      console.warn(`Position floored to minimum size ${MIN_SIZE}oz — actual risk: ${actualRiskPercent}% of balance`);
    }

    // ── Build order ─────────────────────────────────────────────────────────
    // Capital.com requires stop/profit as price levels, not distances.
    // All prices rounded to 2 decimal places as required by Capital.com API.
    const orderBody = {
      epic:          'GOLD',
      direction:     signal.action === 'BUY' ? 'BUY' : 'SELL',
      size:          positionSize,
      guaranteedStop: false,
      stopLevel:     parseFloat(signal.stopLoss.toFixed(2)),
      profitLevel:   parseFloat(signal.takeProfit.toFixed(2)),
    };

    console.log(`Placing ${signal.action} order: size=${positionSize}oz, entry≈${signal.entryPrice.toFixed(2)}, SL=${orderBody.stopLevel}, TP=${orderBody.profitLevel}`);

    // ── Send order to Capital.com ───────────────────────────────────────────
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

    // ── Confirm the order filled and extract IDs ────────────────────────────
    // Capital.com returns dealReference in the order confirmation.
    // dealReference ≠ dealId — they are different identifiers.
    // dealReference: the reference you get back from the order (string like "DRF...")
    // dealId: the ID used in the positions list endpoint (different field)
    // We store dealReference here; syncOpenTrades in cron.js matches on dealReference
    // from GET /positions which also includes dealReference in the position object.
    const dealReference = result.dealReference;
    if (!dealReference) {
      console.error('Order may have filled but no dealReference returned:', JSON.stringify(result));
      return { success: false, reason: 'ERROR: No dealReference in order response - check Capital.com dashboard manually' };
    }

    // ── Update bot state ────────────────────────────────────────────────────
    botState.recentTradeIds = Array.isArray(botState.recentTradeIds) ? botState.recentTradeIds : [];
    botState.recentTradeIds.push(signal.id);
    botState.recentTradeIds = botState.recentTradeIds.slice(-20); // keep last 20

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
      openedAt:        Date.now(),
      strategyVersion: signal.strategyVersion || 'v1.1',
    });

    botState.dailyTrades       = parseInt(botState.dailyTrades ?? 0) + 1;
    botState.lastOrderTimestamp = Date.now();

    console.log(`Order confirmed: ${signal.action} ${positionSize}oz GOLD | dealRef: ${dealReference} | dailyTrades: ${botState.dailyTrades}`);

    return {
      success:       true,
      dealReference,
      size:          positionSize,
      entry:         signal.entryPrice,
    };

  } catch (err) {
    console.error('placeTrade error:', err.message);
    return { success: false, reason: `ERROR: ${err.message}` };
  }
}
