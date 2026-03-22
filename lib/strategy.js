// strategy.js — Generate trade signals using pure EMA math. Zero Claude API calls.
// Two entry types: (1) EMA 20/50 crossover, (2) Pullback to EMA20 in established trend.
// Returns a signal object or null (no trade this cycle).
//
// FIX: Crossover now only checks the CURRENT bar (prevEMA vs currEMA).
// The previous 3-bar lookback caused "Signal from already processed candle" skips
// because it would re-detect crossovers on candles that were already processed in
// previous cron cycles. A crossover on an old candle is a stale signal — don't trade it.

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

    // ── Guard: candles1m must exist and have data ─────────────────────────────
    if (!candles1m || candles1m.length === 0) return null;

    // ── Guard: core indicator values must be valid numbers ────────────────────
    if (
      typeof currEMA20 !== 'number' || isNaN(currEMA20) ||
      typeof currEMA50 !== 'number' || isNaN(currEMA50) ||
      typeof atr       !== 'number' || isNaN(atr)       ||
      typeof rsi       !== 'number' || isNaN(rsi)       ||
      !lastCandle || typeof lastCandle.close !== 'number'
    ) return null;

    let action    = null;
    let entryType = null;

    // ── Entry Type 1: EMA 20/50 Crossover (CURRENT bar only) ─────────────────
    // Only checks whether a crossover happened on the MOST RECENT candle.
    // This means prevEMA (bar n-1) was on one side, currEMA (bar n) crossed over.
    //
    // WHY ONLY 1 BAR:
    // The old 3-bar lookback re-detected crossovers from candles processed in
    // previous cron cycles. Those signals were rejected with "Signal from already
    // processed candle" because lastProcessedCandle was already past that bar.
    // Now we only signal on a crossover that just happened — the current candle.
    if (ema20arr && ema50arr && ema20arr.length >= 2 && ema50arr.length >= 2) {
      const len     = ema20arr.length;
      const prevE20 = ema20arr[len - 2]; // bar n-1 (previous)
      const prevE50 = ema50arr[len - 2];
      const currE20 = ema20arr[len - 1]; // bar n (current, just formed)
      const currE50 = ema50arr[len - 1];

      if (
        typeof prevE20 === 'number' && typeof prevE50 === 'number' &&
        typeof currE20 === 'number' && typeof currE50 === 'number'
      ) {
        // BUY: EMA20 crossed ABOVE EMA50 on the current candle
        if (prevE20 <= prevE50 && currE20 > currE50) { action = 'BUY';  entryType = 'crossover'; }
        // SELL: EMA20 crossed BELOW EMA50 on the current candle
        if (prevE20 >= prevE50 && currE20 < currE50) { action = 'SELL'; entryType = 'crossover'; }
      }
    } else if (typeof prevEMA20 === 'number' && typeof prevEMA50 === 'number') {
      // Fallback: use pre-computed prev/curr values from indicators
      if (prevEMA20 <= prevEMA50 && currEMA20 > currEMA50) { action = 'BUY';  entryType = 'crossover'; }
      if (prevEMA20 >= prevEMA50 && currEMA20 < currEMA50) { action = 'SELL'; entryType = 'crossover'; }
    }

    // ── Entry Type 2: Pullback to EMA20 in established trend ─────────────────
    // Only fires when EMAs are well-separated (trend is established) and price
    // has pulled back close to EMA20, giving a lower-risk entry.
    if (!action) {
      const emaSeparation    = Math.abs(currEMA20 - currEMA50);
      const trendEstablished = emaSeparation > atr * 0.3;
      const distanceToEMA20  = Math.abs(lastCandle.close - currEMA20);
      const touchedEMA20     = distanceToEMA20 < atr * 0.8;
      const rsiNeutral       = rsi > 35 && rsi < 65;

      if (trendEstablished && touchedEMA20 && rsiNeutral) {
        if (
          currEMA20 > currEMA50     &&   // uptrend structure
          trend1h === 'UP'          &&   // 1h confirms uptrend
          lastCandle.close > lastCandle.open &&   // bullish candle
          lastCandle.close > currEMA20            // closed above EMA20
        ) { action = 'BUY'; entryType = 'pullback'; }

        if (
          currEMA20 < currEMA50     &&   // downtrend structure
          trend1h === 'DOWN'        &&   // 1h confirms downtrend
          lastCandle.close < lastCandle.open &&   // bearish candle
          lastCandle.close < currEMA20            // closed below EMA20
        ) { action = 'SELL'; entryType = 'pullback'; }
      }
    }

    if (!action) return null;

    // ── Multi-timeframe filter: 1h trend must agree ───────────────────────────
    if (action === 'BUY'  && trend1h !== 'UP')   return null;
    if (action === 'SELL' && trend1h !== 'DOWN')  return null;

    // ── 1m momentum confirmation ──────────────────────────────────────────────
    // The most recent 1m candle must close in the signal direction.
    const last1m = candles1m[candles1m.length - 1];
    if (!last1m || typeof last1m.close !== 'number' || typeof last1m.open !== 'number') return null;
    if (action === 'BUY'  && last1m.close < last1m.open) return null;
    if (action === 'SELL' && last1m.close > last1m.open) return null;

    // ── Crossover: price must be on the correct side of EMA20 ────────────────
    // Prevents entries where crossover happened but price immediately reversed.
    if (entryType === 'crossover') {
      if (action === 'BUY'  && lastCandle.close <= currEMA20) return null;
      if (action === 'SELL' && lastCandle.close >= currEMA20) return null;
    }

    // ── Signal scoring ────────────────────────────────────────────────────────
    let score = 0;

    // Trend alignment (already guaranteed by filters above, but score it)
    if (trend1h === (action === 'BUY' ? 'UP' : 'DOWN')) score += 2;

    // Volatility: strong ATR means meaningful price moves
    if (atr > 2) score += 1;

    // Candle direction matches signal
    if (action === 'BUY'  && lastCandle.close > lastCandle.open) score += 1;
    if (action === 'SELL' && lastCandle.close < lastCandle.open) score += 1;

    // EMA slope confirms direction
    if (action === 'BUY'  && slopePercent > 0) score += 1;
    if (action === 'SELL' && slopePercent < 0) score += 1;

    // Pullback entries get a bonus (lower risk entry)
    if (entryType === 'pullback') score += 1;

    // Penalty: near key S/R levels (high chance of reversal)
    const nearResistance = action === 'BUY'  && (resistance - lastCandle.close) > 0 && (resistance - lastCandle.close) < atr * 0.5;
    const nearSupport    = action === 'SELL' && (lastCandle.close - support) > 0 && (lastCandle.close - support) < atr * 0.5;
    if (nearResistance || nearSupport) score -= 2;

    // Penalty: RSI overbought/oversold
    if (rsi > 70 || rsi < 30) score -= 1;

    if (score < 2) return null;

    // ── Build signal object ───────────────────────────────────────────────────
    // Stop loss: 1.5× ATR from entry. Take profit: 2× ATR (1:1.33 R:R minimum).
    const stopLoss = action === 'BUY'
      ? lastCandle.close - (1.5 * atr)
      : lastCandle.close + (1.5 * atr);

    const takeProfit = action === 'BUY'
      ? lastCandle.close + (2 * atr)
      : lastCandle.close - (2 * atr);

    // Guard: stop and take profit must be valid
    if (isNaN(stopLoss) || isNaN(takeProfit)) return null;

    // Use a single timestamp for both id and timestamp fields
    const now = Date.now();

    return {
      id:              `${now}_${action}_v1.1`,
      pair:            'GOLD',
      action,
      entryType,
      entryPrice:      lastCandle.close,
      stopLoss,
      takeProfit,
      atr,
      score,
      strategyVersion: 'v1.1',
      timestamp:       now,
    };

  } catch (err) {
    console.error('generateSignal error:', err.message);
    return null; // Never throw — always return null on error
  }
}
