export function checkRisk(signal, botState, indicators) {
  try {
    const now  = new Date();
    const hour = now.getUTCHours();
    const day  = now.getUTCDay();

    // 1. Kill switch
    if (process.env.BOT_ENABLED !== 'true')
      return 'SKIP: Bot disabled';

    // 2. Bot disabled via state
    if (botState.botEnabled === false)
      return 'SKIP: Bot disabled via state';

    // 3. Weekend
    if (day === 6 || day === 0)
      return 'SKIP: Weekend';

    // 4. Friday close at 10PM UAE = 18:00 UTC
    if (day === 5 && hour >= 18)
      return 'SKIP: Friday close - weekend approaching';

    // 5. Trading hours: 10AM-10PM UAE = 06:00-18:00 UTC
    if (hour < 6 || hour >= 18)
      return 'SKIP: Outside trading hours (UAE 10AM-10PM)';

    // 6. No signal
    if (!signal)
      return 'SKIP: No signal generated';

    // 7. ATR range - synced with indicators.js
    if (indicators.atr < 0.5 || indicators.atr > 12)
      return 'SKIP: ATR out of range';

    // 8. ATR spike - synced with indicators.js
    if (indicators.atr > indicators.atrAverage * 2.5)
      return 'SKIP: Abnormal volatility spike';

    // 9. Daily trade cap
    if (parseInt(botState.dailyTrades) >= 5)
      return 'SKIP: Daily trade limit reached (5/5)';

    // 10. Daily loss limit - 5% of balance
    if (parseFloat(botState.dailyLoss) >= parseFloat(botState.balance) * 0.05)
      return 'STOP: Daily loss limit reached';

    // 11. Total drawdown - 20% shutdown
    if (parseFloat(botState.totalDrawdown) >= 20)
      return 'DISABLE: Max drawdown reached - bot disabled';

    // 12. Cooldown - 10 minutes between trades
    const minutesSinceLastTrade = (Date.now() - botState.lastOrderTimestamp) / 60000;
    if (botState.lastOrderTimestamp && minutesSinceLastTrade < 10)
      return `SKIP: Cooldown active - ${Math.ceil(10 - minutesSinceLastTrade)} min remaining`;

    // 13. Max open positions
    if (botState.openTrades && botState.openTrades.length >= 2)
      return 'SKIP: Max 2 positions open';

    // 14. Duplicate trade ID
    if (botState.recentTradeIds && botState.recentTradeIds.includes(signal.id))
      return 'SKIP: Duplicate order';

    // 15. Slippage protection - widened to 1.0 since Capital.com prices can differ slightly
    if (Math.abs(indicators.lastCandle.close - signal.entryPrice) > 1.0)
      return 'SKIP: Price moved too fast';

    // 16. Sufficient balance
    if (parseFloat(botState.balance) < 10)
      return 'SKIP: Insufficient balance';

    // 17. Score check
    if (signal.score < 2)
      return 'SKIP: Score too low';

    return 'APPROVED';

  } catch (err) {
    return `SKIP: Risk check error - ${err.message}`;
  }
}
