export function generateSignal(indicators, candles1m) {
  try {
    const {
      currEMA20, currEMA50,
      prevEMA20, prevEMA50,
      slopePercent, atr,
      atrAverage, rsi,
      resistance, support,
      trend1h, lastCandle,
      ema20arr, ema50arr,
    } = indicators;

    // ── Step 1: Detect crossover within last 3 candles ──────────────────────
    // Pure crossover (exact bar) fires maybe once a day on 5m gold.
    // We extend the window to 3 bars so we don't miss valid entries by 1 candle.
    let action = null;

    // Check last 3 bars for a crossover event
    if (ema20arr && ema50arr && ema20arr.length >= 4 && ema50arr.length >= 4) {
      const len = ema20arr.length;
      for (let lookback = 1; lookback <= 3; lookback++) {
        const prevE20 = ema20arr[len - 1 - lookback];
        const prevE50 = ema50arr[len - 1 - lookback];
        const currE20 = ema20arr[len - lookback];
        const currE50 = ema50arr[len - lookback];

        if (prevE20 <= prevE50 && currE20 > currE50) { action = 'BUY';  break; }
        if (prevE20 >= prevE50 && currE20 < currE50) { action = 'SELL'; break; }
      }
    } else {
      // Fallback: single-bar crossover (original behaviour)
      if (prevEMA20 <= prevEMA50 && currEMA20 > currEMA50) action = 'BUY';
      if (prevEMA20 >= prevEMA50 && currEMA20 < currEMA50) action = 'SELL';
    }

    if (!action) return null;

    // ── Step 2: Price vs EMA20 confirmation ─────────────────────────────────
    if (action === 'BUY'  && lastCandle.close <= currEMA20) return null;
    if (action === 'SELL' && lastCandle.close >= currEMA20) return null;

    // ── Step 3: 1h trend alignment ──────────────────────────────────────────
    if (action === 'BUY'  && trend1h !== 'UP')   return null;
    if (action === 'SELL' && trend1h !== 'DOWN')  return null;

    // ── Step 4: 1m momentum confirmation ───────────────────────────────────
    const last1m = candles1m[candles1m.length - 1];
    if (action === 'BUY'  && last1m.close < last1m.open) return null;
    if (action === 'SELL' && last1m.close > last1m.open) return null;

    // ── Step 5: Scoring ─────────────────────────────────────────────────────
    let score = 0;

    // Trend alignment (+2 — always true here since we checked above, kept for clarity)
    if (trend1h === (action === 'BUY' ? 'UP' : 'DOWN')) score += 2;

    // ATR in good range
    if (atr > 2) score += 1;

    // Momentum candle
    if (action === 'BUY'  && lastCandle.close > lastCandle.open) score += 1;
    if (action === 'SELL' && lastCandle.close < lastCandle.open) score += 1;

    // EMA slope in direction of trade
    if (action === 'BUY'  && slopePercent > 0) score += 1;
    if (action === 'SELL' && slopePercent < 0) score += 1;

    // Penalise proximity to key levels
    const nearResistance = action === 'BUY'  && (resistance - lastCandle.close) < atr * 0.5;
    const nearSupport    = action === 'SELL' && (lastCandle.close - support)    < atr * 0.5;
    if (nearResistance || nearSupport) score -= 2;

    // Penalise extreme RSI
    if (rsi > 70 || rsi < 30) score -= 1;

    if (score < 2) return null;

    // ── Step 6: Build signal ─────────────────────────────────────────────────
    const stopLoss   = action === 'BUY'
      ? lastCandle.close - (1.5 * atr)
      : lastCandle.close + (1.5 * atr);

    const takeProfit = action === 'BUY'
      ? lastCandle.close + (2 * atr)
      : lastCandle.close - (2 * atr);

    return {
      id: `${Date.now()}_${action}_v1.1`,
      pair: 'XAU_USD',
      action,
      entryPrice: lastCandle.close,
      stopLoss,
      takeProfit,
      atr,
      score,
      strategyVersion: 'v1.1',
      timestamp: Date.now(),
    };

  } catch (err) {
    return null;
  }
}
