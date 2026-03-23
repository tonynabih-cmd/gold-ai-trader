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

    // ── Debug snapshot (all intermediate values — for logging only) ───────────
    const len     = (ema20arr && ema20arr.length >= 2) ? ema20arr.length : 0;
    const dbgPrevE20 = len > 0 ? ema20arr[len - 2] : prevEMA20;
    const dbgPrevE50 = len > 0 ? ema50arr[len - 2] : prevEMA50;
    const dbgCurrE20 = len > 0 ? ema20arr[len - 1] : currEMA20;
    const dbgCurrE50 = len > 0 ? ema50arr[len - 1] : currEMA50;
    const dbgEmaSep  = Math.abs(currEMA20 - currEMA50);
    const dbgDistToEMA20 = Math.abs(lastCandle.close - currEMA20);

    let dbgCrossoverChecked = false;
    let dbgBuyCrossover     = false;
    let dbgSellCrossover    = false;
    let dbgPullbackChecked  = false;

    // ── Entry Type 1: EMA 20/50 Crossover (CURRENT bar only) ─────────────────
    if (ema20arr && ema50arr && ema20arr.length >= 2 && ema50arr.length >= 2) {
      const pE20 = ema20arr[ema20arr.length - 2];
      const pE50 = ema50arr[ema50arr.length - 2];
      const cE20 = ema20arr[ema20arr.length - 1];
      const cE50 = ema50arr[ema50arr.length - 1];

      if (
        typeof pE20 === 'number' && typeof pE50 === 'number' &&
        typeof cE20 === 'number' && typeof cE50 === 'number'
      ) {
        dbgCrossoverChecked = true;
        dbgBuyCrossover  = pE20 <= pE50 && cE20 > cE50;
        dbgSellCrossover = pE20 >= pE50 && cE20 < cE50;
        if (dbgBuyCrossover)  { action = 'BUY';  entryType = 'crossover'; }
        if (dbgSellCrossover) { action = 'SELL'; entryType = 'crossover'; }
      }
    } else if (typeof prevEMA20 === 'number' && typeof prevEMA50 === 'number') {
      dbgCrossoverChecked = true;
      dbgBuyCrossover  = prevEMA20 <= prevEMA50 && currEMA20 > currEMA50;
      dbgSellCrossover = prevEMA20 >= prevEMA50 && currEMA20 < currEMA50;
      if (dbgBuyCrossover)  { action = 'BUY';  entryType = 'crossover'; }
      if (dbgSellCrossover) { action = 'SELL'; entryType = 'crossover'; }
    }

    // ── Entry Type 2: Pullback to EMA20 in established trend ─────────────────
    let dbgPullbackReason = null; // set to a string whenever a pullback gate fails
    let dbgSetupReady     = false; // true only when setup is aligned but candle confirmation is missing
    if (!action) {
      dbgPullbackChecked = true;
      const emaSeparation    = dbgEmaSep;
      const trendEstablished = emaSeparation > atr * 0.3;
      const distanceToEMA20  = dbgDistToEMA20;
      const touchedEMA20     = distanceToEMA20 < atr * 0.8;
      const rsiNeutral       = rsi > 35 && rsi < 65;

      if (!trendEstablished) {
        dbgPullbackReason = `pullback: trend not established (EMA sep ${emaSeparation.toFixed(2)} <= ATR*0.3 ${(atr * 0.3).toFixed(2)})`;
      } else if (!touchedEMA20) {
        dbgPullbackReason = `pullback: price not close enough to EMA20 (dist ${distanceToEMA20.toFixed(2)}, threshold ${(atr * 0.8).toFixed(2)})`;
      } else if (!rsiNeutral) {
        dbgPullbackReason = `pullback: RSI not neutral (RSI ${rsi.toFixed(1)}, need 35–65)`;
      } else {
        // Pre-conditions passed — check directional entry
        const inUptrend   = currEMA20 > currEMA50;
        const inDowntrend = currEMA20 < currEMA50;

        if (inUptrend) {
          if (trend1h !== 'UP') {
            dbgPullbackReason = `pullback BUY: 1h trend mismatch (got ${trend1h}, need UP)`;
          } else if (lastCandle.close <= lastCandle.open) {
            dbgSetupReady     = true;
            dbgPullbackReason = 'pullback BUY: candle not bullish (close <= open)';
          } else if (lastCandle.close <= currEMA20) {
            dbgPullbackReason = 'pullback BUY: price closed below EMA20';
          } else {
            action = 'BUY'; entryType = 'pullback';
          }
        } else if (inDowntrend) {
          if (trend1h !== 'DOWN') {
            dbgPullbackReason = `pullback SELL: 1h trend mismatch (got ${trend1h}, need DOWN)`;
          } else if (lastCandle.close >= lastCandle.open) {
            dbgSetupReady     = true;
            dbgPullbackReason = 'pullback SELL: candle not bearish (close >= open)';
          } else if (lastCandle.close >= currEMA20) {
            dbgPullbackReason = 'pullback SELL: price closed above EMA20';
          } else {
            action = 'SELL'; entryType = 'pullback';
          }
        } else {
          dbgPullbackReason = 'pullback: EMAs not separated (currEMA20 == currEMA50)';
        }
      }
    }

    // ── Build shared debug object (returned regardless of signal) ─────────────
    const signalDebug = {
      dbgCurrE20:          +dbgCurrE20?.toFixed(4),
      dbgCurrE50:          +dbgCurrE50?.toFixed(4),
      dbgPrevE20:          +dbgPrevE20?.toFixed(4),
      dbgPrevE50:          +dbgPrevE50?.toFixed(4),
      dbgEmaSeparation:    +dbgEmaSep?.toFixed(4),
      dbgDistToEMA20:      +dbgDistToEMA20?.toFixed(4),
      dbgCrossoverChecked,
      dbgBuyCrossover,
      dbgSellCrossover,
      dbgPullbackChecked,
      dbgPullbackReason,
      dbgSetupReady,
      dbgAction:           action,
      dbgEntryType:        entryType,
    };

    if (!action) return { signal: null, debug: { ...signalDebug, dbgRejectReason: dbgPullbackReason ?? 'no crossover and no pullback signal' } };

    // ── Multi-timeframe filter: 1h trend must agree ───────────────────────────
    if (action === 'BUY'  && trend1h !== 'UP')   return { signal: null, debug: { ...signalDebug, dbgRejectReason: 'trend1h mismatch (BUY requires UP)' } };
    if (action === 'SELL' && trend1h !== 'DOWN')  return { signal: null, debug: { ...signalDebug, dbgRejectReason: 'trend1h mismatch (SELL requires DOWN)' } };

    // ── 1m momentum confirmation ──────────────────────────────────────────────
    const last1m = candles1m[candles1m.length - 1];
    if (!last1m || typeof last1m.close !== 'number' || typeof last1m.open !== 'number') return { signal: null, debug: { ...signalDebug, dbgRejectReason: '1m candle invalid' } };
    if (action === 'BUY'  && last1m.close < last1m.open) return { signal: null, debug: { ...signalDebug, dbgRejectReason: '1m momentum bearish (BUY rejected)' } };
    if (action === 'SELL' && last1m.close > last1m.open) return { signal: null, debug: { ...signalDebug, dbgRejectReason: '1m momentum bullish (SELL rejected)' } };

    // ── Crossover: price must be on the correct side of EMA20 ────────────────
    if (entryType === 'crossover') {
      if (action === 'BUY'  && lastCandle.close <= currEMA20) return { signal: null, debug: { ...signalDebug, dbgRejectReason: 'crossover BUY: price not above EMA20' } };
      if (action === 'SELL' && lastCandle.close >= currEMA20) return { signal: null, debug: { ...signalDebug, dbgRejectReason: 'crossover SELL: price not below EMA20' } };
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

    if (score < 2) return { signal: null, debug: { ...signalDebug, dbgScore: score, dbgRejectReason: `score too low (${score}/required 2)` } };

    // ── Build signal object ───────────────────────────────────────────────────
    // Stop loss: 1.5× ATR from entry. Take profit: 2× ATR (1:1.33 R:R minimum).
    const stopLoss = action === 'BUY'
      ? lastCandle.close - (1.5 * atr)
      : lastCandle.close + (1.5 * atr);

    const takeProfit = action === 'BUY'
      ? lastCandle.close + (2 * atr)
      : lastCandle.close - (2 * atr);

    if (isNaN(stopLoss) || isNaN(takeProfit)) return { signal: null, debug: { ...signalDebug, dbgRejectReason: 'stopLoss or takeProfit is NaN' } };

    const now = Date.now();

    return {
      signal: {
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
      },
      debug: { ...signalDebug, dbgScore: score, dbgRejectReason: null },
    };

  } catch (err) {
    console.error('generateSignal error:', err.message);
    return { signal: null, debug: { dbgRejectReason: `exception: ${err.message}` } };
  }
}
