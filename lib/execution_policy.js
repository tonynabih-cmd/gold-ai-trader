const REGIME_RISK_MULTIPLIERS = Object.freeze({
  NORMAL: 1.0,
  ACTIVE: 1.0,
  VOLATILE: 0.5,
  EXTREME: 0.25,
  SIDEWAYS: 0.5,
  DEAD: 0.25,
  SOFT_DEAD: 0.5,
  SOFT_SIDEWAYS: 0.5,
  SOFT_EXTREME: 0.5,
});

function normalizeRegime(marketRegime) {
  const regime = String(marketRegime || '').toUpperCase();
  return Object.prototype.hasOwnProperty.call(REGIME_RISK_MULTIPLIERS, regime) ? regime : null;
}

export function buildExecutionPolicy(originalRiskDecision, marketRegime = null, timestamp = Date.now()) {
  const riskDecision = String(originalRiskDecision || '');
  const normalizedRegime = normalizeRegime(marketRegime);

  if (riskDecision !== 'APPROVED') {
    return {
      decision: 'BLOCK',
      source: 'risk',
      originalRiskDecision: riskDecision,
      reason: riskDecision,
      timestamp,
      marketRegime: normalizedRegime,
      riskMultiplier: null,
    };
  }

  const riskMultiplier = REGIME_RISK_MULTIPLIERS[normalizedRegime] ?? 1.0;
  const decision = riskMultiplier < 1.0 ? 'LIMIT' : 'ALLOW';

  return {
    decision,
    source: 'risk',
    originalRiskDecision: riskDecision,
    reason: decision === 'LIMIT'
      ? `Market regime ${normalizedRegime} risk multiplier ${riskMultiplier}`
      : null,
    timestamp,
    marketRegime: normalizedRegime,
    riskMultiplier,
  };
}
