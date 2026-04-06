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
    if (!candles1m || candles1m.length === 0) return { signal: null, debug: { dbgRejectReason: 'missing or empty candles1m' } };

    // ── Guard: core indicator values must be valid numbers ────────────────────
    if (
      typeof currEMA20 !== 'number' || isNaN(currEMA20) ||
      typeof currEMA50 !== 'number' || isNaN(currEMA50) ||
      typeof atr       !== 'number' || isNaN(atr)       ||
      typeof rsi       !== 'number' || isNaN(rsi)       ||
      !lastCandle || typeof lastCandle.close !== 'number'
    ) return { signal: null, debug: { dbgRejectReason: 'invalid or missing indicator values' } };

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

    // ── Entry Type 2: Pullback or Momentum Continuation ─────────────────────
    let dbgPullbackReason = null; 
    let dbgSetupReady     = false; 
    if (!action) {
      dbgPullbackChecked = true;
      const emaSeparation    = dbgEmaSep;
      const trendEstablished = emaSeparation > atr * 0.3;
      const distanceToEMA20  = dbgDistToEMA20;
      const touchedEMA20     = distanceToEMA20 < atr * 1.5;
      const rsiNeutral       = rsi > 30 && rsi < 70;

      // MOMENTUM UPGRADE: If a crossover just happened on the current candle, we allow entry 
      // without touching EMA20 if the trend slope is very strong.
      const recentCrossover = dbgBuyCrossover || dbgSellCrossover;
      
      const isStrongTrend = Math.abs(slopePercent) > 0.15;
      const momentumEntryAllowed = recentCrossover && isStrongTrend;

      if (!trendEstablished && !momentumEntryAllowed) {
        dbgPullbackReason = `pullback: trend not established (EMA sep ${emaSeparation.toFixed(2)} <= ATR*0.3 ${(atr * 0.3).toFixed(2)})`;
      } else if (!touchedEMA20 && !momentumEntryAllowed) {
        dbgPullbackReason = `pullback: price not close enough to EMA20 (dist ${distanceToEMA20.toFixed(2)}, threshold ${(atr * 1.5).toFixed(2)})`;
      } else if (!rsiNeutral && !momentumEntryAllowed) {
        dbgPullbackReason = `pullback: RSI not neutral (RSI ${rsi.toFixed(1)}, need 30–70)`;
      } else {
        // Pre-conditions passed — check directional entry
        const inUptrend   = currEMA20 > currEMA50;
        const inDowntrend = currEMA20 < currEMA50;

        if (inUptrend) {
          if (slopePercent <= 0.1) {
            dbgPullbackReason = `pullback BUY: weak EMA slope (got ${slopePercent.toFixed(4)}%, need > 0.1%)`;
          } else if (lastCandle.close <= lastCandle.open && !momentumEntryAllowed) {
            dbgSetupReady     = true;
            dbgPullbackReason = 'pullback BUY: candle not bullish (close <= open)';
          } else if (lastCandle.close <= currEMA20 && !momentumEntryAllowed) {
            dbgPullbackReason = 'pullback BUY: price closed below EMA20';
          } else {
            action = 'BUY'; 
            entryType = momentumEntryAllowed ? 'momentum' : 'pullback';
          }
        } else if (inDowntrend) {
          if (slopePercent >= -0.1) {
            dbgPullbackReason = `pullback SELL: weak EMA slope (got ${slopePercent.toFixed(4)}%, need < -0.1%)`;
          } else if (lastCandle.close >= lastCandle.open && !momentumEntryAllowed) {
            dbgSetupReady     = true;
            dbgPullbackReason = 'pullback SELL: candle not bearish (close >= open)';
          } else if (lastCandle.close >= currEMA20 && !momentumEntryAllowed) {
            dbgPullbackReason = 'pullback SELL: price closed above EMA20';
          } else {
            action = 'SELL'; 
            entryType = momentumEntryAllowed ? 'momentum' : 'pullback';
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

    // ── Trend momentum filter: requires strong 5m EMA slope ───────────────────
    // EXCEPTION: Crossovers are a signal of trend SHIFT, so they bypass the slope requirement.
    // Pullbacks represent trend CONTINUATION, so they MUST have a confirmed slope.
    let weakSlope = false;
    if (action === 'BUY'  && slopePercent <= 0.1)  weakSlope = true;
    if (action === 'SELL' && slopePercent >= -0.1) weakSlope = true;

    if (weakSlope && entryType !== 'crossover') {
      return { signal: null, debug: { ...signalDebug, dbgRejectReason: `weak EMA slope (${action} requires ${action === 'BUY' ? '> 0.1%' : '< -0.1%'}, got ${slopePercent.toFixed(4)}%)` } };
    }

    // ── 1m momentum confirmation (3-candle net + direction consistency) ───────
    // CRITICAL: Prevent weak signals. Momentum must be:
    // 1. Strong enough: net movement > $0.15 per direction
    // 2. Directional consistency: at least 2 of 3 candles agree with direction
    // This avoids "barely positive" signals like net +$0.001 in choppy markets
    const recent1m = candles1m.slice(-3);
    const dbg1mCandlesUsed = recent1m.length;
    let netMomentum1m = 0;
    let bullishCandles = 0;  // Candles that close above open
    let bearishCandles = 0;  // Candles that close below open

    if (dbg1mCandlesUsed > 0) {
      netMomentum1m = recent1m.reduce((sum, candle) => {
        if (typeof candle.close === 'number' && typeof candle.open === 'number') {
          if (candle.close > candle.open) bullishCandles++;
          else if (candle.close < candle.open) bearishCandles++;
          return sum + (candle.close - candle.open);
        }
        return sum;
      }, 0);
    } else {
      console.warn('1m momentum check: No candle data available, falling back to 0');
    }

    // FIX: Scale momentum threshold with ATR instead of a fixed dollar amount.
    // Fixed $0.10 on gold (~$3000) is 0.003% — pure noise. ATR-scaled threshold
    // adapts to current volatility and filters meaningfully.
    const minMomentumThreshold = atr * 0.05;
    
    if (action === 'BUY') {
      if (netMomentum1m <= 0) {
        return { signal: null, debug: { ...signalDebug, dbg1mMomentumNet: +netMomentum1m.toFixed(4), dbg1mCandlesUsed, dbgRejectReason: `1m momentum not bullish (net: ${netMomentum1m.toFixed(4)})` } };
      }
      if (netMomentum1m < minMomentumThreshold) {
        return { signal: null, debug: { ...signalDebug, dbg1mMomentumNet: +netMomentum1m.toFixed(4), dbg1mCandlesUsed, dbgRejectReason: `1m momentum too weak (${netMomentum1m.toFixed(4)} < $${minMomentumThreshold})` } };
      }
      if (bullishCandles < 2) {
        return { signal: null, debug: { ...signalDebug, dbg1mMomentumNet: +netMomentum1m.toFixed(4), dbg1mCandlesUsed, dbgRejectReason: `1m direction inconsistent (only ${bullishCandles}/3 candles bullish)` } };
      }
    }
    
    if (action === 'SELL') {
      if (netMomentum1m >= 0) {
        return { signal: null, debug: { ...signalDebug, dbg1mMomentumNet: +netMomentum1m.toFixed(4), dbg1mCandlesUsed, dbgRejectReason: `1m momentum not bearish (net: ${netMomentum1m.toFixed(4)})` } };
      }
      if (Math.abs(netMomentum1m) < minMomentumThreshold) {
        return { signal: null, debug: { ...signalDebug, dbg1mMomentumNet: +netMomentum1m.toFixed(4), dbg1mCandlesUsed, dbgRejectReason: `1m momentum too weak (${Math.abs(netMomentum1m).toFixed(4)} < $${minMomentumThreshold})` } };
      }
      if (bearishCandles < 2) {
        return { signal: null, debug: { ...signalDebug, dbg1mMomentumNet: +netMomentum1m.toFixed(4), dbg1mCandlesUsed, dbgRejectReason: `1m direction inconsistent (only ${bearishCandles}/3 candles bearish)` } };
      }
    }

    // Update debug object with momentum data for the successful signal case
    signalDebug.dbg1mMomentumNet = +netMomentum1m.toFixed(4);
    signalDebug.dbg1mCandlesUsed = dbg1mCandlesUsed;

    // ── Crossover: price must be on the correct side of EMA20 ────────────────
    if (entryType === 'crossover') {
      if (action === 'BUY'  && lastCandle.close <= currEMA20) return { signal: null, debug: { ...signalDebug, dbgRejectReason: 'crossover BUY: price not above EMA20' } };
      if (action === 'SELL' && lastCandle.close >= currEMA20) return { signal: null, debug: { ...signalDebug, dbgRejectReason: 'crossover SELL: price not below EMA20' } };
    }

    // ── Signal scoring ────────────────────────────────────────────────────────
    let score = 0;

    // Trend alignment scoring
    // Crossover is a strong shift signal: ALWAYS +2
    // Pullback is trend continuation: +2 if slope is strong
    if (entryType === 'crossover') {
      score += 2;
    } else if (entryType === 'pullback') {
      if (action === 'BUY'  && slopePercent > 0.1)  score += 2;
      if (action === 'SELL' && slopePercent < -0.1) score += 2;
    }

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

    // Penalty: Counter-trend relative to 1h timeframe
    // If buying while 1h trend is DOWN, or selling while 1h trend is UP, -1 point.
    if (action === 'BUY'  && trend1h === 'DOWN') score -= 1;
    if (action === 'SELL' && trend1h === 'UP')   score -= 1;

    // FIX: Raised minimum score from 2 to 3. Score of 2 is too easy — crossovers
    // always get +2 automatically, meaning they were never filtered. Score 3 requires
    // at least one additional confirmation factor.
    if (score < 3) return { signal: null, debug: { ...signalDebug, dbgScore: score, dbgRejectReason: `score too low (${score}/required 3)` } };

    // ── Build signal object ───────────────────────────────────────────────────
    // FIX: Tightened from 2.0×/3.0× to 1.5×/2.25× ATR.
    // On 5-minute gold candles (ATR ~$2-4), 3× ATR = $6-12 target was rarely hit.
    // 2.25× ATR = $4.5-9 is more reachable while maintaining the 1:1.5 R:R ratio.
    // Note: execution.js recalculates these from the actual execution price.
    const stopLoss = action === 'BUY'
      ? lastCandle.close - (1.5 * atr)
      : lastCandle.close + (1.5 * atr);

    const takeProfit = action === 'BUY'
      ? lastCandle.close + (2.25 * atr)
      : lastCandle.close - (2.25 * atr);

    if (isNaN(stopLoss) || isNaN(takeProfit)) return { signal: null, debug: { ...signalDebug, dbgRejectReason: 'stopLoss or takeProfit is NaN' } };

    const now = Date.now();

    return {
      signal: {
        id:              `${lastCandle.time}_${action}_v1.1`,
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
