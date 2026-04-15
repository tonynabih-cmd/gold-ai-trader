// indicators.js — Calculate all technical indicators from candle data.
// Input: candles5m (100 candles), candles1h (60 candles)
// Output: indicator object with skip flag, or indicator data for strategy.js

export function calculateIndicators(candles5m, candles1h) {
  try {
    // ── Input validation ──────────────────────────────────────────────────────
    if (!candles5m || candles5m.length < 100) {
      return { skip: true, reason: `SKIP: Not enough 5m candles (${candles5m?.length ?? 0}/100)` };
    }
    if (!candles1h || candles1h.length < 2) {
      return { skip: true, reason: `SKIP: Not enough 1h candles (${candles1h?.length ?? 0}/2)` };
    }

    const closes = candles5m.map(c => c.close);
    const highs  = candles5m.map(c => c.high);
    const lows   = candles5m.map(c => c.low);

    // ── EMA calculation ───────────────────────────────────────────────────────
    // Standard EMA with multiplier k = 2/(period+1).
    // Seeded with SMA of first `period` values for accuracy.
    // Returns array same length as input; first (period-1) values are null (warmup).
    function emaArray(data, period) {
      if (data.length < period) return [];
      const k   = 2 / (period + 1);
      // Seed with SMA of first `period` values
      let val   = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
      const out = new Array(period - 1).fill(null);
      out.push(val);
      for (let i = period; i < data.length; i++) {
        val = data[i] * k + val * (1 - k);
        out.push(val);
      }
      return out;
    }

    // ── ATR calculation (Wilder's smoothing) ──────────────────────────────────
    // Uses full OHLC with Wilder's exponential smoothing (not SMA).
    // True Range = max(high-low, |high-prevClose|, |low-prevClose|)
    function calcATR(period) {
      const trs = [];
      for (let i = 1; i < candles5m.length; i++) {
        trs.push(Math.max(
          highs[i]  - lows[i],
          Math.abs(highs[i]  - closes[i - 1]),
          Math.abs(lows[i]   - closes[i - 1])
        ));
      }
      if (trs.length < period) return trs.length > 0 ? trs.reduce((a, b) => a + b, 0) / trs.length : 0;
      // Wilder's smoothing: seed with SMA of first `period` TRs, then exponentially smooth
      let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
      for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]) / period;
      }
      return atr;
    }

    // ── RSI calculation (Wilder's smoothing) ──────────────────────────────────
    // Uses Wilder's exponential smoothing for avgGain/avgLoss.
    // Divide-by-zero guards: returns 100 if all gains, 0 if all losses.
    function calcRSI(period) {
      if (closes.length < period + 1) return 50; // not enough data — return neutral
      const diffs = [];
      for (let i = 1; i < closes.length; i++) {
        diffs.push(closes[i] - closes[i - 1]);
      }
      if (diffs.length < period) return 50;
      // Seed avgGain/avgLoss from first `period` diffs
      let avgGain = 0, avgLoss = 0;
      for (let i = 0; i < period; i++) {
        if (diffs[i] > 0)      avgGain += diffs[i];
        else if (diffs[i] < 0) avgLoss += Math.abs(diffs[i]);
      }
      avgGain /= period;
      avgLoss /= period;
      // Wilder's smoothing for remaining diffs
      for (let i = period; i < diffs.length; i++) {
        const gain = diffs[i] > 0 ? diffs[i] : 0;
        const loss = diffs[i] < 0 ? Math.abs(diffs[i]) : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
      }
      if (avgLoss === 0 && avgGain === 0) return 50; // flat market
      if (avgLoss === 0) return 100;                  // all gains, no losses
      if (avgGain === 0) return 0;                    // all losses, no gains
      const rs = avgGain / avgLoss;
      return Math.min(100, Math.max(0, 100 - (100 / (1 + rs))));
    }

    // ── Compute EMA arrays ────────────────────────────────────────────────────
    const ema20arr = emaArray(closes, 20);
    const ema50arr = emaArray(closes, 50);

    if (ema20arr.length < 2 || ema50arr.length < 2) {
      return { skip: true, reason: 'SKIP: EMA arrays too short - not enough candle data' };
    }

    const currEMA20 = ema20arr[ema20arr.length - 1];
    const currEMA50 = ema50arr[ema50arr.length - 1];
    const prevEMA20 = ema20arr[ema20arr.length - 2];
    const prevEMA50 = ema50arr[ema50arr.length - 2];

    // ── EMA20 slope (normalized) ──────────────────────────────────────────────────
    // FIX: Changed from EMA50 to EMA20 for slope calculation.
    // EMA50 is too slow-moving — its slope barely registers short-term trend shifts,
    // allowing pullback entries in weak/dying trends. EMA20 is responsive enough
    // to validate that a real trend is active.
    // Uses 10-candle lookback to measure slope as a % of current price.
    let slopePercent = 0;
    if (ema20arr.length >= 11) {
      const ema20_10ago = ema20arr[ema20arr.length - 11];
      slopePercent      = (currEMA20 - ema20_10ago) / currEMA20 * 100;
    } else {
      // Fallback: use 2-candle slope if not enough history
      slopePercent = (currEMA20 - prevEMA20) / currEMA20 * 100;
    }

    // ── ATR and ATR average ───────────────────────────────────────────────────
    const currentATR = calcATR(14);

    // ATR average: compute ATR over 50 rolling 15-candle windows for volatility baseline.
    // Audit Fix: Previously this sliced from the START of the 1000-candle array (oldest data).
    // Now we slice from the END to use the most recent 100-candle history for a relevant baseline.
    const atrValues = [];
    const recentStart = candles5m.length - 100;
    // FIX: Stride by 5 instead of 1 to reduce overlapping windows.
    // Overlapping windows (stride 1) massively smooth the baseline, making the
    // ATR spike check (ATR > atrAverage * 2.5) nearly impossible to trigger.
    // Stride 5 gives ~17 independent samples from the last 100 candles.
    for (let i = Math.max(0, recentStart); i < candles5m.length - 15; i += 5) {
      const slice = candles5m.slice(i, i + 15);
      if (slice.length < 15) continue;
      const trs = [];
      for (let j = 1; j < slice.length; j++) {
        trs.push(Math.max(
          slice[j].high - slice[j].low,
          Math.abs(slice[j].high - slice[j - 1].close),
          Math.abs(slice[j].low  - slice[j - 1].close)
        ));
      }
      if (trs.length > 0) {
        atrValues.push(trs.reduce((a, b) => a + b, 0) / trs.length);
      }
    }
    const atrAverage = atrValues.length > 0
      ? atrValues.reduce((a, b) => a + b, 0) / atrValues.length
      : currentATR; // fallback: use current ATR if no windows computed

    // ── Support and Resistance (last 50 candles) ──────────────────────────────
    const last50     = candles5m.slice(-50);
    const resistance = Math.max(...last50.map(c => c.high));
    const support    = Math.min(...last50.map(c => c.low));

    // ── 12-bar directional efficiency ─────────────────────────────────────────
    const recent12 = candles5m.slice(-12);
    const highs12 = recent12.map(c => c.high);
    const lows12  = recent12.map(c => c.low);
    const range12 = Math.max(...highs12) - Math.min(...lows12);
    const disp12  = Math.abs(candles5m[candles5m.length - 1].close - candles5m[candles5m.length - 12].close);
    const efficiency12 = range12 === 0 ? 0 : disp12 / range12;

    // ── 1h trend direction ────────────────────────────────────────────────────
    // Computes EMA50 across all 60 1h closes.
    // Stores the last 3 EMA values. UP = slope is positive (emaHistory[2] > emaHistory[0]).
    const closes1h = candles1h.map(c => c.close);
    const ema1h50  = emaArray(closes1h, 50);
    const emaHistory = ema1h50.slice(-3);
    const trend1h  = emaHistory[2] > emaHistory[0] ? 'UP' : 'DOWN';

    // ── RSI ───────────────────────────────────────────────────────────────────
    const currentRSI = calcRSI(14);

    const lastCandle = candles5m[candles5m.length - 1];
    const prevCandle = candles5m[candles5m.length - 2] || null;

    const currentTrendDirection = currEMA20 > currEMA50 ? 'BUY' : currEMA20 < currEMA50 ? 'SELL' : 'FLAT';
    let trendWindowStartTime = null;
    if (currentTrendDirection !== 'FLAT') {
      for (let i = ema20arr.length - 1; i >= 1; i--) {
        const prev20 = ema20arr[i - 1];
        const prev50 = ema50arr[i - 1];
        const curr20 = ema20arr[i];
        const curr50 = ema50arr[i];

        if (![prev20, prev50, curr20, curr50].every(v => typeof v === 'number' && !isNaN(v))) continue;

        const bullishCross = prev20 <= prev50 && curr20 > curr50;
        const bearishCross = prev20 >= prev50 && curr20 < curr50;

        if ((currentTrendDirection === 'BUY' && bullishCross) || (currentTrendDirection === 'SELL' && bearishCross)) {
          trendWindowStartTime = candles5m[i]?.time ?? null;
          break;
        }
      }
    }

    // ── Pack all indicator data ───────────────────────────────────────────────
    const indicatorData = {
      currEMA20,
      currEMA50,
      prevEMA20,
      prevEMA50,
      ema20arr,
      ema50arr,
      slopePercent,
      atr:        currentATR,
      atrAverage,
      rsi:        currentRSI,
      efficiency12,
      resistance,
      support,
      trend1h,
      prevCandle,
      lastCandle,
      trendWindowStartTime,
      currentTrendDirection,
    };

    // ── Market condition filters (skip before strategy runs) ─────────────────
    // NOTE: Strategy architecture is intentionally 2-layer.
    // Indicator calculation only prepares market context; trade gating happens in
    // strategy.js so Layer 1 remains the single place that decides trend + volatility.

    if (typeof currentATR !== 'number' || isNaN(currentATR)) {
      return { skip: true, reason: 'SKIP: ATR missing or invalid (null/undefined)', ...indicatorData };
    }

    if (typeof atrAverage !== 'number' || isNaN(atrAverage)) {
      return { skip: true, reason: 'SKIP: ATR baseline missing - cannot verify spike protection', ...indicatorData };
    }

    // Telemetry: print final verified indicator state as requested
    console.log(`EMA/ATR CHECK: EMA20=${currEMA20.toFixed(2)}, EMA50=${currEMA50.toFixed(2)}, ATR=${currentATR.toFixed(2)}`);

    return { skip: false, ...indicatorData };

  } catch (err) {
    console.error('calculateIndicators error:', err.message);
    return { skip: true, reason: `SKIP: Indicator calculation error - ${err.message}` };
  }
}
