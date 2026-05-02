// logger.js — Save every bot decision to Upstash KV, including all skips.
// Every single cron invocation is logged — this is the source of truth for audit and analysis.

import { Redis } from '@upstash/redis';
import { STRATEGY_VERSION } from './strategy.js';
import { buildDelegationGap } from './delegation_gap.js';
import { classifyTradingSession } from './session_filter.js';
import { classifyMarketRegimeDetails } from './market_regime.js';
import { MIN_RR_V2, SETUP_CONFIDENCE_MIN_V2 } from './risk.js';

const TRADE_HISTORY_KEY = 'trade_history';
const TRADE_AUDIT_EVENTS_KEY = 'trade_audit_events';
export const CYCLE_LOG_RETENTION_LIMIT = 5000;
export const TRADE_AUDIT_EVENT_CAP = 5000;

let redisClient = null;
function getRedis() {
  if (!redisClient) {
    redisClient = new Redis({
      url:   process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  }
  return redisClient;
}

function finiteOrNull(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function boolOrNull(value) {
  if (value === true || value === false) return value;
  return null;
}

function roundTelemetry(value, decimals = 4) {
  const num = finiteOrNull(value);
  return num === null ? null : Number(num.toFixed(decimals));
}

function valueOrNull(...values) {
  for (const value of values) {
    if (value !== undefined) return value ?? null;
  }
  return null;
}

function confidenceBucket(score) {
  const value = finiteOrNull(score);
  if (value === null) return null;
  if (value < 50) return '0-49';
  if (value < 65) return '50-64';
  if (value < 75) return '65-74';
  if (value < 85) return '75-84';
  return '85-100';
}

function deriveRegimeThresholdTelemetry(regimeDetails, indicators = {}) {
  const regime = valueOrNull(regimeDetails?.regime, indicators?.marketRegime);
  const atr = finiteOrNull(indicators?.atr ?? indicators?.atr14_5m);
  const atrRatioValue = finiteOrNull(regimeDetails?.atrRatio);
  const emaSpreadAtrValue = finiteOrNull(regimeDetails?.emaSpreadAtr);

  return {
    regimeBlockType: ['DEAD', 'EXTREME', 'SIDEWAYS'].includes(String(regime || '').toUpperCase())
      ? String(regime).toUpperCase()
      : null,
    atrRatioValue: roundTelemetry(atrRatioValue),
    atrDeadDistance: atrRatioValue !== null
      ? roundTelemetry(atrRatioValue - 0.70)
      : atr !== null
        ? roundTelemetry(atr - 0.60)
        : null,
    atrExtremeDistance: atrRatioValue !== null ? roundTelemetry(2.20 - atrRatioValue) : null,
    emaSpreadAtrValue: roundTelemetry(emaSpreadAtrValue),
    sidewaysDistance: emaSpreadAtrValue !== null ? roundTelemetry(emaSpreadAtrValue - 0.18) : null,
  };
}

function resolveDirection(data, signalDebug, signal) {
  return valueOrNull(
    data.nearSignalDirection,
    signalDebug.nearSignalDirection,
    signalDebug.dbgAction,
    signal?.action
  );
}

function isNearSignal(data, signalDebug, signal) {
  const explicit = valueOrNull(data.nearSignalDetected, signalDebug.nearSignalDetected);
  if (explicit !== undefined && explicit !== null) return boolOrNull(explicit);
  return Boolean(
    signal?.action ||
    signalDebug.dbgAction ||
    signalDebug.pullbackNearMiss === true ||
    signalDebug.sweepCandidate === true ||
    signalDebug.bosCandidate === true
  );
}

export const V2_DIAGNOSTIC_FIELDS = [
  'sessionName',
  'isAllowedSession',
  'sessionRejectReason',
  'regime',
  'atrRatio',
  'emaSpreadAtr',
  'regimeRejectReason',
  'regimeBlockType',
  'atrRatioValue',
  'atrDeadDistance',
  'atrExtremeDistance',
  'emaSpreadAtrValue',
  'sidewaysDistance',
  'nearSignalDetected',
  'nearSignalDirection',
  'nearSignalRejectReason',
  'pullbackValid',
  'pullbackDirection',
  'pullbackDistanceAtr',
  'pullbackDistanceFromEma20Atr',
  'pullbackDistanceFromEma50Atr',
  'pullbackNearMiss',
  'pullbackMissDistanceAtr',
  'pullbackRejectReason',
  'sweepValid',
  'sweepDirection',
  'sweepCandidate',
  'sweepLookbackUsed',
  'sweepBreakDistanceAtr',
  'sweepWickPct',
  'sweepBodyPct',
  'sweepFailedReason',
  'bosValid',
  'bosDirection',
  'bosCandidate',
  'lastSwingHigh',
  'lastSwingLow',
  'bosBreakDistanceAtr',
  'bosFailedReason',
  'bodyPct',
  'upperWickPct',
  'lowerWickPct',
  'swingHigh',
  'swingLow',
  'rrCandidate',
  'rrThresholdUsed',
  'confidenceThresholdUsed',
  'confidenceRaw',
  'confidenceBucket',
  'rrPass',
  'confidencePass',
  'rejectStage',
  'strategyVersion',
];

export function buildV2Diagnostics(data = {}, marketRegime = null, now = new Date()) {
  const session = classifyTradingSession(now, { marketClosedReason: data.reason });
  const signalDebug = data.signalDebug ?? {};
  const signal = data.signal ?? {};
  const indicators = data.indicators ?? {};
  const hasIndicators = data.indicators && typeof data.indicators === 'object' && !Array.isArray(data.indicators);
  const regimeDetails = hasIndicators
    ? classifyMarketRegimeDetails(indicators, { marketClosedReason: data.reason })
    : { regime: null, atrRatio: null, emaSpreadAtr: null, regimeRejectReason: null };
  const rrCandidate = valueOrNull(
    signalDebug.rrCandidate,
    signal.initialRewardRisk,
    signal.setupQuality?.initialRewardRisk
  );
  const confidenceCandidate = valueOrNull(
    signalDebug.setupConfidenceScore,
    signalDebug.dbgSetupConfidenceScore,
    data.setupConfidenceScore,
    signal.setupConfidenceScore,
    signal.setupConfidence?.score
  );
  const rrThresholdUsed = finiteOrNull(valueOrNull(
    data.rrThresholdUsed,
    signalDebug.rrThresholdUsed,
    signal.rrThresholdUsed,
    signal.setupQuality?.minRewardR,
    MIN_RR_V2
  ));
  const confidenceThresholdUsed = finiteOrNull(valueOrNull(
    data.confidenceThresholdUsed,
    signalDebug.confidenceThresholdUsed,
    signal.confidenceThresholdUsed,
    signal.setupQuality?.minSetupConfidenceScore,
    SETUP_CONFIDENCE_MIN_V2
  ));
  const rrValue = finiteOrNull(rrCandidate);
  const confidenceValue = finiteOrNull(confidenceCandidate);
  const thresholdTelemetry = deriveRegimeThresholdTelemetry(regimeDetails, indicators);

  return {
    sessionName: valueOrNull(data.sessionName, signalDebug.sessionName, signal.sessionName, session.sessionName),
    isAllowedSession: boolOrNull(valueOrNull(data.isAllowedSession, signalDebug.isAllowedSession, signal.isAllowedSession, session.isAllowedSession)),
    sessionRejectReason: valueOrNull(data.sessionRejectReason, signalDebug.sessionRejectReason, signal.sessionRejectReason, session.sessionRejectReason),
    regime: valueOrNull(data.regime, signalDebug.regime, signal.regime, signalDebug.marketRegime, marketRegime, regimeDetails.regime),
    atrRatio: finiteOrNull(valueOrNull(signalDebug.atrRatio, data.atrRatio,
      signal.atrRatio,
      regimeDetails.atrRatio,
      finiteOrNull(indicators.atrAverage) && finiteOrNull(indicators.atrAverage) > 0
        ? finiteOrNull(indicators.atr) / finiteOrNull(indicators.atrAverage)
        : null
    )),
    emaSpreadAtr: finiteOrNull(valueOrNull(signalDebug.emaSpreadAtr, data.emaSpreadAtr,
      signal.emaSpreadAtr,
      regimeDetails.emaSpreadAtr,
      finiteOrNull(indicators.atr) && finiteOrNull(indicators.atr) > 0 &&
      finiteOrNull(indicators.currEMA20) !== null && finiteOrNull(indicators.currEMA50) !== null
        ? Math.abs(finiteOrNull(indicators.currEMA20) - finiteOrNull(indicators.currEMA50)) / finiteOrNull(indicators.atr)
        : null
    )),
    regimeRejectReason: valueOrNull(data.regimeRejectReason, signalDebug.regimeRejectReason, signal.regimeRejectReason, regimeDetails.regimeRejectReason),
    ...thresholdTelemetry,
    nearSignalDetected: isNearSignal(data, signalDebug, signal),
    nearSignalDirection: resolveDirection(data, signalDebug, signal),
    nearSignalRejectReason: valueOrNull(data.nearSignalRejectReason, signalDebug.nearSignalRejectReason, data.reason, signalDebug.dbgRejectReason),
    pullbackValid: boolOrNull(valueOrNull(signalDebug.pullbackValid, data.pullbackValid)),
    pullbackDirection: valueOrNull(data.pullbackDirection, signalDebug.pullbackDirection),
    pullbackDistanceAtr: finiteOrNull(valueOrNull(signalDebug.pullbackDistanceAtr, data.pullbackDistanceAtr)),
    pullbackDistanceFromEma20Atr: finiteOrNull(valueOrNull(signalDebug.pullbackDistanceFromEma20Atr, data.pullbackDistanceFromEma20Atr, signalDebug.pullbackDistanceAtr, data.pullbackDistanceAtr)),
    pullbackDistanceFromEma50Atr: finiteOrNull(valueOrNull(signalDebug.pullbackDistanceFromEma50Atr, data.pullbackDistanceFromEma50Atr)),
    pullbackNearMiss: boolOrNull(valueOrNull(signalDebug.pullbackNearMiss, data.pullbackNearMiss)),
    pullbackMissDistanceAtr: finiteOrNull(valueOrNull(signalDebug.pullbackMissDistanceAtr, data.pullbackMissDistanceAtr)),
    pullbackRejectReason: valueOrNull(data.pullbackRejectReason, signalDebug.pullbackRejectReason),
    sweepValid: boolOrNull(valueOrNull(signalDebug.sweepValid, data.sweepValid)),
    sweepDirection: valueOrNull(data.sweepDirection, signalDebug.sweepDirection),
    sweepCandidate: boolOrNull(valueOrNull(signalDebug.sweepCandidate, data.sweepCandidate)),
    sweepLookbackUsed: finiteOrNull(valueOrNull(signalDebug.sweepLookbackUsed, data.sweepLookbackUsed)),
    sweepBreakDistanceAtr: finiteOrNull(valueOrNull(signalDebug.sweepBreakDistanceAtr, data.sweepBreakDistanceAtr)),
    sweepWickPct: finiteOrNull(valueOrNull(signalDebug.sweepWickPct, data.sweepWickPct)),
    sweepBodyPct: finiteOrNull(valueOrNull(signalDebug.sweepBodyPct, data.sweepBodyPct, signalDebug.bodyPct, data.bodyPct)),
    sweepFailedReason: valueOrNull(data.sweepFailedReason, signalDebug.sweepFailedReason),
    bosValid: boolOrNull(valueOrNull(signalDebug.bosValid, data.bosValid)),
    bosDirection: valueOrNull(data.bosDirection, signalDebug.bosDirection),
    bosCandidate: boolOrNull(valueOrNull(signalDebug.bosCandidate, data.bosCandidate)),
    lastSwingHigh: finiteOrNull(valueOrNull(signalDebug.lastSwingHigh, data.lastSwingHigh)),
    lastSwingLow: finiteOrNull(valueOrNull(signalDebug.lastSwingLow, data.lastSwingLow)),
    bosBreakDistanceAtr: finiteOrNull(valueOrNull(signalDebug.bosBreakDistanceAtr, data.bosBreakDistanceAtr)),
    bosFailedReason: valueOrNull(data.bosFailedReason, signalDebug.bosFailedReason),
    bodyPct: finiteOrNull(valueOrNull(signalDebug.bodyPct, data.bodyPct)),
    upperWickPct: finiteOrNull(valueOrNull(signalDebug.upperWickPct, data.upperWickPct)),
    lowerWickPct: finiteOrNull(valueOrNull(signalDebug.lowerWickPct, data.lowerWickPct)),
    swingHigh: finiteOrNull(valueOrNull(signalDebug.swingHigh, data.swingHigh, indicators.resistance)),
    swingLow: finiteOrNull(valueOrNull(signalDebug.swingLow, data.swingLow, indicators.support)),
    rrCandidate: rrValue,
    rrThresholdUsed,
    confidenceThresholdUsed,
    confidenceRaw: finiteOrNull(valueOrNull(
      data.confidenceRaw,
      signalDebug.confidenceRaw,
      signalDebug.dbgRawSetupConfidenceScore,
      signal.setupConfidence?.rawScore,
      confidenceValue
    )),
    confidenceBucket: valueOrNull(
      data.confidenceBucket,
      signalDebug.confidenceBucket,
      confidenceBucket(confidenceValue)
    ),
    rrPass: boolOrNull(valueOrNull(
      signalDebug.rrPass,
      data.rrPass,
      signal.rrPass,
      signal.setupQuality?.rewardOk,
      rrValue !== null && rrThresholdUsed !== null ? rrValue >= rrThresholdUsed : null
    )),
    confidencePass: boolOrNull(valueOrNull(
      signalDebug.confidencePass,
      data.confidencePass,
      signal.confidencePass,
      signal.setupQuality?.confidenceOk,
      confidenceValue !== null && confidenceThresholdUsed !== null ? confidenceValue >= confidenceThresholdUsed : null
    )),
    rejectStage: valueOrNull(data.rejectStage, signalDebug.rejectStage),
    strategyVersion: signal.strategyVersion || data.strategyVersion || STRATEGY_VERSION,
  };
}

export function normalizeLogDiagnostics(log) {
  if (!log || typeof log !== 'object' || Array.isArray(log)) return log;
  const existingMissing = V2_DIAGNOSTIC_FIELDS.some(field => log[field] === undefined);
  if (!existingMissing) return log;

  const loggedAt = new Date(log.time);
  const now = Number.isNaN(loggedAt.getTime()) ? new Date() : loggedAt;
  return {
    ...log,
    ...buildV2Diagnostics(log, log.marketRegime ?? null, now),
  };
}

function milestoneFlags(source) {
  return {
    reached1R: source?.reached1R === true,
    reached1_2R: source?.reached1_2R === true,
    reached1_5R: source?.reached1_5R === true,
    reached2R: source?.reached2R === true,
    reached2_5R: source?.reached2_5R === true,
    reachedTpR: source?.reachedTpR === true,
  };
}

function baseAnalyticsEvent(log, eventType) {
  return {
    eventType,
    ts: log.time,
    strategyVersion: log.strategyVersion,
    tradeId: log.tradeId,
    entryType: log.entryType,
    signal: log.signalDetected,
    reason: log.reason,
    executionPolicy: log.executionPolicy ?? null,
    marketRegime: log.marketRegime ?? null,
    schedulerSource: log.schedulerSource,
  };
}

function tradeAnalyticsFields(log, auditSource = log.audit, exitSource = log.exitAudit) {
  return {
    entryPrice: finiteOrNull(log.entryPrice),
    stopLoss: finiteOrNull(log.stopLoss),
    takeProfit: finiteOrNull(log.takeProfit),
    size: finiteOrNull(log.size),
    dealId: log.dealId ?? null,
    dealReference: log.dealReference ?? null,
    pnl: finiteOrNull(exitSource?.realizedPnl),
    realizedR: finiteOrNull(exitSource?.realizedR),
    mfeR: finiteOrNull(exitSource?.mfeR ?? auditSource?.mfeR),
    maeR: finiteOrNull(exitSource?.maeR ?? auditSource?.maeR),
    takenTradeMfeR: finiteOrNull(exitSource?.mfeR ?? auditSource?.mfeR),
    takenTradeMaeR: finiteOrNull(exitSource?.maeR ?? auditSource?.maeR),
    exitReasonClass: exitSource?.exitReasonClass ?? null,
    postTradeReasonTags: Array.isArray(exitSource?.postTradeReasonTags) ? exitSource.postTradeReasonTags : [],
    primaryPostTradeReason: exitSource?.primaryPostTradeReason ?? null,
    ...milestoneFlags(exitSource ?? auditSource),
  };
}

function normalizeTradeDirection(direction) {
  const value = String(direction || '').toUpperCase();
  return value === 'BUY' || value === 'SELL' ? value : null;
}

function currentTelemetryPrice(data) {
  return finiteOrNull(
    data.indicators?.lastCandle?.close ??
    data.indicators?.goldPrice ??
    data.goldPrice
  );
}

function setupRiskDistance(setup) {
  const entry = finiteOrNull(setup?.blockedSetupPrice ?? setup?.entryPrice);
  const stop = finiteOrNull(setup?.stopLoss);
  if (entry === null || stop === null) return null;
  const distance = Math.abs(entry - stop);
  return distance > 0 ? distance : null;
}

function updateSetupExcursion(setup, price, nowMs) {
  const direction = normalizeTradeDirection(setup?.blockedSetupDirection);
  const entry = finiteOrNull(setup?.blockedSetupPrice);
  const riskDistance = setupRiskDistance(setup);
  const currentPrice = finiteOrNull(price);
  if (!direction || entry === null || riskDistance === null || currentPrice === null) return setup;

  const ageMs = nowMs - Number(setup.blockedSetupTimeMs || 0);
  if (!Number.isFinite(ageMs) || ageMs < 0) return setup;

  const profitDistance = direction === 'BUY' ? currentPrice - entry : entry - currentPrice;
  const mfeR = roundTelemetry(Math.max(profitDistance, 0) / riskDistance);
  const maeR = roundTelemetry(Math.max(-profitDistance, 0) / riskDistance);
  const next = { ...setup };

  if (ageMs <= 60 * 60 * 1000) {
    next.blockedSetupMfe1hR = Math.max(finiteOrNull(next.blockedSetupMfe1hR) ?? 0, mfeR ?? 0);
    next.blockedSetupMae1hR = Math.max(finiteOrNull(next.blockedSetupMae1hR) ?? 0, maeR ?? 0);
  }
  if (ageMs <= 3 * 60 * 60 * 1000) {
    next.blockedSetupMfe3hR = Math.max(finiteOrNull(next.blockedSetupMfe3hR) ?? 0, mfeR ?? 0);
    next.blockedSetupMae3hR = Math.max(finiteOrNull(next.blockedSetupMae3hR) ?? 0, maeR ?? 0);
  }
  return next;
}

function buildBlockedSetupFromLog(data, now) {
  if (data.tradeExecuted === true || !data.signal) return null;
  const direction = normalizeTradeDirection(data.signal?.action);
  const entry = finiteOrNull(data.signal?.entryPrice);
  const stopLoss = finiteOrNull(data.signal?.stopLoss);
  if (!direction || entry === null) return null;

  return {
    blockedSetupId: data.signal?.id ?? `blocked_${now.getTime()}`,
    blockedSetupTime: now.toISOString(),
    blockedSetupTimeMs: now.getTime(),
    blockedSetupDirection: direction,
    blockedSetupPrice: entry,
    blockedSetupReason: data.reason ?? null,
    stopLoss,
    blockedSetupMfe1hR: null,
    blockedSetupMae1hR: null,
    blockedSetupMfe3hR: null,
    blockedSetupMae3hR: null,
  };
}

export function updateBlockedSetupTracking(botState, data = {}, now = new Date()) {
  if (!botState || typeof botState !== 'object') return null;
  const nowMs = now.getTime();
  const price = currentTelemetryPrice(data);
  const existing = Array.isArray(botState.blockedSetupTracking) ? botState.blockedSetupTracking : [];
  const updated = existing
    .map(setup => updateSetupExcursion(setup, price, nowMs))
    .filter(setup => nowMs - Number(setup.blockedSetupTimeMs || 0) <= 3 * 60 * 60 * 1000);

  const nextSetup = buildBlockedSetupFromLog(data, now);
  if (nextSetup) {
    updated.push(updateSetupExcursion(nextSetup, price, nowMs));
  }

  botState.blockedSetupTracking = updated.slice(-50);
  return botState.blockedSetupTracking.at(-1) ?? null;
}

function blockedSetupLogFields(setup) {
  return {
    blockedSetupId: setup?.blockedSetupId ?? null,
    blockedSetupTime: setup?.blockedSetupTime ?? null,
    blockedSetupDirection: setup?.blockedSetupDirection ?? null,
    blockedSetupPrice: finiteOrNull(setup?.blockedSetupPrice),
    blockedSetupReason: setup?.blockedSetupReason ?? null,
    blockedSetupMfe1hR: finiteOrNull(setup?.blockedSetupMfe1hR),
    blockedSetupMae1hR: finiteOrNull(setup?.blockedSetupMae1hR),
    blockedSetupMfe3hR: finiteOrNull(setup?.blockedSetupMfe3hR),
    blockedSetupMae3hR: finiteOrNull(setup?.blockedSetupMae3hR),
  };
}

function isSetupBlockedByRiskOrKillSwitch(log) {
  if (log.tradeExecuted === true) return false;
  const hasSetup = log.dbgSetupReady === true || log.signalDetected === 'BUY' || log.signalDetected === 'SELL';
  if (!hasSetup) return false;

  const reason = String(log.reason || '');
  return (
    reason.startsWith('STOP:') ||
    reason.startsWith('DISABLE:') ||
    reason.startsWith('PAUSE:') ||
    reason.includes('Bot disabled') ||
    reason.includes('risk') ||
    reason.includes('Risk') ||
    reason.includes('daily loss') ||
    reason.includes('drawdown') ||
    reason.includes('margin') ||
    reason.includes('Max 2 positions')
  );
}

function isBrokerError(log) {
  const reason = String(log.reason || '');
  return (
    reason.includes('BROKER_') ||
    reason.includes('Capital.com') ||
    reason.includes('broker stats') ||
    reason.includes('Broker stats') ||
    reason.includes('brokerResponse') ||
    reason.startsWith('ERROR:')
  );
}

async function appendCapped(redis, key, event, cap) {
  await redis.rpush(key, JSON.stringify(event));
  const len = await redis.llen(key);
  if (len > cap) {
    await redis.ltrim(key, len - cap, -1);
  }
}

async function appendPersistent(redis, key, event) {
  await redis.rpush(key, JSON.stringify(event));
}

async function persistAnalyticsEvents(redis, log) {
  const tradeEvents = [];
  const auditEvents = [];

  if (log.tradeExecuted === true) {
    tradeEvents.push({
      ...baseAnalyticsEvent(log, 'trade_opened'),
      ...tradeAnalyticsFields(log),
    });
  }

  if (log.exitAudit) {
    tradeEvents.push({
      ...baseAnalyticsEvent(log, 'trade_closed'),
      ...tradeAnalyticsFields(log, log.audit, log.exitAudit),
      fallbackUsed: log.fallbackUsed === true,
    });
  }

  if (log.stopMoveEvent) {
    auditEvents.push({
      ...baseAnalyticsEvent(log, 'stop_moved'),
      ...tradeAnalyticsFields(log),
      fromStop: finiteOrNull(log.stopMoveEvent.fromStop),
      toStop: finiteOrNull(log.stopMoveEvent.toStop),
      triggerR: finiteOrNull(log.stopMoveEvent.triggerR),
      lockedR: finiteOrNull(log.stopMoveEvent.lockedR),
      currentR: finiteOrNull(log.stopMoveEvent.currentR),
      stageKey: log.stopMoveEvent.stageKey ?? null,
      eventTs: log.stopMoveEvent.at ?? null,
    });
  }

  if (isSetupBlockedByRiskOrKillSwitch(log)) {
    auditEvents.push({
      ...baseAnalyticsEvent(log, 'setup_blocked'),
      score: finiteOrNull(log.score ?? log.dbgScore),
      setupConfidenceScore: finiteOrNull(log.setupConfidenceScore),
      initialRewardRisk: finiteOrNull(log.initialRewardRisk),
      executionQualityScore: finiteOrNull(log.executionQualityScore),
      spread: finiteOrNull(log.spread),
      atr: finiteOrNull(log.atr),
      trend1h: log.trend1h ?? null,
      dbgRejectReason: log.dbgRejectReason ?? null,
      dailyLoss: finiteOrNull(log.dailyLoss),
      totalDrawdown: finiteOrNull(log.totalDrawdown),
      openPositions: finiteOrNull(log.openPositions),
    });
  }

  if (log.brokerResponse) {
    auditEvents.push({
      ...baseAnalyticsEvent(log, 'broker_order_rejected'),
      errorCode: log.brokerResponse.errorCode ?? null,
      message: log.brokerResponse.message ?? null,
      dealReference: log.brokerResponse.dealReference ?? log.dealReference ?? null,
      stopLevel: log.brokerResponse.stopLevel ?? null,
    });
  } else if (isBrokerError(log)) {
    auditEvents.push({
      ...baseAnalyticsEvent(log, 'broker_error'),
    });
  }

  for (const event of tradeEvents) {
    await appendPersistent(redis, TRADE_HISTORY_KEY, event);
  }
  for (const event of auditEvents) {
    await appendCapped(redis, TRADE_AUDIT_EVENTS_KEY, event, TRADE_AUDIT_EVENT_CAP);
  }
}

export async function saveLog(data) {
  try {
    const redis = getRedis();
    const marketRegime = data.marketRegime ?? data.signalDebug?.marketRegime ?? data.indicators?.marketRegime ?? null;
    const now = new Date();
    const v2Diagnostics = buildV2Diagnostics(data, marketRegime, now);
    const blockedSetup = updateBlockedSetupTracking(data.botState, data, now);
    const delegationGap = data.delegationGap ?? buildDelegationGap({
      signal: data.signal,
      tradeExecuted: data.tradeExecuted,
      reason: data.reason,
      marketRegime,
      executionPolicy: data.executionPolicy ?? null,
    });
    const log = {
      // ── Identity ────────────────────────────────────────────────────────────
      tradeId:         data.signal?.id              || 'NO_SIGNAL',
      strategyVersion: data.signal?.strategyVersion || STRATEGY_VERSION,
      entryType:       data.signal?.entryType       || null, // 'crossover' or 'pullback'
      isRelaxedMode:   data.signal?.isRelaxedMode   ?? data.signalDebug?.isRelaxedMode ?? false,
      hoursSinceLastTrade: data.signal?.hoursSinceLastTrade ?? data.signalDebug?.hoursSinceLastTrade ?? null,

      // ── Timing (always store UTC; UAE shown for human readability) ──────────
      time:    now.toISOString(),
      timeUAE: now.toLocaleString('en-US', { timeZone: 'Asia/Dubai' }),

      // ── Decision ────────────────────────────────────────────────────────────
      signalDetected: data.signal?.action   || 'NONE',
      tradeExecuted:  data.tradeExecuted    || false,
      reason:         data.reason           || null,
      executionPolicy: data.executionPolicy  ?? null,
      marketRegime,
      delegationGap,
      ...v2Diagnostics,

      // ── Trade details (null if not executed) ────────────────────────────────
      // Use executed values when available so audits reflect what was actually sent/filled.
      entryPrice:    data.result?.entry        ?? data.signal?.entryPrice ?? null,
      stopLoss:      data.result?.stopLoss     ?? data.signal?.stopLoss   ?? null,
      takeProfit:    data.result?.takeProfit   ?? data.signal?.takeProfit ?? null,
      size:          data.result?.size         ?? null,
      dealId:        data.result?.dealId       ?? null,
      dealReference: data.result?.dealReference ?? null,
      intendedEntryPrice: data.result?.intendedEntryPrice ?? null,
      actualFillPrice:    data.result?.actualFillPrice    ?? null,
      absoluteSlippage:   data.result?.absoluteSlippage   ?? null,
      slippageToATR:      data.result?.slippageToATR      ?? null,
      fillQuality:        data.result?.fillQuality        ?? null,
      executionQualityScore: data.result?.executionQualityScore ?? data.signal?.executionQualityScore ?? null,
      executionQuality:      data.result?.executionQuality      ?? data.signal?.executionQuality      ?? null,
      takenTradeMfeR:        data.result?.exitAudit?.mfeR       ?? data.result?.audit?.mfeR ?? data.tradeAudit?.mfeR ?? null,
      takenTradeMaeR:        data.result?.exitAudit?.maeR       ?? data.result?.audit?.maeR ?? data.tradeAudit?.maeR ?? null,
      reached1R:             data.result?.exitAudit?.reached1R  ?? data.result?.audit?.reached1R ?? data.tradeAudit?.reached1R ?? false,
      reached1_5R:           data.result?.exitAudit?.reached1_5R ?? data.result?.audit?.reached1_5R ?? data.tradeAudit?.reached1_5R ?? false,
      reached2R:             data.result?.exitAudit?.reached2R  ?? data.result?.audit?.reached2R ?? data.tradeAudit?.reached2R ?? false,
      reached2_5R:           data.result?.exitAudit?.reached2_5R ?? data.result?.audit?.reached2_5R ?? data.tradeAudit?.reached2_5R ?? false,
      ...blockedSetupLogFields(blockedSetup),

      // ── Leverage & margin telemetry (populated on executed trades) ──────────
      // actualRiskDollars: real $ at risk based on size × stopDistance
      // dollarExposure:    total notional value = size × entryPrice
      // marginUsed:        margin Capital.com holds = notional × 5%
      // leverage:          leverage applied (always 20 for GOLD retail)
      actualRiskDollars: data.result?.actualRiskDollars ?? null,
      dollarExposure:    data.result?.notionalValue     ?? null,
      marginUsed:        data.result?.marginRequired    ?? null,
      leverage:          data.result?.leverage          ?? null,

      // ── Indicators (null if indicators were skipped) ─────────────────────────
      ema20:      data.indicators?.currEMA20    ?? null,
      ema50:      data.indicators?.currEMA50    ?? null,
      emaSlope:   data.indicators?.slopePercent ?? null,
      atr:        data.indicators?.atr          ?? null,
      atrAverage: data.indicators?.atrAverage   ?? null,
      rsi:        data.indicators?.rsi          ?? null,
      score:      data.signal?.score            ?? null,
      setupConfidenceScore: data.signal?.setupConfidenceScore ?? data.signal?.setupConfidence?.score ?? null,
      setupConfidence:      data.signal?.setupConfidence      ?? null,
      setupQuality:         data.signal?.setupQuality         ?? null,
      initialRewardRisk:    data.signal?.initialRewardRisk    ?? null,
      expectancyKillReset:  data.signal?.expectancyKillReset  ?? null,
      resistance: data.indicators?.resistance   ?? null,
      support:    data.indicators?.support      ?? null,
      trend1h:    data.indicators?.trend1h      ?? null,
      trendReason: data.indicators?.trendReason ?? null,
      spread:     data.indicators?.spread       ?? null,
      goldPrice:  data.indicators?.lastCandle?.close ?? null,

      // ── Risk state at time of decision ──────────────────────────────────────
      // Use ?? (not ||) so that 0 values are preserved correctly.
      balance:       data.botState?.balance              ?? null,
      equity:        data.botState?.equity               ?? null, // Decoupled for real-time risk tracking
      dailyTrades:   data.botState?.dailyTrades          ?? null,
      dailyLoss:     data.botState?.dailyLoss            ?? null,
      openPositions: data.botState?.openTrades?.length   ?? 0,
      totalDrawdown: data.botState?.totalDrawdown        ?? null,
      integrityOk:   data.botState?.stateIntegrityOk     ?? true,
      currentCycleTime: data.botState?.currentCycleTime   ?? null,
      lastValidDataTime: data.botState?.lastValidDataTime ?? null,
      dataFreshnessStatus: data.botState?.dataFreshnessStatus ?? null,
      chartUpdatedThisCycle: data.botState?.chartUpdatedThisCycle ?? false,
      schedulerSource: data.botState?.schedulerSource ?? 'unknown',
      currentCycleReason: data.botState?.currentCycleReason ?? null,

      // ── Strategy debug (logged every cycle for signal diagnosis) ─────────────
      dbgCurrE20:          data.signalDebug?.dbgCurrE20          ?? null,
      dbgCurrE50:          data.signalDebug?.dbgCurrE50          ?? null,
      dbgPrevE20:          data.signalDebug?.dbgPrevE20          ?? null,
      dbgPrevE50:          data.signalDebug?.dbgPrevE50          ?? null,
      dbgEmaSeparation:    data.signalDebug?.dbgEmaSeparation    ?? null,
      dbgDistToEMA20:      data.signalDebug?.dbgDistToEMA20      ?? null,
      dbgCrossoverChecked: data.signalDebug?.dbgCrossoverChecked ?? null,
      dbgBuyCrossover:     data.signalDebug?.dbgBuyCrossover     ?? null,
      dbgSellCrossover:    data.signalDebug?.dbgSellCrossover    ?? null,
      dbgPullbackChecked:  data.signalDebug?.dbgPullbackChecked  ?? null,
      dbgAction:           data.signalDebug?.dbgAction           ?? null,
      dbgEntryType:        data.signalDebug?.dbgEntryType        ?? null,
      dbgScore:            data.signalDebug?.dbgScore            ?? null,
      dbgSetupConfidenceScore: data.signalDebug?.dbgSetupConfidenceScore ?? null,
      dbgRawSetupConfidenceScore: data.signalDebug?.dbgRawSetupConfidenceScore ?? null,
      dbgTrendConflict:    data.signalDebug?.dbgTrendConflict    ?? data.signal?.trendConflict ?? false,
      dbgTrendConflictPenalty: data.signalDebug?.dbgTrendConflictPenalty ?? data.signal?.trendConflictPenalty ?? null,
      dbgPenaltyReason:    data.signalDebug?.dbgPenaltyReason    ?? data.signal?.setupConfidence?.penaltyReason ?? null,
      dbgInitialRewardRisk: data.signalDebug?.dbgInitialRewardRisk ?? null,
      dbgPullbackReason:   data.signalDebug?.dbgPullbackReason   ?? null,
      dbgSetupReady:       data.signalDebug?.dbgSetupReady       ?? false,
      dbgRejectReason:     data.signalDebug?.dbgRejectReason     ?? null,
      dbg1mMomentumNet:    data.signalDebug?.dbg1mMomentumNet    ?? null,

      // ── Sync / fallback resolution flag ──────────────────────────────────────
      // true when a trade was force-closed after the sync window expired without
      // a matching transaction history record (FALLBACK_RESOLUTION_USED).
      fallbackUsed: data.result?.fallbackUsed ?? false,
      audit: data.result?.audit ?? data.tradeAudit ?? null,
      exitAudit: data.result?.exitAudit ?? null,
      stopMoveEvent: data.result?.stopMoveEvent ?? null,

      // ── Broker rejection details (populated when tradeExecuted = false and broker returned an error) ──
      brokerResponse: data.brokerResponse ?? null,
    };

    // Atomic append using Redis list — no read/write race condition
    await redis.rpush('trade_logs_list', JSON.stringify(log));
    // Keep enough recent cycle logs for multi-day audits without changing trading behavior.
    const len = await redis.llen('trade_logs_list');

    if (len > CYCLE_LOG_RETENTION_LIMIT) {
      await redis.ltrim('trade_logs_list', len - CYCLE_LOG_RETENTION_LIMIT, -1);
    }

    await persistAnalyticsEvents(redis, log).catch(err => {
      console.error('persistAnalyticsEvents error:', err.message);
    });

    return log;

  } catch (err) {
    console.error('saveLog error:', err.message);
  }
}

export async function getLogs(limit = 0) {
  try {
    const redis = getRedis();
    const startIdx = limit > 0 ? -limit : 0;
    const raw = await redis.lrange('trade_logs_list', startIdx, -1);
    if (!Array.isArray(raw)) return [];
    return raw.map(entry => {
      if (typeof entry === 'string') {
        try { return normalizeLogDiagnostics(JSON.parse(entry)); } catch { return entry; }
      }
      return normalizeLogDiagnostics(entry); 
    });
  } catch (err) {
    console.error('getLogs error:', err.message);
    return [];
  }
}

export async function getTradeHistory(limit = 0) {
  try {
    const redis = getRedis();
    const startIdx = limit > 0 ? -limit : 0;
    const raw = await redis.lrange(TRADE_HISTORY_KEY, startIdx, -1);
    if (!Array.isArray(raw)) return [];
    return raw.map(entry => {
      if (typeof entry === 'string') {
        try { return JSON.parse(entry); } catch { return entry; }
      }
      return entry;
    });
  } catch (err) {
    console.error('getTradeHistory error:', err.message);
    return [];
  }
}
