const ALLOWED_REGIMES = new Set(['NORMAL', 'ACTIVE']);
const BLOCKED_REGIMES = new Set(['DEAD', 'SIDEWAYS', 'EXTREME']);

function finiteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function roundMetric(value) {
  const num = finiteNumber(value);
  return num === null ? null : Number(num.toFixed(4));
}

export function classifyMarketRegimeDetails(indicators = {}, options = {}) {
  const marketClosedReason = typeof options.marketClosedReason === 'string' ? options.marketClosedReason : '';
  if (marketClosedReason.includes('MARKET_CLOSED') || marketClosedReason.toLowerCase().includes('weekend close')) {
    return {
      regime: null,
      atrRatio: null,
      emaSpreadAtr: null,
      isAllowedRegime: false,
      regimeRejectReason: null,
    };
  }

  const atr = finiteNumber(indicators?.atr ?? indicators?.atr14_5m);
  if (atr === null || atr <= 0) {
    return {
      regime: null,
      atrRatio: null,
      emaSpreadAtr: null,
      isAllowedRegime: false,
      regimeRejectReason: 'SKIP: Market regime unavailable - invalid ATR',
    };
  }

  const atrAverage = finiteNumber(indicators?.atrAverage ?? indicators?.atr14Sma100_5m);
  const ema20 = finiteNumber(indicators?.currEMA20 ?? indicators?.ema20 ?? indicators?.ema20_5m);
  const ema50 = finiteNumber(indicators?.currEMA50 ?? indicators?.ema50 ?? indicators?.ema50_5m);

  const atrRatio = atrAverage !== null && atrAverage > 0 ? atr / atrAverage : null;
  const emaSpreadAtr = ema20 !== null && ema50 !== null ? Math.abs(ema20 - ema50) / atr : null;

  let regime;
  if (atr < 0.60 || atrRatio !== null && atrRatio < 0.70) {
    regime = 'DEAD';
  } else if (atrRatio !== null && atrRatio > 2.20) {
    regime = 'EXTREME';
  } else if (emaSpreadAtr !== null && emaSpreadAtr < 0.18) {
    regime = 'SIDEWAYS';
  } else if (atrRatio !== null && atrRatio >= 1.20 && atrRatio <= 2.20) {
    regime = 'ACTIVE';
  } else {
    regime = 'NORMAL';
  }

  const isAllowedRegime = ALLOWED_REGIMES.has(regime);
  return {
    regime,
    atrRatio: roundMetric(atrRatio),
    emaSpreadAtr: roundMetric(emaSpreadAtr),
    isAllowedRegime,
    regimeRejectReason: BLOCKED_REGIMES.has(regime)
      ? `SKIP: Market regime ${regime} blocks new entries`
      : null,
  };
}

export function classifyMarketRegime(indicators = {}, options = {}) {
  return classifyMarketRegimeDetails(indicators, options).regime;
}

export function isAllowedMarketRegime(regime) {
  return ALLOWED_REGIMES.has(String(regime || '').toUpperCase());
}
