// Session is created once in cron.js and passed in — no auth calls here

export async function syncBalance(session, botState) {
  try {
    const { baseUrl, cst, securityToken } = session;
    const res = await fetch(`${baseUrl}/api/v1/accounts`, {
      headers: {
        'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
        'CST': cst,
        'X-SECURITY-TOKEN': securityToken,
      },
    });
    if (!res.ok) return botState;
    const data = await res.json();
    const account = data.accounts?.[0];
    if (!account) return botState;
    const realBalance = parseFloat(account.balance.available);
    botState.balance = realBalance;
    if (realBalance > parseFloat(botState.peakBalance)) {
      botState.peakBalance = realBalance;
    }
    return botState;
  } catch (err) {
    console.error('Balance sync error:', err.message);
    return botState;
  }
}

export async function placeTrade(session, signal, botState) {
  try {
    const { baseUrl, cst, securityToken } = session;

    // Dynamic position sizing - 1% risk
    const balance = parseFloat(botState.balance);
    const riskAmount = balance * 0.01;
    const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);
    const positionSize = Math.max(0.01, parseFloat((riskAmount / stopDistance).toFixed(2)));

    const orderBody = {
      epic: 'XAUUSD',
      direction: signal.action === 'BUY' ? 'BUY' : 'SELL',
      size: positionSize,
      guaranteedStop: false,
      stopLevel: parseFloat(signal.stopLoss.toFixed(3)),
      profitLevel: parseFloat(signal.takeProfit.toFixed(3)),
    };

    const res = await fetch(`${baseUrl}/api/v1/positions`, {
      method: 'POST',
      headers: {
        'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
        'CST': cst,
        'X-SECURITY-TOKEN': securityToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(orderBody),
    });

    const result = await res.json();

    if (!res.ok || result.errorCode) {
      return {
        success: false,
        reason: `REJECTED: ${result.errorCode || result.message || 'Unknown error'}`,
      };
    }

    // Update state
    botState.recentTradeIds = botState.recentTradeIds || [];
    botState.recentTradeIds.push(signal.id);
    botState.recentTradeIds = botState.recentTradeIds.slice(-20);

    botState.openTrades = botState.openTrades || [];
    botState.openTrades.push({
      tradeId: signal.id,
      dealReference: result.dealReference,
      pair: 'XAUUSD',
      action: signal.action,
      entry: signal.entryPrice,
      size: positionSize,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      openedAt: Date.now(),
      strategyVersion: 'v1.1',
    });

    botState.dailyTrades = parseInt(botState.dailyTrades || 0) + 1;
    botState.lastOrderTimestamp = Date.now();

    return {
      success: true,
      dealReference: result.dealReference,
      size: positionSize,
      entry: signal.entryPrice,
    };

  } catch (err) {
    return {
      success: false,
      reason: `ERROR: ${err.message}`,
    };
  }
}
