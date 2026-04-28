function finiteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function classifyMarketRegime(indicators = {}) {
  const atr = finiteNumber(indicators?.atr);
  if (atr === null || atr <= 0) return null;

  const atrAverage = finiteNumber(indicators?.atrAverage);
  const ema20 = finiteNumber(indicators?.currEMA20 ?? indicators?.ema20);
  const ema50 = finiteNumber(indicators?.currEMA50 ?? indicators?.ema50);
  const spread = finiteNumber(indicators?.spread);
  const trend1h = String(indicators?.trend1h || '').toUpperCase();

  const atrRatio = atrAverage && atrAverage > 0 ? atr / atrAverage : 1;
  const emaSeparationAtr = ema20 !== null && ema50 !== null ? Math.abs(ema20 - ema50) / atr : null;
  const spreadAtr = spread !== null ? spread / atr : 0;

  // Conservative telemetry-only thresholds:
  // - DEAD mirrors the strategy's existing low-ATR floor and weak relative ATR.
  // - EXTREME/VOLATILE flag expansion or costly spread pressure, but do not gate trades.
  // - SIDEWAYS labels unresolved/flat trend or very tight EMA separation.
  if (atr < 0.50 || atrRatio < 0.55) return 'DEAD';
  if (atrRatio >= 2.50 || spreadAtr >= 0.60) return 'EXTREME';
  if (atrRatio >= 1.60 || spreadAtr >= 0.40) return 'VOLATILE';
  if (trend1h === 'N/A' || !trend1h || emaSeparationAtr !== null && emaSeparationAtr < 0.08) return 'SIDEWAYS';

  return 'NORMAL';
}
