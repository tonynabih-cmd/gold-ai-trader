// risk.js — 21-rule safety gate. Every rule is checked before ANY trade is placed.
// Returns 'APPROVED' only when ALL rules pass. Any other return = no trade.

import { classifyTradingSession } from './session_filter.js';
import { classifyMarketRegimeDetails } from './market_regime.js';

export function calculateDrawdown(peakBalance, equityOrBalance) {
  const peak = parseFloat(peakBalance) || 0;
  const equity = parseFloat(equityOrBalance) || 0;
  if (peak <= 0) return 0;
  return ((peak - equity) / peak) * 100;
}

const GOLD_MARGIN_RATE = 0.05;
const MARGIN_BUFFER = 1.5;
const GOLD_MIN_SIZE = 0.01;
const GOLD_MAX_SIZE = 1.0;
const USD_AED_PEG = 3.6725;
const CANDLE_MS = 5 * 60 * 1000;
const SAME_DIRECTION_STOP_COOLDOWN_CANDLES = 3;
const PULLBACK_EXTENSION_ATR_CAP = 1.25;
const ROLLING_PF_WARNING_WINDOW = 5;
const ROLLING_PF_HARD_WINDOW = 10;
export const PF5_KILL_THRESHOLD = 0.7;
const ROLLING_PF_HARD_THRESHOLD = 0.75;
const RECOVERY_EXPECTANCY_THRESHOLD_R = -0.35;
const EXPECTANCY_KILL_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const EXPECTANCY_KILL_POLICY = 'PF5_0.70_24H_EXPIRY';
export const MIN_RR_V2 = 1.8;
export const SETUP_CONFIDENCE_MIN_V2 = 55;
export const HIGH_QUALITY_OVERRIDE_SCORE_THRESHOLD = 70;
export const HIGH_QUALITY_OVERRIDE_RR_THRESHOLD = 1.8;
const MIN_REWARD_R_MULTIPLE = MIN_RR_V2;
const MIN_SETUP_CONFIDENCE_SCORE = SETUP_CONFIDENCE_MIN_V2;
const MAX_DAILY_TRADES = 10;
const ORDER_RATE_WINDOW_MS = 60 * 1000;
const MAX_OPENING_ORDERS_PER_WINDOW = 2;

function normalizeDirection(direction) {
  const value = String(direction || '').toUpperCase();
  return value === 'BUY' || value === 'SELL' ? value : null;
}

function trendForAction(action) {
  if (action === 'BUY') return 'UP';
  if (action === 'SELL') return 'DOWN';
  return null;
}

function oppositeTrendForAction(action) {
  if (action === 'BUY') return 'DOWN';
  if (action === 'SELL') return 'UP';
  return null;
}

function normalizeTrend(trend) {
  const value = String(trend || '').toUpperCase();
  return value === 'UP' || value === 'DOWN' ? value : null;
}

function isStopLossOutcome(outcome) {
  if (!outcome || typeof outcome.pnl !== 'number') return false;
  if (outcome.exitReason === 'STOP_LOSS') return true;
  return outcome.pnl < -0.001;
}

function getSignalCandleTime(signal) {
  const fromId = Number(String(signal?.id || '').split('_')[0]);
  if (Number.isFinite(fromId) && fromId > 0) return fromId;
  const fromTimestamp = Number(signal?.timestamp);
  return Number.isFinite(fromTimestamp) && fromTimestamp > 0 ? fromTimestamp : Date.now();
}

function calculateProfitFactor(outcomes) {
  const grossProfit = outcomes
    .filter(o => typeof o?.pnl === 'number' && o.pnl > 0)
    .reduce((sum, o) => sum + o.pnl, 0);
  const grossLoss = Math.abs(outcomes
    .filter(o => typeof o?.pnl === 'number' && o.pnl < 0)
    .reduce((sum, o) => sum + o.pnl, 0));

  if (grossLoss === 0) return grossProfit > 0 ? 999 : 0;
  return grossProfit / grossLoss;
}

