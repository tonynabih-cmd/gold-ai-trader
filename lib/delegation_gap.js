function hasTradeIntent(signal) {
  return signal?.action === 'BUY' || signal?.action === 'SELL';
}

export function classifyDelegationGapReason(reason) {
  const value = String(reason || '');
  const lower = value.toLowerCase();

  if (
    value.startsWith('STOP:') ||
    value.startsWith('DISABLE:') ||
    value.startsWith('PAUSE:') ||
    lower.includes('daily loss') ||
    lower.includes('drawdown') ||
    lower.includes('margin') ||
    lower.includes('max 2 positions') ||
    lower.includes('daily trade cap') ||
    lower.includes('risk data')
  ) {
    return 'risk_gate';
  }

  if (
    lower.includes('stale') ||
    lower.includes('duplicate candle') ||
    lower.includes('concurrency') ||
    lower.includes('lock') ||
    lower.includes('missing execution lock') ||
    lower.includes('candle settlement') ||
    lower.includes('market data') ||
    lower.includes('invalid future')
  ) {
    return 'data_guard';
  }

  if (
    lower.includes('spread') ||
    lower.includes('slippage') ||
    lower.includes('market closed') ||
    lower.includes('weekend') ||
    lower.includes('session') ||
    lower.includes('atr') ||
    lower.includes('stop distance too large')
  ) {
    return 'market_condition';
  }

  if (
    value.startsWith('ERROR:') ||
    value.startsWith('REJECTED:') ||
    value.startsWith('CRITICAL_FAILURE') ||
    lower.includes('broker') ||
    lower.includes('order') ||
    lower.includes('fill') ||
    lower.includes('execution')
  ) {
    return 'execution_failure';
  }

  return 'unknown';
}

export function buildDelegationGap({
  signal,
  tradeExecuted,
  reason,
  marketRegime,
  executionPolicy,
  timestamp = Date.now(),
} = {}) {
  if (tradeExecuted === true || !hasTradeIntent(signal)) return null;

  return {
    intendedAction: signal.action,
    blockingReason: reason || null,
    category: classifyDelegationGapReason(reason),
    marketRegime: marketRegime ?? null,
    executionPolicy: executionPolicy ?? null,
    timestamp,
  };
}
