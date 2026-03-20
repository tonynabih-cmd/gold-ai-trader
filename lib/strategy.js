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

    let action    = null;
    let entryType = null;

    // ── Entry Type 1: Crossover (within last 3 bars) ─────────────────────────
    if (ema20arr && ema50arr && ema20arr.length >= 4 && ema50arr.length >= 4) {
      const len = ema20arr.length;
      for (let lookback = 1; lookback <= 3; lookback++) {
        const prevE20 = ema20arr[len - 1 - lookback];
        const prevE50 = ema50arr[len - 1 - lookback];
        const currE20 = ema20arr[len - lookback];
        const currE50 = ema50arr[len - lookback];
        if (prevE20 <= prevE50 && currE20 > currE50) { action = 'BUY';  entryType = 'crossover'; break; }
        if (prevE20 >= prevE50 && currE20 < currE50) { action = 'SELL'; entryType = 'crossover'; break; }
      }
    } else {
      if (prevEMA20 <= prevEMA50 && currEMA20 > currEMA50) { action = 'BUY';  entryType = 'crossover'; }
      if (prevEMA20 >= prevEMA50 && currEMA20 < currEMA50) { action = 'SELL'; entryType = 'crossover'; }
    }

    // ── Entry Type 2: Pullback to EMA20 in established trend ─────────────────
    if (!action) {
      const emaSeparation    = Math.abs(currEMA20 - currEMA50);
      const trendEstablished = emaSeparation > atr * 0.3;
      const distanceToEMA20  = Math.abs(lastCandle.close - currEMA20);
      const touchedEMA20     = distanceToEMA20 < atr * 0.8; // widened from 0.5
      const rsiNeutral       = rsi > 35 && rsi < 65;

      if (trendEstablished && touchedEMA20 && rsiNeutral) {
        if (
          currEMA20 > currEMA50 && trend1h === 'UP' &&
          lastCandle.close > lastCandle.open &&
          lastCandle.close > currEMA20
        ) { action = 'BUY'; entryType = 'pullback'; }

        if (
          currEMA20 < currEMA50 && trend1h === 'DOWN' &&
          lastCandle.close < lastCandle.open &&
          lastCandle.close < currEMA20
        ) { action = 'SELL'; entryType = 'pullback'; }
      }
    }

    if (!action) return null;

    // ── Shared filters ────────────────────────────────────────────────────────
    if (action === 'BUY'  && trend1h !== 'UP')   return null;
    if (action === 'SELL' && trend1h !== 'DOWN')  return null;

    // 1m momentum confirmation
    const last1m = candles1m[candles1m.length - 1];
    if (action === 'BUY'  && last1m.close < last1m.open) return null;
    if (action === 'SELL' && last1m.close > last1m.open) return null;

    // Crossover: price must be on correct side of EMA20
    if (entryType === 'crossover') {
      if (action === 'BUY'  && lastCandle.close <= currEMA20) return null;
      if (action === 'SELL' && lastCandle.close >= currEMA20) return null;
    }

    // ── Scoring ───────────────────────────────────────────────────────────────
    let score = 0;
    if (trend1h === (action === 'BUY' ? 'UP' : 'DOWN')) score += 2;
    if (atr > 2) score += 1;
    if (action === 'BUY'  && lastCandle.close > lastCandle.open) score += 1;
    if (action === 'SELL' && lastCandle.close < lastCandle.open) score += 1;
    if (action === 'BUY'  && slopePercent > 0) score += 1;
    if (action === 'SELL' && slopePercent < 0) score += 1;
    if (entryType === 'pullback') score += 1;

    const nearResistance = action === 'BUY'  && (resistance - lastCandle.close) < atr * 0.5;
    const nearSupport    = action === 'SELL' && (lastCandle.close - support)    < atr * 0.5;
    if (nearResistance || nearSupport) score -= 2;
    if (rsi > 70 || rsi < 30) score -= 1;

    if (score < 2) return null;

    // ── Build signal ──────────────────────────────────────────────────────────
    const stopLoss = action === 'BUY'
      ? lastCandle.close - (1.5 * atr)
      : lastCandle.close + (1.5 * atr);

    const takeProfit = action === 'BUY'
      ? lastCandle.close + (2 * atr)
      : lastCandle.close - (2 * atr);

    return {
      id:              `${Date.now()}_${action}_v1.1`,
      pair:            'GOLD',
      action,
      entryType,
      entryPrice:      lastCandle.close,
      stopLoss,
      takeProfit,
      atr,
      score,
      strategyVersion: 'v1.1',
      timestamp:       Date.now(),
    };

  } catch (err) {
    return null;
  }
}