function calculateWindowExpectancyR(outcomes) {
  const values = outcomes
    .map(o => Number(o?.exitAudit?.realizedR ?? o?.audit?.realizedR ?? o?.realizedR))
    .filter(value => Number.isFinite(value));
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function countFullStops(outcomes) {
  return outcomes.filter(o => {
    const realizedR = Number(o?.exitAudit?.realizedR ?? o?.audit?.realizedR ?? o?.realizedR);
    return isStopLossOutcome(o) || (Number.isFinite(realizedR) && realizedR <= -0.75);
  }).length;
}

function countConsecutiveNonLosses(outcomes) {
  let count = 0;
  for (let i = outcomes.length - 1; i >= 0; i--) {
    const pnl = Number(outcomes[i]?.pnl);
    if (!Number.isFinite(pnl) || pnl < -0.001) break;
    count++;
  }
  return count;
}

function ensureDirectionalCircuitState(botState) {
  if (!botState.directionalLossCircuit || typeof botState.directionalLossCircuit !== 'object') {
    botState.directionalLossCircuit = {};
  }
  for (const action of ['BUY', 'SELL']) {
    if (!botState.directionalLossCircuit[action] || typeof botState.directionalLossCircuit[action] !== 'object') {
      botState.directionalLossCircuit[action] = { active: false, activatedAt: 0, resetTrend: trendForAction(action) };
    }
  }
  return botState.directionalLossCircuit;
}

function ensureExpectancyKillState(botState) {
  if (!botState.expectancyKillSwitch || typeof botState.expectancyKillSwitch !== 'object') {
    botState.expectancyKillSwitch = {
      active: false,
      activatedAt: 0,
      activationTrend: null,
      windowKey: null,
      suppressedWindowKey: null,
    };
  }
  if (botState.expectancyKillSwitch.mode == null) {
    botState.expectancyKillSwitch.mode = botState.expectancyKillSwitch.active ? 'RECOVERY' : null;
  }
  return botState.expectancyKillSwitch;
}

function getRecentOutcomes(botState) {
  return Array.isArray(botState?.recentOutcomes)
    ? botState.recentOutcomes.filter(o => o && typeof o.pnl === 'number')
    : [];
}

function getRecentOrderTimestamps(botState, nowMs = Date.now()) {
  const cutoff = nowMs - ORDER_RATE_WINDOW_MS;
  const timestamps = Array.isArray(botState?.recentOrderTimestamps)
    ? botState.recentOrderTimestamps
        .map(ts => Number(ts))
        .filter(ts => Number.isFinite(ts) && ts > cutoff)
    : [];

  if (botState && typeof botState === 'object') {
    botState.recentOrderTimestamps = timestamps;
  }

  return timestamps;
}

function hasTwoConsecutiveSameDirectionStopLosses(outcomes, action) {
  const sameDirection = outcomes
    .filter(o => normalizeDirection(o.action) === action)
    .slice(-2);
  return sameDirection.length === 2 && sameDirection.every(isStopLossOutcome);
}

function buildOutcomeWindowKey(outcomes) {
  return outcomes.map(o => o.dealId || o.ref || `${o.action}:${o.closedAt}:${o.pnl}`).join('|');
}

function getInitialRewardRisk(signal) {
  const entry = Number(signal?.entryPrice);
  const stopLoss = Number(signal?.stopLoss);
  const takeProfit = Number(signal?.takeProfit);
  if (!Number.isFinite(entry) || !Number.isFinite(stopLoss) || !Number.isFinite(takeProfit)) return null;
  const riskDistance = Math.abs(entry - stopLoss);
  const rewardDistance = Math.abs(takeProfit - entry);
  if (!Number.isFinite(riskDistance) || riskDistance <= 0 || !Number.isFinite(rewardDistance)) return null;
  return rewardDistance / riskDistance;
}

function getSetupConfidenceScore(signal) {
  const explicit = Number(signal?.setupConfidenceScore ?? signal?.setupConfidence?.score);
  if (Number.isFinite(explicit)) return explicit;

  const legacyScore = Number(signal?.score);
  if (!Number.isFinite(legacyScore)) return null;
  return legacyScore <= 10 ? legacyScore * 10 : legacyScore;
}

function formatRewardRiskForGate(initialRewardRisk) {
  if (initialRewardRisk === null) return 'unknown';
  return `${initialRewardRisk.toFixed(4)} (raw ${initialRewardRisk})`;
}

function isDailyLossStopActive(botState) {
  const dailyLoss = parseFloat(botState?.dailyLoss);
  const balance = parseFloat(botState?.balance);
  const dailyLossLimitPct = 0.05;
  return balance > 0 && dailyLoss >= balance * dailyLossLimitPct;
}

function isEquityDrawdownHardStopActive(botState) {
  const equity = parseFloat(botState?.equity || botState?.balance);
  const peak = parseFloat(botState?.peakBalance);
  return peak > 0 && calculateDrawdown(peak, equity) >= 20;
}

function defaultHighQualityOverrideTelemetry(reason = 'NOT_EVALUATED') {
  return {
    highQualityOverride: false,
    highQualityOverrideReason: reason,
    overrideScoreThreshold: HIGH_QUALITY_OVERRIDE_SCORE_THRESHOLD,
    overrideRrThreshold: HIGH_QUALITY_OVERRIDE_RR_THRESHOLD,
  };
}

function applyHighQualityOverrideTelemetry(signal, telemetry) {
  if (!signal || typeof signal !== 'object') return;
  signal.highQualityOverride = telemetry.highQualityOverride;
  signal.highQualityOverrideReason = telemetry.highQualityOverrideReason;
  signal.overrideScoreThreshold = telemetry.overrideScoreThreshold;
  signal.overrideRrThreshold = telemetry.overrideRrThreshold;
  if (signal.setupQuality && typeof signal.setupQuality === 'object') {
    signal.setupQuality = {
      ...signal.setupQuality,
      ...telemetry,
    };
  }
}

function assessHighQualityOverride({
  setupQuality,
  botState,
  indicators,
  session,
  regime,
  spreadLimit,
}) {
  const reasons = [];
  const setupConfidenceScore = setupQuality?.setupConfidenceScore;
  const initialRewardRisk = setupQuality?.initialRewardRisk;
  const riskSyncAgeMs = Date.now() - (parseInt(botState?.lastRiskSyncAt) || 0);
  const spread = indicators?.spread;

  if (!(setupConfidenceScore !== null && setupConfidenceScore >= HIGH_QUALITY_OVERRIDE_SCORE_THRESHOLD)) {
    reasons.push('SCORE_BELOW_70');
  }
  if (!(initialRewardRisk !== null && initialRewardRisk >= HIGH_QUALITY_OVERRIDE_RR_THRESHOLD)) {
    reasons.push('RR_BELOW_OVERRIDE');
  }
  if (!session?.isAllowedSession) {
    reasons.push('SESSION_FILTER_BLOCKED');
  }
  if (!(botState?.riskDataFresh === true && riskSyncAgeMs <= 6 * 60 * 1000)) {
    reasons.push('DATA_FRESHNESS_BLOCKED');
  }
  if (!(Number.isFinite(spread) && spread <= spreadLimit)) {
    reasons.push('SPREAD_FILTER_BLOCKED');
  }
  if (!regime?.isAllowedRegime) {
    reasons.push('ATR_REGIME_FILTER_BLOCKED');
  }
  if (
    process.env.BOT_ENABLED !== 'true' ||
    botState?.botEnabled === false ||
    botState?.criticalFailure === true ||
    isEquityDrawdownHardStopActive(botState)
  ) {
    reasons.push('KILL_SWITCH_HARD_STOP_ACTIVE');
  }
  if (isDailyLossStopActive(botState)) {
    reasons.push('DAILY_LOSS_STOP_ACTIVE');
  }
  if (botState?.stateIntegrityOk !== true) {
    reasons.push('STATE_INTEGRITY_ISSUE');
  }

  return {
    highQualityOverride: reasons.length === 0,
    highQualityOverrideReason: reasons.length === 0
      ? 'ALL_HIGH_QUALITY_SAFETY_GATES_PASSED'
      : reasons.join('; '),
    overrideScoreThreshold: HIGH_QUALITY_OVERRIDE_SCORE_THRESHOLD,
    overrideRrThreshold: HIGH_QUALITY_OVERRIDE_RR_THRESHOLD,
  };
}

function tradeReached1R(trade) {
  return (
    trade?.reached1R === true ||
    trade?.audit?.reached1R === true ||
    trade?.tradeAudit?.reached1R === true ||
    trade?.exitAudit?.reached1R === true
  );
}

function defaultClusteringTelemetry() {
  return {
    sameDirectionOpenTrade: false,
    existingTradeReached1R: null,
    clusteringDecision: 'NONE',
    clusteringReason: 'No same-direction open pullback',
  };
}

function applyClusteringTelemetry(signal, telemetry) {
  if (!signal || typeof signal !== 'object') return;
  signal.sameDirectionOpenTrade = telemetry.sameDirectionOpenTrade;
  signal.existingTradeReached1R = telemetry.existingTradeReached1R;
  signal.clusteringDecision = telemetry.clusteringDecision;
  signal.clusteringReason = telemetry.clusteringReason;
}

function assessPullbackClustering(signal, botState, action) {
  if (signal?.entryType !== 'pullback') {
    return {
      sameDirectionOpenTrade: false,
      existingTradeReached1R: null,
      clusteringDecision: 'NOT_APPLICABLE',
      clusteringReason: 'Signal is not a pullback',
    };
  }

  const sameDirectionOpenTrade = Array.isArray(botState?.openTrades)
    ? botState.openTrades.find(t =>
        normalizeDirection(t?.action ?? t?.direction) === action &&
        String(t?.entryType || '').toLowerCase() === 'pullback'
      )
    : null;

  if (!sameDirectionOpenTrade) {
    return defaultClusteringTelemetry();
  }

  const existingTradeReached1R = tradeReached1R(sameDirectionOpenTrade);
  return {
    sameDirectionOpenTrade: true,
    existingTradeReached1R,
    clusteringDecision: existingTradeReached1R ? 'ALLOW' : 'BLOCK',
    clusteringReason: existingTradeReached1R
      ? 'Same-direction pullback already open but existing trade reached 1R'
      : 'Same-direction pullback already open without reached1R proof',
  };
}

export function assessSetupQuality(signal, requiredConfidence = MIN_SETUP_CONFIDENCE_SCORE) {
  const initialRewardRisk = getInitialRewardRisk(signal);
  const setupConfidenceScore = getSetupConfidenceScore(signal);
  const rewardOk = initialRewardRisk !== null && initialRewardRisk >= MIN_REWARD_R_MULTIPLE;
  const minConfidence = Number.isFinite(Number(requiredConfidence))
    ? Number(requiredConfidence)
    : MIN_SETUP_CONFIDENCE_SCORE;
  const confidenceOk = setupConfidenceScore !== null && setupConfidenceScore >= minConfidence;

  return {
    initialRewardRisk,
    setupConfidenceScore: setupConfidenceScore === null ? null : Number(setupConfidenceScore.toFixed(2)),
    rewardOk,
    confidenceOk,
    ok: rewardOk && confidenceOk,
    minRewardR: MIN_REWARD_R_MULTIPLE,
    minSetupConfidenceScore: minConfidence,
  };
}

function getExpectancyKillAgeMs(expectancyKill, nowMs = Date.now()) {
  const activatedAt = Number(expectancyKill?.activatedAt);
  if (!Number.isFinite(activatedAt) || activatedAt <= 0) return 0;
  return Math.max(0, nowMs - activatedAt);
}

function resetExpectancyKillSwitch(expectancyKill, reason, resetTrend = null, nowMs = Date.now()) {
  const previousWindowKey = expectancyKill.windowKey || null;
  expectancyKill.active = false;
  expectancyKill.mode = null;
  expectancyKill.activatedAt = 0;
  expectancyKill.activationTrend = null;
  expectancyKill.windowKey = null;
  expectancyKill.resetAt = nowMs;
  expectancyKill.resetReason = reason;
  if (resetTrend) expectancyKill.resetTrend = resetTrend;
  expectancyKill.suppressedWindowKey = previousWindowKey;
}

function activateExpectancyKillSwitch(expectancyKill, { mode, activationTrend, windowKey, nowMs }) {
  const wasActive = expectancyKill.active === true;
  expectancyKill.active = true;
  expectancyKill.mode = mode;
  expectancyKill.activationTrend = activationTrend || null;
  expectancyKill.windowKey = windowKey || null;
  expectancyKill.resetReason = null;
  if (!wasActive) {
    expectancyKill.activatedAt = nowMs;
  }
}

export function resetDirectionalLossCircuitOnTrendReset(botState, indicators) {
  const circuit = ensureDirectionalCircuitState(botState);
  const expectancyKill = ensureExpectancyKillState(botState);
  const trend = normalizeTrend(indicators?.trend1h);
  const nowMs = Date.now();
  let changed = false;

  for (const action of ['BUY', 'SELL']) {
    if (!circuit[action].active) continue;
    const resetTrend = oppositeTrendForAction(action);
    if (trend === resetTrend) {
      circuit[action] = {
        active: false,
        activatedAt: 0,
        resetAt: Date.now(),
        resetTrend: trend,
      };
      changed = true;
    }
  }

  if (expectancyKill.active && expectancyKill.mode === 'HARD_PAUSE') {
    const expired = getExpectancyKillAgeMs(expectancyKill, nowMs) >= EXPECTANCY_KILL_EXPIRY_MS;
    const trendChanged = trend && expectancyKill.activationTrend && trend !== expectancyKill.activationTrend;

    if (trendChanged) {
      resetExpectancyKillSwitch(expectancyKill, 'TREND_CHANGE', trend, nowMs);
      console.log(`[RISK] PF10 hard pause reset by 1h trend change (${expectancyKill.activationTrend} -> ${trend})`);
      changed = true;
    } else if (expired) {
      resetExpectancyKillSwitch(expectancyKill, '24H_EXPIRED', trend || null, nowMs);
      console.log('[RISK] PF10 hard pause reset by 24h cooldown expiry');
      changed = true;
    } else if (!expectancyKill.activationTrend && trend) {
      expectancyKill.activationTrend = trend;
      changed = true;
    }
  }

  return changed;
}

export function getAdaptiveSpreadLimit(baseSpreadLimit, atr) {
  const base = parseFloat(baseSpreadLimit) || 0.5;
  const atrValue = parseFloat(atr);
  if (!Number.isFinite(atrValue) || atrValue <= 0) return base;
  return Math.min(0.80, Math.max(base, parseFloat((atrValue * 0.17).toFixed(2))));
}

function estimateMarginAwareSize(signal, balanceAED, availableMarginAED, riskMultiplier = 1.0) {
  const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);
  if (!Number.isFinite(stopDistance) || stopDistance <= 0.50) {
    return { estimatedSize: GOLD_MIN_SIZE, marginWithBufferAED: signal.entryPrice * GOLD_MIN_SIZE * GOLD_MARGIN_RATE * USD_AED_PEG * MARGIN_BUFFER };
  }

  const activeRiskPct = 0.02 * riskMultiplier;
  const riskAmountUSD = (balanceAED / USD_AED_PEG) * activeRiskPct;
  const riskSize = riskAmountUSD / stopDistance;
  const marginCapSize = availableMarginAED / (signal.entryPrice * GOLD_MARGIN_RATE * USD_AED_PEG * MARGIN_BUFFER);
  const rawSize = Math.min(riskSize, marginCapSize, GOLD_MAX_SIZE);
  const estimatedSize = Math.floor(Math.max(rawSize, 0) * 100) / 100;
  const marginWithBufferAED = estimatedSize * signal.entryPrice * GOLD_MARGIN_RATE * USD_AED_PEG * MARGIN_BUFFER;

  return { estimatedSize, marginWithBufferAED };
}

