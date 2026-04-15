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
      lastOrderTimestamp,
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

    const now = new Date();
    const utcHour = now.getUTCHours();
    
    // European Session: 07:00 - 15:59 UTC
    const isEuropeanSession = utcHour >= 7 && utcHour < 16;

    const CROSSOVER_SLOPE_THRESHOLD = 0.05; 
    const IMMEDIATE_CROSSOVER_SLOPE = 0.20; // 0.20% slope allows skip of 1-candle confirmation
    const TAKE_PROFIT_ATR_MULTIPLIER = 2.5; // v1.5: was 3.0 — achievable TP (1.67:1 R:R)
    const STOP_LOSS_ATR_MULTIPLIER = 1.5;    // v1.5: was 1.2 — wider SL absorbs slippage
    const MOMENTUM_RANGE_MULTIPLIER = 0.06;
    const STRONG_BODY_MULTIPLIER = 0.08;

    const DEBUG_STRATEGY = process.env.DEBUG_STRATEGY === 'true';

    // ── Relaxed Conditions: if no trades in 48h ──────────────────────────────
    const hoursSinceLastTrade = (Date.now() - (lastOrderTimestamp || 0)) / (1000 * 60 * 60);
    const isRelaxedMode = hoursSinceLastTrade > 48;
    
    if (isRelaxedMode) {
        console.warn(`[STRATEGY] Relaxed mode active (${hoursSinceLastTrade.toFixed(1)}h since last trade)`);
    }

    // BALANCED WIN-RATE UPGRADE: Standards lowered to 0.06% (Euro) / 0.08% (US) for better frequency.
    const PULLBACK_SLOPE_THRESHOLD = isEuropeanSession ? 0.06 : 0.08;

    // Dynamic ATR-based pullback distance (v1.4)
    // Tighter in low volatility, wider in high volatility.
    const ATR_PULLBACK_MULTIPLIER = isRelaxedMode ? 1.0 : 0.75;
    const pullbackDistanceThreshold = atr * ATR_PULLBACK_MULTIPLIER;

    const momRangeMult = isRelaxedMode ? 0.03 : 0.04;
    const minMomentumThreshold = atr * momRangeMult;

    const breakoutMomentumThreshold = atr * 0.15;
    const BREAKOUT_SLOPE_THRESHOLD = 0.15;

    // ── Calculate 1m Momentum early (needed for both pullback validation and breakout detection)
    const recent1m = candles1m.slice(-3);
    const candlesUsed1m = recent1m.length;
    let netMomentum1m = 0;
    let bullishCandles = 0;
    let bearishCandles = 0;
    let strongBullishCandles = 0;
    let strongBearishCandles = 0;

    if (candlesUsed1m > 0) {
      netMomentum1m = recent1m.reduce((sum, candle) => {
        if (typeof candle.close === 'number' && typeof candle.open === 'number') {
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
    }

    // ── Debug snapshot (all intermediate values — for logging only) ───────────
    let action    = null;
    let entryType = null;
    let riskMultiplier = 1.0;

    const len        = (ema20arr && ema20arr.length >= 2) ? ema20arr.length : 0;
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
    if (!action && dbgCrossoverAgeBars === 0 && (dbgBuyCrossover || dbgSellCrossover)) {
      dbgPullbackChecked = true;
      dbgPullbackReason = `crossover ${dbgBuyCrossover ? 'BUY' : 'SELL'}: waiting 1 candle for confirmation`;
    } else if (!action) {
      dbgPullbackChecked = true;
      const emaSeparation    = dbgEmaSep;
      const trendThreshold = isRelaxedMode ? 0.20 : 0.35;
      const trendEstablished = emaSeparation > atr * trendThreshold;
      const distanceToEMA20  = dbgDistToEMA20;
      const touchedEMA20     = distanceToEMA20 < pullbackDistanceThreshold;
      const crossoverLookback = isRelaxedMode ? 36 : 12; // 3 hours (36*5m) in relaxed mode, 1 hour (12*5m) normally.
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

      const recentCrossover = dbgCrossoverAgeBars === 1;
      const isStrongTrend = Math.abs(slopePercent) >= PULLBACK_SLOPE_THRESHOLD;
      const momentumEntryAllowed = recentCrossover && isStrongTrend;

      if (!trendEstablished && !momentumEntryAllowed) {
        dbgPullbackReason = `pullback: trend not established (EMA sep ${emaSeparation.toFixed(2)} <= ATR*${trendThreshold} ${(atr * trendThreshold).toFixed(2)})`;
      } else if (!touchedEMA20 && !momentumEntryAllowed) {
        // Breakout Entry Condition: No pullback but strong momentum spike in verified trend
        const isUltraStrongTrend = Math.abs(slopePercent) >= BREAKOUT_SLOPE_THRESHOLD;
        const trendDirection = slopePercent > 0 ? 'BUY' : 'SELL';
        const minStrongCat = isRelaxedMode ? 1 : 2;
        const hasBreakoutMomentum = trendDirection === 'BUY'
            ? (netMomentum1m >= breakoutMomentumThreshold && strongBullishCandles >= minStrongCat)
            : (netMomentum1m <= -breakoutMomentumThreshold && strongBearishCandles >= minStrongCat);

        if (trendEstablished && isUltraStrongTrend && hasBreakoutMomentum) {
            action = trendDirection;
            entryType = 'breakout';
            riskMultiplier = 0.5; // Keep risk small for breakout trades
        } else {
            dbgPullbackReason = `pullback: price not close enough to EMA20 (dist ${distanceToEMA20.toFixed(2)}, threshold ${pullbackDistanceThreshold.toFixed(2)})`;
        }
      } else {
        const inUptrend   = currEMA20 > currEMA50;
        const inDowntrend = currEMA20 < currEMA50;
        const candleTolerance = atr * 0.1; // allow slightly adverse candles below this margin

        if (inUptrend) {
          dbgRecentTrendCross = recentBullishCross ? 'BUY' : null;
          if (!recentBullishCross && !momentumEntryAllowed && !isRelaxedMode) {
            dbgPullbackReason = 'pullback BUY: no recent EMA20/EMA50 bullish crossover confirmation';
          } else if (slopePercent < PULLBACK_SLOPE_THRESHOLD) {
            dbgPullbackReason = `pullback BUY: weak EMA slope (got ${slopePercent.toFixed(4)}%, need >= ${PULLBACK_SLOPE_THRESHOLD}%)`;
          } else if (lastCandle.close <= lastCandle.open - candleTolerance && !momentumEntryAllowed) {
            dbgSetupReady     = true;
            dbgPullbackReason = 'pullback BUY: candle not bullish (close <= open - margin)';
          } else if (lastCandle.close <= currEMA20 && !momentumEntryAllowed) {
            dbgPullbackReason = 'pullback BUY: price closed below EMA20';
          } else {
            action = 'BUY'; 
            entryType = momentumEntryAllowed ? 'momentum' : 'pullback';
          }
        } else if (inDowntrend) {
          dbgRecentTrendCross = recentBearishCross ? 'SELL' : null;
          if (!recentBearishCross && !momentumEntryAllowed && !isRelaxedMode) {
            dbgPullbackReason = 'pullback SELL: no recent EMA20/EMA50 bearish crossover confirmation';
          } else if (slopePercent > -PULLBACK_SLOPE_THRESHOLD) {
            dbgPullbackReason = `pullback SELL: weak EMA slope (got ${slopePercent.toFixed(4)}%, need <= -${PULLBACK_SLOPE_THRESHOLD}%)`;
          } else if (lastCandle.close >= lastCandle.open + candleTolerance && !momentumEntryAllowed) {
            dbgSetupReady     = true;
            dbgPullbackReason = 'pullback SELL: candle not bearish (close >= open + margin)';
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

    const signalDebug = {
      dbgCurrE20:          +dbgCurrE20?.toFixed(4),
      dbgCurrE50:          +dbgCurrE50?.toFixed(4),
      dbgPrevE20:          +dbgPrevE20?.toFixed(4),
      dbgPrevE50:          +dbgPrevE50?.toFixed(4),
      dbgEmaSeparation:    +dbgEmaSep?.toFixed(4),
      dbgDistToEMA20:      +dbgDistToEMA20?.toFixed(4),
      dbgPullbackThreshold: +pullbackDistanceThreshold.toFixed(4),
      dbgAtr:              +atr.toFixed(4),
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
      isRelaxedMode,
      hoursSinceLastTrade,
      dbgMarketConditions: {
          isEuropeanSession,
          emaSlope: slopePercent,
          rsi,
          atr,
          atrAverage,
          trend1h,
          spread: indicators.spread
      }
    };

    if (DEBUG_STRATEGY) {
        console.log(`[STRATEGY_DEBUG] Cycle: ${new Date().toISOString()}`);
        console.log(`[STRATEGY_DEBUG] Price: ${lastCandle.close} | EMA20: ${currEMA20.toFixed(2)} | EMA50: ${currEMA50.toFixed(2)}`);
        console.log(`[STRATEGY_DEBUG] ATR: ${atr.toFixed(2)} | Threshold: ${pullbackDistanceThreshold.toFixed(2)} (Mult: ${isRelaxedMode ? 0.85 : 0.65})`);
        console.log(`[STRATEGY_DEBUG] Dist to EMA20: ${dbgDistToEMA20.toFixed(2)} | Touched: ${dbgDistToEMA20 < pullbackDistanceThreshold}`);
        console.log(`[STRATEGY_DEBUG] Slope: ${slopePercent.toFixed(4)}% | RSI: ${rsi.toFixed(1)}`);
        if (action) {
            console.log(`[STRATEGY_DEBUG] SIGNAL DETECTED: ${action} via ${entryType}`);
        } else {
            console.log(`[STRATEGY_DEBUG] REJECTED: ${dbgPullbackReason ?? 'no setup'}`);
        }
    }

    if (!action) return { signal: null, debug: { ...signalDebug, dbgRejectReason: dbgPullbackReason ?? 'no crossover and no pullback signal' } };

    if (entryType === 'crossover' && dbgCrossoverAgeBars === 0) {
      const isUltraStrongSlope = action === 'BUY' 
        ? slopePercent >= IMMEDIATE_CROSSOVER_SLOPE
        : slopePercent <= -IMMEDIATE_CROSSOVER_SLOPE;

      if (!isUltraStrongSlope) {
        return { signal: null, debug: { ...signalDebug, dbgRejectReason: `crossover ${action}: waiting 1 candle for confirmation (slope ${slopePercent.toFixed(4)}% < ${IMMEDIATE_CROSSOVER_SLOPE}%)` } };
      }
    }

    // RSI directional blocks: prevent buying into overbought and selling into oversold conditions.
    // sellRsiBlock is set above 30 so near-oversold SELL entries (e.g. RSI=32) are blocked —
    // entering a SELL when the market is already approaching oversold risks an immediate reversal.
    const buyRsiBlock = 72;
    const sellRsiBlock = 33;
    if (action === 'BUY' && rsi >= buyRsiBlock) {
      return { signal: null, debug: { ...signalDebug, dbgRejectReason: `BUY blocked: RSI ${rsi.toFixed(1)} >= ${buyRsiBlock} (Balanced Filter)` } };
    }
    if (action === 'SELL' && rsi <= sellRsiBlock) {
      return { signal: null, debug: { ...signalDebug, dbgRejectReason: `SELL blocked: RSI ${rsi.toFixed(1)} <= ${sellRsiBlock} (Balanced Filter)` } };
    }

    let weakSlope = false;
    const slopeThreshold = entryType === 'crossover' ? CROSSOVER_SLOPE_THRESHOLD : PULLBACK_SLOPE_THRESHOLD;
    if (action === 'BUY'  && slopePercent < slopeThreshold)  weakSlope = true;
    if (action === 'SELL' && slopePercent > -slopeThreshold) weakSlope = true;

    if (weakSlope) {
      return { signal: null, debug: { ...signalDebug, dbgRejectReason: `weak EMA slope (${action} requires ${action === 'BUY' ? `>= ${slopeThreshold}%` : `<= -${slopeThreshold}%`}, got ${slopePercent.toFixed(4)}%)` } };
    }

    signalDebug.dbg1mMomentumNet = +netMomentum1m.toFixed(4);
    signalDebug.dbg1mCandlesUsed = candlesUsed1m;
    signalDebug.dbgStrongBullishCandles = strongBullishCandles;
    signalDebug.dbgStrongBearishCandles = strongBearishCandles;

    if (entryType === 'pullback' || entryType === 'momentum' || entryType === 'crossover') {
        if (action === 'BUY') {
          if (netMomentum1m <= 0) {
            return { signal: null, debug: { ...signalDebug, dbgRejectReason: `1m momentum not bullish (net: ${netMomentum1m.toFixed(4)})` } };
          }
          if (netMomentum1m < minMomentumThreshold) {
            return { signal: null, debug: { ...signalDebug, dbgRejectReason: `1m momentum too weak (${netMomentum1m.toFixed(4)} < $${minMomentumThreshold.toFixed(4)})` } };
          }
          if (bullishCandles < 2 && netMomentum1m < minMomentumThreshold * 1.5) {
            return { signal: null, debug: { ...signalDebug, dbgRejectReason: `1m direction inconsistent (only ${bullishCandles}/3 candles bullish)` } };
          }
          const minStrongBullish = 1;
          if (strongBullishCandles < minStrongBullish) {
            return { signal: null, debug: { ...signalDebug, dbgRejectReason: `1m momentum not strong enough (only ${strongBullishCandles}/3 candle bodies >= ${(atr * STRONG_BODY_MULTIPLIER).toFixed(2)})` } };
          }
        }
        
        if (action === 'SELL') {
          if (netMomentum1m >= 0) {
            return { signal: null, debug: { ...signalDebug, dbgRejectReason: `1m momentum not bearish (net: ${netMomentum1m.toFixed(4)})` } };
          }
          if (Math.abs(netMomentum1m) < minMomentumThreshold) {
            return { signal: null, debug: { ...signalDebug, dbgRejectReason: `1m momentum too weak (${Math.abs(netMomentum1m).toFixed(4)} < $${minMomentumThreshold.toFixed(4)})` } };
          }
          if (bearishCandles < 2 && Math.abs(netMomentum1m) < minMomentumThreshold * 1.5) {
            return { signal: null, debug: { ...signalDebug, dbgRejectReason: `1m direction inconsistent (only ${bearishCandles}/3 candles bearish)` } };
          }
          const minStrongBearish = 1;
          if (strongBearishCandles < minStrongBearish) {
            return { signal: null, debug: { ...signalDebug, dbgRejectReason: `1m momentum not strong enough (only ${strongBearishCandles}/3 candle bodies >= ${(atr * STRONG_BODY_MULTIPLIER).toFixed(2)})` } };
          }
        }
    }

    signalDebug.dbg1mMomentumNet = +netMomentum1m.toFixed(4);
    signalDebug.dbg1mCandlesUsed = candlesUsed1m;
    signalDebug.dbgStrongBullishCandles = strongBullishCandles;
    signalDebug.dbgStrongBearishCandles = strongBearishCandles;

    if (entryType === 'crossover') {
      if (action === 'BUY'  && lastCandle.close <= currEMA20) return { signal: null, debug: { ...signalDebug, dbgRejectReason: 'crossover BUY: price not above EMA20' } };
      if (action === 'SELL' && lastCandle.close >= currEMA20) return { signal: null, debug: { ...signalDebug, dbgRejectReason: 'crossover SELL: price not below EMA20' } };
    }

    let score = 0;
    if (entryType === 'crossover') {
      score += 2;
    } else if (entryType === 'pullback' || entryType === 'momentum' || entryType === 'breakout') {
      if (action === 'BUY'  && slopePercent >= PULLBACK_SLOPE_THRESHOLD)  score += 2;
      if (action === 'SELL' && slopePercent <= -PULLBACK_SLOPE_THRESHOLD) score += 2;
    }
    if (atr > 2) score += 1;
    if (action === 'BUY'  && lastCandle.close > lastCandle.open) score += 1;
    if (action === 'SELL' && lastCandle.close < lastCandle.open) score += 1;
    if (action === 'BUY'  && slopePercent > 0) score += 1;
    if (action === 'SELL' && slopePercent < 0) score += 1;
    if (entryType === 'pullback') score += 1;
    if (dbgEmaSep >= atr * 0.6) score += 1;

    const nearResistance = action === 'BUY'  && (resistance - lastCandle.close) > 0 && (resistance - lastCandle.close) < atr * 0.5;
    const nearSupport    = action === 'SELL' && (lastCandle.close - support) > 0 && (lastCandle.close - support) < atr * 0.5;
    if (nearResistance || nearSupport) {
      const isStrong = dbgEmaSep >= atr * 0.6;
      score -= isStrong ? 1 : 2;
    }
    const penaltySepThreshold = isRelaxedMode ? 0.25 : 0.45;
    if (dbgEmaSep < atr * penaltySepThreshold) score -= 2;
    if (Math.abs(slopePercent) < CROSSOVER_SLOPE_THRESHOLD) score -= 1;
    if ((action === 'BUY' && rsi >= 64) || (action === 'SELL' && rsi <= 36)) score -= 1;
    // ELITE WIN RATE UPGRADE: Hard-block against 1h trend.
    if (action === 'BUY'  && trend1h === 'DOWN') {
      return { signal: null, debug: { ...signalDebug, dbgRejectReason: `ELITE BLOCK: Cannot BUY against 1h DOWN trend` } };
    }
    if (action === 'SELL' && trend1h === 'UP') {
      return { signal: null, debug: { ...signalDebug, dbgRejectReason: `ELITE BLOCK: Cannot SELL against 1h UP trend` } };
    }

    if (score < 2) return { signal: null, debug: { ...signalDebug, dbgScore: score, dbgRejectReason: `score too low (${score}/required 2)` } };

    const stopLoss = action === 'BUY'
      ? lastCandle.close - (STOP_LOSS_ATR_MULTIPLIER * atr)
      : lastCandle.close + (STOP_LOSS_ATR_MULTIPLIER * atr);
    const takeProfit = action === 'BUY'
      ? lastCandle.close + (TAKE_PROFIT_ATR_MULTIPLIER * atr)
      : lastCandle.close - (TAKE_PROFIT_ATR_MULTIPLIER * atr);

    if (isNaN(stopLoss) || isNaN(takeProfit)) return { signal: null, debug: { ...signalDebug, dbgRejectReason: 'stopLoss or takeProfit is NaN' } };

    return {
      signal: {
        id:              `${lastCandle.time}_${action}_v1.5`,
        pair:            'GOLD',
        action,
        entryType,
        entryPrice:      lastCandle.close,
        stopLoss,
        takeProfit,
        atr,
        score,
        riskMultiplier,
        isRelaxedMode,
        hoursSinceLastTrade,
        strategyVersion: 'v1.5',
        timestamp:       Date.now(),
      },
      debug: { ...signalDebug, dbgScore: score, dbgRejectReason: null },
    };
  } catch (err) {
    console.error('generateSignal error:', err.message);
    return { signal: null, debug: { dbgRejectReason: `exception: ${err.message}` } };
  }
}
