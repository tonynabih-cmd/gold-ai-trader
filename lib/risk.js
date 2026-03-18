export function checkRisk(signal, botState, indicators) {
  try {
    const now = new Date();
    const hour = now.getUTCHours();
    const day = now.getUTCDay();

    // 1. Kill switch
    if (process.env.BOT_ENABLED !== 'true')
      return 'SKIP: Bot disabled';

    // 2. Weekend
    if (day === 6 || day === 0)
      return 'SKIP: Weekend';

    // 3. Friday close at 8PM UAE = 16:00 UTC
    if (day === 5 && hour >= 16)
      return 'SKIP: Friday close - weekend approaching';

    // 4. Golden Hour - 12PM-8PM UAE = 08:00-16:00 UTC
    if (hour < 8 || hour >= 16)
      return 'SKIP: Outside Golden Hour (UAE 12PM-8PM)';

    // 5. No signal
    if (!signal)
      return 'SKIP: No signal generated';

    // 6. ATR range
   if (indicators.atr < 0.5 || indicators.atr > 12)
  	return 'SKIP: ATR out of range';

    // 7. ATR spike
    if (indicators.atr > indicators.atrAverage * 2)
      return 'SKIP: Abnormal volatility spike';

    // 8. Daily trade cap
    if (parseInt(botState.dailyTrades) >= 5)
      return 'SKIP: Daily trade limit reached (5/5)';

    // 9. Daily loss limit - 5% of balance
    if (parseFloat(botState.dailyLoss) >= parseFloat(botState.balance) * 0.05)
      return 'STOP: Daily loss limit reached';

    // 10. Total drawdown - 20% shutdown
    if (parseFloat(botState.totalDrawdown) >= 20)
      return 'DISABLE: Max drawdown reached - bot disabled';

    // 11. Cooldown - 10 minutes between trades
    const minutesSinceLastTrade = (Date.now() - botState.lastOrderTimestamp) / 60000;
    if (botState.lastOrderTimestamp && minutesSinceLastTrade < 10)
      return `SKIP: Cooldown active - ${Math.ceil(10 - minutesSinceLastTrade)} min remaining`;

    // 12. Max open positions
    if (botState.openTrades && botState.openTrades.length >= 2)
      return 'SKIP: Max 2 positions open';

    // 13. Duplicate trade ID
    if (botState.recentTradeIds && botState.recentTradeIds.includes(signal.id))
      return 'SKIP: Duplicate order';

    // 14. Slippage protection
    if (Math.abs(indicators.lastCandle.close - signal.entryPrice) > 0.30)
      return 'SKIP: Price moved too fast';

    // 15. Sufficient balance
    if (parseFloat(botState.balance) < 10)
      return 'SKIP: Insufficient balance';

    // 16. Score check
    if (signal.score < 2)
      return 'SKIP: Score too low';

    // 17. Order timestamp guard
    if (botState.lastOrderTimestamp &&
      Date.now() - botState.lastOrderTimestamp < 60000)
      return 'SKIP: Too soon after last order';

    // 18. Retry protection - same candle
    if (botState.lastProcessedCandle &&
      signal.timestamp <= botState.lastProcessedCandle)
      return 'SKIP: Signal from already processed candle';

    return 'APPROVED';

  } catch (err) {
    return `SKIP: Risk check error - ${err.message}`;
  }
}