export function checkRisk(signal, botState, indicators, options = {}) {
  try {
    const now  = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
    const nowMs = now.getTime();
    const hour = now.getUTCHours();
    const day  = now.getUTCDay(); 
    applyHighQualityOverrideTelemetry(signal, defaultHighQualityOverrideTelemetry());
    applyClusteringTelemetry(signal, defaultClusteringTelemetry());

    // ── RULE 1: Environment kill switch ──────────────────────────────────────
    if (process.env.BOT_ENABLED !== 'true') {
      applyHighQualityOverrideTelemetry(signal, defaultHighQualityOverrideTelemetry('KILL_SWITCH_HARD_STOP_ACTIVE'));
      return 'SKIP: Bot disabled via environment';
    }

    const spreadLimit = getAdaptiveSpreadLimit(process.env.MAX_SPREAD, indicators?.atr);

    // ── RULE 2: State kill switches ───────────────────────────────────────────
    if (botState.botEnabled === false) {
      applyHighQualityOverrideTelemetry(signal, defaultHighQualityOverrideTelemetry('KILL_SWITCH_HARD_STOP_ACTIVE'));
      return 'SKIP: Bot disabled via state (drawdown or performance threshold)';
    }
    if (botState.stateIntegrityOk === false) {
      applyHighQualityOverrideTelemetry(signal, defaultHighQualityOverrideTelemetry('STATE_INTEGRITY_ISSUE'));
      return 'STOP: State integrity compromised — manual review required';
    }
    if (botState.criticalFailure === true) {
      applyHighQualityOverrideTelemetry(signal, defaultHighQualityOverrideTelemetry('KILL_SWITCH_HARD_STOP_ACTIVE'));
      return 'STOP: Critical failure active — manual recovery required';
    }
    if (botState.riskDataFresh !== true) {
      applyHighQualityOverrideTelemetry(signal, defaultHighQualityOverrideTelemetry('DATA_FRESHNESS_BLOCKED'));
      return 'STOP: Risk data stale — broker stats sync required';
    }

    const riskSyncAgeMs = Date.now() - (parseInt(botState.lastRiskSyncAt) || 0);
    if (riskSyncAgeMs > 6 * 60 * 1000) {
      applyHighQualityOverrideTelemetry(signal, defaultHighQualityOverrideTelemetry('DATA_FRESHNESS_BLOCKED'));
      return 'STOP: Risk data expired — broker stats must be refreshed';
    }

    // ── RULE 3: Soft Liquidity Multiplier (Asia Session vs London/NY) ─────────
    const min = now.getUTCMinutes();
    const timeFloat = hour + min / 60;
    
    // Define London to end of NY roughly as 07:00 UTC to 18:05 UTC (10:05 PM UAE)
    if (timeFloat < 7 || timeFloat > 18.08) {
      if (signal) signal.riskMultiplier = 0.5; // Reduce position size for low liquidity / Asia session
    } else {
      if (signal) signal.riskMultiplier = 1.0; // Normal risk for London / NY session
    }

    // ── RULE 4: Signal checks ──────────────────────────────────────────────────
    if (!signal) return 'SKIP: No signal generated this cycle';

    if (
      typeof signal.entryPrice !== 'number' || isNaN(signal.entryPrice) ||
      typeof signal.stopLoss   !== 'number' || isNaN(signal.stopLoss)   ||
      typeof signal.takeProfit !== 'number' || isNaN(signal.takeProfit)
    ) return 'SKIP: Signal has invalid or missing fields';

    // ── RULE 5: Stop loss direction sanity ───────────────────────────────────
    if (!signal.action || (signal.action !== 'BUY' && signal.action !== 'SELL'))
      return 'SKIP: Signal action must be BUY or SELL';
    if (signal.action === 'BUY'  && signal.stopLoss >= signal.entryPrice)
      return 'SKIP: BUY stop loss is not below entry price';
    if (signal.action === 'SELL' && signal.stopLoss <= signal.entryPrice)
      return 'SKIP: SELL stop loss is not above entry price';

    const action = normalizeDirection(signal.action);
    const recentOutcomes = getRecentOutcomes(botState);
    const signalCandleTime = getSignalCandleTime(signal);
    const currentTrend1h = normalizeTrend(indicators?.trend1h);
    const sessionAssessment = classifyTradingSession(now, {
      marketClosedReason: options.marketClosedReason ?? botState.currentCycleReason ?? null,
    });
    const regimeAssessment = classifyMarketRegimeDetails(indicators, {
      marketClosedReason: options.marketClosedReason ?? botState.currentCycleReason ?? null,
    });
    const expectancyKill = ensureExpectancyKillState(botState);
    const last5Outcomes = recentOutcomes.slice(-ROLLING_PF_WARNING_WINDOW);
    const last10Outcomes = recentOutcomes.slice(-ROLLING_PF_HARD_WINDOW);
    const rollingProfitFactor5 = last5Outcomes.length === ROLLING_PF_WARNING_WINDOW
      ? calculateProfitFactor(last5Outcomes)
      : null;
    const rollingProfitFactor10 = last10Outcomes.length === ROLLING_PF_HARD_WINDOW
      ? calculateProfitFactor(last10Outcomes)
      : null;
    const expectancy5R = last5Outcomes.length === ROLLING_PF_WARNING_WINDOW
      ? calculateWindowExpectancyR(last5Outcomes)
      : null;
    const fullStopsLast3 = countFullStops(recentOutcomes.slice(-3));
    const currentPf5WindowKey = last5Outcomes.length === ROLLING_PF_WARNING_WINDOW
      ? buildOutcomeWindowKey(last5Outcomes)
      : null;
    const pf5Warning = rollingProfitFactor5 !== null && rollingProfitFactor5 < PF5_KILL_THRESHOLD;
    const expectancyWarning = expectancy5R !== null && expectancy5R < RECOVERY_EXPECTANCY_THRESHOLD_R;
    const recoveryTrigger = pf5Warning || fullStopsLast3 >= 2 || expectancyWarning;
    const recoveryAgeMs = getExpectancyKillAgeMs(expectancyKill, nowMs);
    const forceExpired = expectancyKill.active && recoveryAgeMs >= EXPECTANCY_KILL_EXPIRY_MS;
    if (forceExpired) {
      resetExpectancyKillSwitch(expectancyKill, '24H_EXPIRED', currentTrend1h || null, nowMs);
    }
    const recoveryCanReset =
      expectancyKill.active &&
      expectancyKill.mode === 'RECOVERY' &&
      (countConsecutiveNonLosses(recentOutcomes) >= 2 || (expectancy5R !== null && expectancy5R >= 0));

    if (recoveryCanReset) {
      resetExpectancyKillSwitch(expectancyKill, expectancy5R !== null && expectancy5R >= 0 ? 'EXPECTANCY_RECOVERED' : 'RECOVERY_EXIT', currentTrend1h || null, nowMs);
    } else if (recoveryTrigger && !expectancyKill.active) {
      const isSuppressedWindow = currentPf5WindowKey && expectancyKill.suppressedWindowKey && expectancyKill.suppressedWindowKey === currentPf5WindowKey;
      if (!isSuppressedWindow) {
        activateExpectancyKillSwitch(expectancyKill, {
          mode: 'RECOVERY',
          activationTrend: currentTrend1h || null,
          windowKey: currentPf5WindowKey,
          nowMs,
        });
      }
    }

    const recoveryModeActive = expectancyKill.active && expectancyKill.mode === 'RECOVERY';
    const requiredConfidence = recoveryModeActive
      ? 65
      : regimeAssessment.isSoftRegime
        ? Number(regimeAssessment.requiredConfidence || 65)
        : MIN_SETUP_CONFIDENCE_SCORE;
    signal.requiredConfidenceUsed = requiredConfidence;
    signal.recoveryModeActive = recoveryModeActive;
    signal.pf5Telemetry = rollingProfitFactor5 === null ? null : Number(rollingProfitFactor5.toFixed(2));
    signal.pf10Telemetry = rollingProfitFactor10 === null ? null : Number(rollingProfitFactor10.toFixed(2));
    signal.expectancy5R = expectancy5R === null ? null : Number(expectancy5R.toFixed(4));

    const setupQuality = assessSetupQuality(signal, requiredConfidence);
    signal.initialRewardRisk = setupQuality.initialRewardRisk;
    signal.setupConfidenceScore = setupQuality.setupConfidenceScore;
    signal.setupQuality = setupQuality;
    const highQualityOverrideTelemetry = assessHighQualityOverride({
      setupQuality,
      botState,
      indicators,
      session: sessionAssessment,
      regime: regimeAssessment,
      spreadLimit,
    });
    applyHighQualityOverrideTelemetry(signal, highQualityOverrideTelemetry);
    console.log(
      `[RISK] High-quality override: highQualityOverride=${highQualityOverrideTelemetry.highQualityOverride} ` +
      `highQualityOverrideReason=${highQualityOverrideTelemetry.highQualityOverrideReason} ` +
      `overrideScoreThreshold=${highQualityOverrideTelemetry.overrideScoreThreshold} ` +
      `overrideRrThreshold=${highQualityOverrideTelemetry.overrideRrThreshold}`
    );

    if (!setupQuality.rewardOk) {
      const rr = formatRewardRiskForGate(setupQuality.initialRewardRisk);
      return `SKIP: Initial reward/risk ${rr}R below minimum ${MIN_REWARD_R_MULTIPLE.toFixed(2)}R`;
    }

    if (!setupQuality.confidenceOk) {
      const score = setupQuality.setupConfidenceScore === null ? 'unknown' : setupQuality.setupConfidenceScore.toFixed(2);
      return `SKIP: Setup confidence score ${score} below minimum ${setupQuality.minSetupConfidenceScore}`;
    }

    // ── RULE 5A: Staged expectancy defense ───────────────────────────────────
    if (rollingProfitFactor5 !== null) {
      botState.rollingProfitFactor5 = Number(rollingProfitFactor5.toFixed(2));
    }
    if (rollingProfitFactor10 !== null) {
      botState.rollingProfitFactor10 = Number(rollingProfitFactor10.toFixed(2));
    }

    const hardPfFailure =
      rollingProfitFactor10 !== null &&
      rollingProfitFactor10 < ROLLING_PF_HARD_THRESHOLD &&
      countFullStops(last10Outcomes) >= 7;
    if (hardPfFailure) {
      activateExpectancyKillSwitch(expectancyKill, {
        mode: 'HARD_PAUSE',
        activationTrend: currentTrend1h || null,
        windowKey: buildOutcomeWindowKey(last10Outcomes),
        nowMs,
      });
      botState.performanceReviewNeeded = true;
      botState.performanceReviewReason = `PF10=${rollingProfitFactor10.toFixed(2)} < ${ROLLING_PF_HARD_THRESHOLD.toFixed(2)} with ${countFullStops(last10Outcomes)} full-stop losses`;
      return `PAUSE: Rolling 10-trade profit factor ${rollingProfitFactor10.toFixed(2)} below ${ROLLING_PF_HARD_THRESHOLD.toFixed(2)} with excessive full-stop losses`;
    }

    if (expectancyKill.active && expectancyKill.mode === 'HARD_PAUSE') {
      return 'PAUSE: PF10 hard expectancy pause active';
    }

    if (recoveryModeActive) {
      const existingMultiplier = Number(signal.riskMultiplier);
      signal.riskMultiplier = Math.min(Number.isFinite(existingMultiplier) && existingMultiplier > 0 ? existingMultiplier : 1.0, 0.5);
      signal.expectancyKillReset = {
        reason: 'RECOVERY_MODE',
        riskMultiplier: signal.riskMultiplier,
        pf5: signal.pf5Telemetry,
        expectancy5R: signal.expectancy5R,
      };
      if (signal.trendConflict === true) {
        return 'PAUSE: Recovery mode requires clean 1h trend alignment';
      }
      if (regimeAssessment.regime === 'EXTREME') {
        return 'PAUSE: Recovery mode blocks hard EXTREME regime';
      }
      botState.performanceReviewNeeded = true;
      botState.performanceReviewReason = `Recovery mode active: PF5=${signal.pf5Telemetry ?? 'n/a'}, expectancy5R=${signal.expectancy5R ?? 'n/a'}, 50% risk`;
    }

    // ── RULE 5B: Same-direction cooldown after stop loss ──────────────────────
    const lastSameDirectionStopLoss = recentOutcomes
      .filter(o => normalizeDirection(o.action) === action && isStopLossOutcome(o))
      .slice(-1)[0];
    if (lastSameDirectionStopLoss?.closedCandleTime) {
      const cooldownUntil = Number(lastSameDirectionStopLoss.closedCandleTime)
        + (SAME_DIRECTION_STOP_COOLDOWN_CANDLES * CANDLE_MS);
      if (signalCandleTime <= cooldownUntil) {
        return `PAUSE: ${action} cooldown after stop loss — wait ${SAME_DIRECTION_STOP_COOLDOWN_CANDLES} completed candles`;
      }
    }

    // ── RULE 5C: Consecutive same-direction stop-loss circuit breaker ─────────
    const circuit = ensureDirectionalCircuitState(botState);
    if (hasTwoConsecutiveSameDirectionStopLosses(recentOutcomes, action)) {
      circuit[action] = {
        active: true,
        activatedAt: circuit[action].activatedAt || Date.now(),
        resetTrend: trendForAction(action),
      };
    }
    if (circuit[action]?.active) {
      return `PAUSE: ${action} circuit breaker active after 2 same-direction stop losses — waiting for 1h trend reset`;
    }

    // ── RULE 5D: Same-direction pullback clustering ───────────────────────────
    const clusteringTelemetry = assessPullbackClustering(signal, botState, action);
    applyClusteringTelemetry(signal, clusteringTelemetry);
    console.log(
      `[RISK] Pullback clustering: sameDirectionOpenTrade=${clusteringTelemetry.sameDirectionOpenTrade} ` +
      `existingTradeReached1R=${clusteringTelemetry.existingTradeReached1R} ` +
      `clusteringDecision=${clusteringTelemetry.clusteringDecision} ` +
      `clusteringReason=${clusteringTelemetry.clusteringReason}`
    );
    if (signal.entryType === 'pullback' && clusteringTelemetry.clusteringDecision === 'BLOCK') {
      return `PAUSE: ${action} pullback clustering blocked — same-direction pullback already open without reached1R proof`;
    }

    // ── RULE 5E: Pullback extension guard ─────────────────────────────────────
    if (signal.entryType === 'pullback') {
      const ema20 = Number(indicators?.currEMA20);
      const atrValue = Number(indicators?.atr ?? signal.atr);
      if (!Number.isFinite(ema20) || !Number.isFinite(atrValue) || atrValue <= 0) {
        return 'SKIP: Pullback extension guard missing EMA20/ATR';
      }
      const extensionAtr = Math.abs(signal.entryPrice - ema20) / atrValue;
      signal.entryExtensionAtr = Number(extensionAtr.toFixed(4));
      if (extensionAtr > PULLBACK_EXTENSION_ATR_CAP) {
        return `SKIP: Pullback entry extended ${extensionAtr.toFixed(2)} ATR from EMA20 (cap ${PULLBACK_EXTENSION_ATR_CAP.toFixed(2)})`;
      }
    }

    // ── RULE 6: Spread check ─────────────────────────────────────────────────
    if (typeof indicators.spread !== 'number' || isNaN(indicators.spread))
      return 'SKIP: Spread unavailable - skipping for safety';
    if (indicators.spread > spreadLimit)
      return 'SKIP: high spread';

    // ── RULE 7: Max open positions ───────────────────────────────────────────
    if (Array.isArray(botState.openTrades) && botState.openTrades.length >= 2)
      return `SKIP: Max 2 positions open (currently ${botState.openTrades.length})`;

    // ── RULE 8: Daily trade cap ───────────────────────────────────────────────
    const dailyTrades = parseInt(botState.dailyTrades ?? 0);
    if (Number.isFinite(dailyTrades) && dailyTrades >= MAX_DAILY_TRADES)
      return `SKIP: Daily trade cap reached (${dailyTrades}/${MAX_DAILY_TRADES})`;

    // ── RULE 8A: Hard opening-order rate cap ─────────────────────────────────
    const recentOrderTimestamps = getRecentOrderTimestamps(botState);
    if (recentOrderTimestamps.length >= MAX_OPENING_ORDERS_PER_WINDOW)
      return `SKIP: Order rate cap reached (${recentOrderTimestamps.length}/${MAX_OPENING_ORDERS_PER_WINDOW} opening orders in 60s)`;

    // ── RULE 9: Daily loss limit ──────────────────────────────────────────────
    const dailyLoss = parseFloat(botState.dailyLoss);
    const balance   = parseFloat(botState.balance);
    if (isDailyLossStopActive(botState))
      return 'STOP: daily loss limit reached';

    // ── RULE 10: Total drawdown hard stop ─────────────────────────────────────
    const equity = parseFloat(botState.equity || botState.balance);
    const peak   = parseFloat(botState.peakBalance);
    if (peak > 0) {
      const equityDrawdown = calculateDrawdown(peak, equity);
      if (equityDrawdown >= 20) {
        botState.botEnabled = false;
        return `DISABLE: Equity drawdown (${equityDrawdown.toFixed(2)}%) reached limit (20%) — bot disabled. Status: Real-time risk exposure too high.`;
      }
    }

    if (isNaN(balance) || balance <= 0)
      return 'SKIP: Balance not yet synced from Capital.com';
    if (balance < 80)
      return `SKIP: Balance too low for minimum size (need 80 AED, have ${balance.toFixed(2)})`;

    // ── RULE 11: Margin buffer check ──────────────────────────────────────────
    const availableMargin = parseFloat(botState.availableMargin);
    if (!isNaN(availableMargin) && availableMargin > 0) {
      const { estimatedSize, marginWithBufferAED } = estimateMarginAwareSize(
        signal,
        balance,
        availableMargin,
        signal.riskMultiplier || 1.0
      );

      if (estimatedSize < GOLD_MIN_SIZE) {
        return `SKIP: Insufficient margin — need AED ${marginWithBufferAED.toFixed(2)} (with 1.5× buffer), have AED ${availableMargin.toFixed(2)}`;
      }
    }

    // ── RULE 12: Duplicate trade ID ───────────────────────────────────────────
    if (Array.isArray(botState.recentTradeIds) && botState.recentTradeIds.includes(signal.id))
      return 'SKIP: Duplicate signal ID - already processed this signal';

    // ── RULE 13: UTC session entry window ─────────────────────────────────────
    const session = sessionAssessment;
    if (signal && typeof signal === 'object') {
      signal.sessionName = session.sessionName;
      signal.isAllowedSession = session.isAllowedSession;
      signal.sessionRejectReason = session.sessionRejectReason;
    }
    if (!session.isAllowedSession) {
      return session.sessionRejectReason || options.marketClosedReason || 'SKIP: Outside allowed trading session';
    }

    // ── RULE 14: Market regime entry window ──────────────────────────────────
    const regime = regimeAssessment;
    if (signal && typeof signal === 'object') {
      signal.regime = regime.regime;
      signal.atrRatio = regime.atrRatio;
      signal.emaSpreadAtr = regime.emaSpreadAtr;
      signal.regimeRejectReason = regime.regimeRejectReason;
      signal.wouldPassSoftRegime = regime.isSoftRegime === true;
      signal.softRegimeRiskMultiplier = regime.isSoftRegime === true ? regime.riskMultiplier : null;
    }
    if (!regime.isAllowedRegime) {
      return regime.regimeRejectReason || options.marketClosedReason || 'SKIP: Market regime unavailable';
    }
    if (regime.isSoftRegime === true) {
      const existingMultiplier = Number(signal.riskMultiplier);
      signal.riskMultiplier = Math.min(Number.isFinite(existingMultiplier) && existingMultiplier > 0 ? existingMultiplier : 1.0, Number(regime.riskMultiplier || 0.5));
      if (
        regime.regime === 'SOFT_SIDEWAYS' &&
        !(signal.bosValid === true || signal.sweepValid === true)
      ) {
        return 'SKIP: SOFT_SIDEWAYS requires BOS or sweep confirmation';
      }
    }

    return 'APPROVED';

  } catch (err) {
    return `SKIP: Risk check error - ${err.message}`;
  }
}
