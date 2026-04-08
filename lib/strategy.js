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

    const PULLBACK_SLOPE_THRESHOLD = 0.10; // Lowered from 0.12 to capture more steady trends
    const CROSSOVER_SLOPE_THRESHOLD = 0.06; // Lowered from 0.08 to capture fresh crosses earlier
    const TAKE_PROFIT_ATR_MULTIPLIER = 2.25;
    const STOP_LOSS_ATR_MULTIPLIER = 1.5;
    const MOMENTUM_RANGE_MULTIPLIER = 0.06;
    const STRONG_BODY_MULTIPLIER = 0.08;

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
    let dbgRecentTrendCross = null;
    let dbgCrossoverAgeBars = null;

    // ── Entry Type 1: EMA 20/50 Crossover (1-candle confirmation) ───────────
    if (ema20arr && ema50arr && ema20arr.length >= 3 && ema50arr.length >= 3) {
      dbgCrossoverChecked = true;
      const oldestIdx = Math.max(1, ema20arr.length - 3);

      for (let i = ema20arr.length - 1; i >= oldestIdx; i--) {
        const prev20 = ema20arr[i - 1];
        const prev50 = ema50arr[i - 1];
        const curr20 = ema20arr[i];
        const curr50 = ema50arr[i];

        if (![prev20, prev50, curr20, curr50].every(v => typeof v === 'number' && !isNaN(v))) continue;

        const buyCross = prev20 <= prev50 && curr20 > curr50;
        const sellCross = prev20 >= prev50 && curr20 < curr50;
        if (!buyCross && !sellCross) continue;

        const ageBars = (ema20arr.length - 1) - i;
        dbgBuyCrossover = dbgBuyCrossover || buyCross;
        dbgSellCrossover = dbgSellCrossover || sellCross;
        dbgCrossoverAgeBars = ageBars;

        if (ageBars === 0) {
          break;
        }

        const currentSep = Math.abs(currEMA20 - currEMA50);
        const hasSlope = buyCross
          ? slopePercent >= CROSSOVER_SLOPE_THRESHOLD
          : slopePercent <= -CROSSOVER_SLOPE_THRESHOLD;
        const hasSeparation = currentSep >= atr * 0.2;

        if (hasSlope && hasSeparation) {
          action = buyCross ? 'BUY' : 'SELL';
          entryType = 'crossover';
        }
        break;
      }
    } else if (typeof prevEMA20 === 'number' && typeof prevEMA50 === 'number') {
      dbgCrossoverChecked = true;
      dbgBuyCrossover  = prevEMA20 <= prevEMA50 && currEMA20 > currEMA50;
      dbgSellCrossover = prevEMA20 >= prevEMA50 && currEMA20 < currEMA50;
      dbgCrossoverAgeBars = 0;
    }

    // ── Entry Type 2: Pullback or Momentum Continuation ─────────────────────
    let dbgPullbackReason = null; 
    let dbgSetupReady     = false; 
    if (!action && dbgCrossoverAgeBars === 0) {
      dbgPullbackChecked = true;
      dbgPullbackReason = `crossover ${dbgBuyCrossover ? 'BUY' : 'SELL'}: waiting 1 candle for confirmation`;
    } else if (!action) {
      dbgPullbackChecked = true;
      const emaSeparation    = dbgEmaSep;
      const trendEstablished = emaSeparation > atr * 0.35;
      const distanceToEMA20  = dbgDistToEMA20;
      // Relaxed EMA20 touch: allow entry if within 0.15% of EMA20 price
      // This ensures we catch trends that never quite touch the line.
      const pullbackDistanceThreshold = currEMA20 * 0.0015;
      const touchedEMA20     = distanceToEMA20 < pullbackDistanceThreshold;
      const crossoverLookback = Math.min(8, Math.max((ema20arr?.length || 0) - 1, 0));
      let recentBullishCross = false;
      let recentBearishCross = false;

      if (ema20arr && ema50arr && crossoverLookback > 0) {
        for (let i = Math.max(1, ema20arr.length - crossoverLookback); i < ema20arr.length; i++) {
          const prev20 = ema20arr[i - 1];
          const prev50 = ema50arr[i - 1];
          const curr20 = ema20arr[i];
          const curr50 = ema50arr[i];

          if (![prev20, prev50, curr20, curr50].every(v => typeof v === 'number' && !isNaN(v))) continue;
          if (prev20 <= prev50 && curr20 > curr50) recentBullishCross = true;
          if (prev20 >= prev50 && curr20 < curr50) recentBearishCross = true;
        }
      } else {
        recentBullishCross = currEMA20 > currEMA50;
        recentBearishCross = currEMA20 < currEMA50;
      }

      // MOMENTUM UPGRADE: If a crossover just happened on the current candle, we allow entry 
      // without touching EMA20 if the trend slope is very strong.
      const recentCrossover = dbgCrossoverAgeBars === 1;
      
      const isStrongTrend = Math.abs(slopePercent) >= PULLBACK_SLOPE_THRESHOLD;
      const momentumEntryAllowed = recentCrossover && isStrongTrend;

      if (!trendEstablished && !momentumEntryAllowed) {
        dbgPullbackReason = `pullback: trend not established (EMA sep ${emaSeparation.toFixed(2)} <= ATR*0.35 ${(atr * 0.35).toFixed(2)})`;
      } else if (!touchedEMA20 && !momentumEntryAllowed) {
        dbgPullbackReason = `pullback: price not close enough to EMA20 (dist ${distanceToEMA20.toFixed(2)}, threshold ${pullbackDistanceThreshold.toFixed(2)})`;
      } else {
        // Pre-conditions passed — check directional entry
        const inUptrend   = currEMA20 > currEMA50;
        const inDowntrend = currEMA20 < currEMA50;

        if (inUptrend) {
          dbgRecentTrendCross = recentBullishCross ? 'BUY' : null;
          if (!recentBullishCross && !momentumEntryAllowed) {
            dbgPullbackReason = 'pullback BUY: no recent EMA20/EMA50 bullish crossover confirmation';
          } else if (slopePercent < PULLBACK_SLOPE_THRESHOLD) {
            dbgPullbackReason = `pullback BUY: weak EMA slope (got ${slopePercent.toFixed(4)}%, need >= ${PULLBACK_SLOPE_THRESHOLD}%)`;
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
          dbgRecentTrendCross = recentBearishCross ? 'SELL' : null;
          if (!recentBearishCross && !momentumEntryAllowed) {
            dbgPullbackReason = 'pullback SELL: no recent EMA20/EMA50 bearish crossover confirmation';
          } else if (slopePercent > -PULLBACK_SLOPE_THRESHOLD) {
            dbgPullbackReason = `pullback SELL: weak EMA slope (got ${slopePercent.toFixed(4)}%, need <= -${PULLBACK_SLOPE_THRESHOLD}%)`;
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
      dbgRecentTrendCross,
      dbgCrossoverAgeBars,
      dbgAction:           action,
      dbgEntryType:        entryType,
    };

    if (!action) return { signal: null, debug: { ...signalDebug, dbgRejectReason: dbgPullbackReason ?? 'no crossover and no pullback signal' } };

    if (entryType === 'crossover' && dbgCrossoverAgeBars === 0) {
      return { signal: null, debug: { ...signalDebug, dbgRejectReason: `crossover ${action}: waiting 1 candle for confirmation` } };
    }

    // Relaxed RSI blocks: 70/30 for pullbacks (strong trend) and 65/35 for crossovers
    const buyRsiBlock = entryType === 'pullback' ? 70 : 65;
    const sellRsiBlock = entryType === 'pullback' ? 30 : 35;
    if (action === 'BUY' && rsi >= buyRsiBlock) {
      return { signal: null, debug: { ...signalDebug, dbgRejectReason: `BUY blocked: RSI ${rsi.toFixed(1)} >= ${buyRsiBlock}` } };
    }
    if (action === 'SELL' && rsi <= sellRsiBlock) {
      return { signal: null, debug: { ...signalDebug, dbgRejectReason: `SELL blocked: RSI ${rsi.toFixed(1)} <= ${sellRsiBlock}` } };
    }

    // ── Trend momentum filter: requires strong 5m EMA slope ───────────────────
    let weakSlope = false;
    const slopeThreshold = entryType === 'crossover' ? CROSSOVER_SLOPE_THRESHOLD : PULLBACK_SLOPE_THRESHOLD;
    if (action === 'BUY'  && slopePercent < slopeThreshold)  weakSlope = true;
    if (action === 'SELL' && slopePercent > -slopeThreshold) weakSlope = true;

    if (weakSlope) {
      return { signal: null, debug: { ...signalDebug, dbgRejectReason: `weak EMA slope (${action} requires ${action === 'BUY' ? `>= ${slopeThreshold}%` : `<= -${slopeThreshold}%`}, got ${slopePercent.toFixed(4)}%)` } };
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
    let strongBullishCandles = 0;
    let strongBearishCandles = 0;

    if (dbg1mCandlesUsed > 0) {
      netMomentum1m = recent1m.reduce((sum, candle) => {
        if (
          typeof candle.close === 'number' &&
          typeof candle.open === 'number' &&
          typeof candle.high === 'number' &&
          typeof candle.low === 'number'
        ) {
          const candleBody = Math.abs(candle.close - candle.open);
          const strongEnough = candleBody >= atr * STRONG_BODY_MULTIPLIER;
          if (candle.close > candle.open) {
            bullishCandles++;
            if (strongEnough) strongBullishCandles++;
          } else if (candle.close < candle.open) {
            bearishCandles++;
            if (strongEnough) strongBearishCandles++;
          }
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
    const minMomentumThreshold = atr * MOMENTUM_RANGE_MULTIPLIER;
    
    if (action === 'BUY') {
      if (netMomentum1m <= 0) {
        return { signal: null, debug: { ...signalDebug, dbg1mMomentumNet: +netMomentum1m.toFixed(4), dbg1mCandlesUsed, dbgRejectReason: `1m momentum not bullish (net: ${netMomentum1m.toFixed(4)})` } };
      }
      if (netMomentum1m < minMomentumThreshold) {
        return { signal: null, debug: { ...signalDebug, dbg1mMomentumNet: +netMomentum1m.toFixed(4), dbg1mCandlesUsed, dbgRejectReason: `1m momentum too weak (${netMomentum1m.toFixed(4)} < $${minMomentumThreshold})` } };
      }
      if (bullishCandles < 2 && netMomentum1m < minMomentumThreshold * 1.5) {
        return { signal: null, debug: { ...signalDebug, dbg1mMomentumNet: +netMomentum1m.toFixed(4), dbg1mCandlesUsed, dbgRejectReason: `1m direction inconsistent (only ${bullishCandles}/3 candles bullish)` } };
      }
      if (strongBullishCandles < 2) {
        return { signal: null, debug: { ...signalDebug, dbg1mMomentumNet: +netMomentum1m.toFixed(4), dbg1mCandlesUsed, dbgRejectReason: `1m momentum not strong enough (only ${strongBullishCandles}/3 candle bodies >= ${(atr * STRONG_BODY_MULTIPLIER).toFixed(2)})` } };
      }
    }
    
    if (action === 'SELL') {
      if (netMomentum1m >= 0) {
        return { signal: null, debug: { ...signalDebug, dbg1mMomentumNet: +netMomentum1m.toFixed(4), dbg1mCandlesUsed, dbgRejectReason: `1m momentum not bearish (net: ${netMomentum1m.toFixed(4)})` } };
      }
      if (Math.abs(netMomentum1m) < minMomentumThreshold) {
        return { signal: null, debug: { ...signalDebug, dbg1mMomentumNet: +netMomentum1m.toFixed(4), dbg1mCandlesUsed, dbgRejectReason: `1m momentum too weak (${Math.abs(netMomentum1m).toFixed(4)} < $${minMomentumThreshold})` } };
      }
      if (bearishCandles < 2 && Math.abs(netMomentum1m) < minMomentumThreshold * 1.5) {
        return { signal: null, debug: { ...signalDebug, dbg1mMomentumNet: +netMomentum1m.toFixed(4), dbg1mCandlesUsed, dbgRejectReason: `1m direction inconsistent (only ${bearishCandles}/3 candles bearish)` } };
      }
      if (strongBearishCandles < 2) {
        return { signal: null, debug: { ...signalDebug, dbg1mMomentumNet: +netMomentum1m.toFixed(4), dbg1mCandlesUsed, dbgRejectReason: `1m momentum not strong enough (only ${strongBearishCandles}/3 candle bodies >= ${(atr * STRONG_BODY_MULTIPLIER).toFixed(2)})` } };
      }
    }

    // Update debug object with momentum data for the successful signal case
    signalDebug.dbg1mMomentumNet = +netMomentum1m.toFixed(4);
    signalDebug.dbg1mCandlesUsed = dbg1mCandlesUsed;
    signalDebug.dbgStrongBullishCandles = strongBullishCandles;
    signalDebug.dbgStrongBearishCandles = strongBearishCandles;

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
    } else if (entryType === 'pullback' || entryType === 'momentum') {
      if (action === 'BUY'  && slopePercent >= PULLBACK_SLOPE_THRESHOLD)  score += 2;
      if (action === 'SELL' && slopePercent <= -PULLBACK_SLOPE_THRESHOLD) score += 2;
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
    if (dbgEmaSep >= atr * 0.6) score += 1;

    // Penalty: near key S/R levels (high chance of reversal)
    const nearResistance = action === 'BUY'  && (resistance - lastCandle.close) > 0 && (resistance - lastCandle.close) < atr * 0.5;
    const nearSupport    = action === 'SELL' && (lastCandle.close - support) > 0 && (lastCandle.close - support) < atr * 0.5;
    if (nearResistance || nearSupport) score -= 2;

    // Penalty: ranging market / late RSI
    if (dbgEmaSep < atr * 0.45) score -= 2;
    if (Math.abs(slopePercent) < CROSSOVER_SLOPE_THRESHOLD) score -= 1;
    if ((action === 'BUY' && rsi >= 64) || (action === 'SELL' && rsi <= 36)) score -= 1;

    // Penalty: Counter-trend relative to 1h timeframe
    // If buying while 1h trend is DOWN, or selling while 1h trend is UP, -1 point.
    if (action === 'BUY'  && trend1h === 'DOWN') score -= 1;
    if (action === 'SELL' && trend1h === 'UP')   score -= 1;

    // FIX: Minimum score set to 2. This allows "clean" crossovers to execute 
    // while still blocking "noisy" signals that trigger penalties (Ranging/SR/Trend).
    if (score < 2) return { signal: null, debug: { ...signalDebug, dbgScore: score, dbgRejectReason: `score too low (${score}/required 2)` } };

    // ── Build signal object ───────────────────────────────────────────────────
    // FIX: Tightened from 2.0×/3.0× to 1.5×/2.25× ATR.
    // On 5-minute gold candles (ATR ~$2-4), 3× ATR = $6-12 target was rarely hit.
    // 2.25× ATR = $4.5-9 is more reachable while maintaining the 1:1.5 R:R ratio.
    // Note: execution.js recalculates these from the actual execution price.
    const stopLoss = action === 'BUY'
      ? lastCandle.close - (STOP_LOSS_ATR_MULTIPLIER * atr)
      : lastCandle.close + (STOP_LOSS_ATR_MULTIPLIER * atr);

    const takeProfit = action === 'BUY'
      ? lastCandle.close + (TAKE_PROFIT_ATR_MULTIPLIER * atr)
      : lastCandle.close - (TAKE_PROFIT_ATR_MULTIPLIER * atr);

    if (isNaN(stopLoss) || isNaN(takeProfit)) return { signal: null, debug: { ...signalDebug, dbgRejectReason: 'stopLoss or takeProfit is NaN' } };

    const now = Date.now();

    return {
      signal: {
        id:              `${lastCandle.time}_${action}_v1.3`,
        pair:            'GOLD',
        action,
        entryType,
        entryPrice:      lastCandle.close,
        stopLoss,
        takeProfit,
        atr,
        score,
        strategyVersion: 'v1.3',
        timestamp:       now,
      },
      debug: { ...signalDebug, dbgScore: score, dbgRejectReason: null },
    };

  } catch (err) {
    console.error('generateSignal error:', err.message);
    return { signal: null, debug: { dbgRejectReason: `exception: ${err.message}` } };
  }
}
