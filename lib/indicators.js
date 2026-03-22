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

    // ── EMA50 slope (normalized) ──────────────────────────────────────────────
    // Uses 10-candle lookback to measure slope as a % of current price.
    // Normalized so the threshold doesn't need to change as gold price changes.
    // Requires at least 11 elements in ema50arr.
    let slopePercent = 0;
    if (ema50arr.length >= 11) {
      const ema50_10ago = ema50arr[ema50arr.length - 11];
      slopePercent      = (currEMA50 - ema50_10ago) / currEMA50 * 100;
    } else {
      // Fallback: use 2-candle slope if not enough history
      slopePercent = (currEMA50 - prevEMA50) / currEMA50 * 100;
    }

    // ── ATR and ATR average ───────────────────────────────────────────────────
    const currentATR = calcATR(14);

    // ATR average: compute ATR over 50 rolling 15-candle windows for volatility baseline
    const atrValues = [];
    for (let i = 0; i < 50; i++) {
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

    // ── 1h trend direction ────────────────────────────────────────────────────
    // Compares last 1h close to the SMA of all 60 1h candles.
    // UP = price is above average. DOWN = price is below average.
    const closes1h = candles1h.map(c => c.close);
    const sma1h    = closes1h.reduce((a, b) => a + b, 0) / closes1h.length;
    const trend1h  = closes1h[closes1h.length - 1] > sma1h ? 'UP' : 'DOWN';

    // ── RSI ───────────────────────────────────────────────────────────────────
    const currentRSI = calcRSI(14);

    const lastCandle = candles5m[candles5m.length - 1];

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
      resistance,
      support,
      trend1h,
      lastCandle,
    };

    // ── Market condition filters (skip before strategy runs) ─────────────────

    // Sideways market: slope below 0.005% is too flat for reliable EMA signals
    if (Math.abs(slopePercent) < 0.005) {
      return { skip: true, reason: `SKIP: Weak trend - sideways market (slope: ${slopePercent.toFixed(4)}%)`, ...indicatorData };
    }

    // Volatility spike: likely news event — don't trade into it
    if (currentATR > atrAverage * 2.5) {
      return { skip: true, reason: `SKIP: Abnormal volatility - possible news event (ATR ${currentATR.toFixed(2)} vs avg ${atrAverage.toFixed(2)})`, ...indicatorData };
    }

    // ATR range: below 0.5 = frozen market, above 12 = crisis
    if (currentATR < 0.5 || currentATR > 12) {
      return { skip: true, reason: `SKIP: ATR ${currentATR.toFixed(2)} out of normal range (0.5–12)`, ...indicatorData };
    }

    return { skip: false, ...indicatorData };

  } catch (err) {
    console.error('calculateIndicators error:', err.message);
    return { skip: true, reason: `SKIP: Indicator calculation error - ${err.message}` };
  }
}
