export function generateSignal(indicators, candles1m) {
  try {
    const {
      currEMA20, currEMA50,
      prevEMA20, prevEMA50,
      slopePercent, atr,
      atrAverage, rsi,
      resistance, support,
      trend1h, lastCandle
    } = indicators;

    // Step 1 - True crossover detection
    const crossover = prevEMA20 <= prevEMA50 && currEMA20 > currEMA50;   // BUY
    const crossunder = prevEMA20 >= prevEMA50 && currEMA20 < currEMA50;  // SELL

    if (!crossover && !crossunder) return null;

    const action = crossover ? 'BUY' : 'SELL';

    // Step 2 - Confirmation candle
    if (action === 'BUY' && lastCandle.close <= currEMA20) return null;
    if (action === 'SELL' && lastCandle.close >= currEMA20) return null;

    // Step 3 - Multi-timeframe confirmation
    if (action === 'BUY' && trend1h !== 'UP') return null;
    if (action === 'SELL' && trend1h !== 'DOWN') return null;

    // 1m confirmation
    const last1m = candles1m[candles1m.length - 1];
    if (action === 'BUY' && last1m.close < last1m.open) return null;
    if (action === 'SELL' && last1m.close > last1m.open) return null;

    // Step 4 - Trade scoring
    let score = 0;
    if (trend1h === (action === 'BUY' ? 'UP' : 'DOWN')) score += 2;
    if (atr > 2) score += 1;
    if (action === 'BUY' && lastCandle.close > lastCandle.open) score += 1;
    if (action === 'SELL' && lastCandle.close < lastCandle.open) score += 1;

    const nearResistance = action === 'BUY' &&
      (resistance - lastCandle.close) < atr * 0.5;
    const nearSupport = action === 'SELL' &&
      (lastCandle.close - support) < atr * 0.5;

    if (nearResistance || nearSupport) score -= 2;
    if (rsi > 70 || rsi < 30) score -= 1;

    if (score < 2) return null;

    // Build signal
    const stopLoss = action === 'BUY'
      ? lastCandle.close - (1.5 * atr)
      : lastCandle.close + (1.5 * atr);

    const takeProfit = action === 'BUY'
      ? lastCandle.close + (2 * atr)
      : lastCandle.close - (2 * atr);

    return {
      id: `${Date.now()}_${action}_v1.0`,
      pair: 'XAU_USD',
      action,
      entryPrice: lastCandle.close,
      stopLoss,
      takeProfit,
      atr,
      score,
      strategyVersion: 'v1.0',
      timestamp: Date.now()
    };

  } catch (err) {
    return null;
  }
}
