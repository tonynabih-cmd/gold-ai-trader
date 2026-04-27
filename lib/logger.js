// logger.js — Save every bot decision to Upstash KV, including all skips.
// Every single cron invocation is logged — this is the source of truth for audit and analysis.

import { Redis } from '@upstash/redis';
import { STRATEGY_VERSION } from './strategy.js';

const TRADE_HISTORY_KEY = 'trade_history';
const TRADE_AUDIT_EVENTS_KEY = 'trade_audit_events';
const ANALYTICS_EVENT_CAP = 5000;

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

function milestoneFlags(source) {
  return {
    reached1R: source?.reached1R === true,
    reached1_2R: source?.reached1_2R === true,
    reached1_5R: source?.reached1_5R === true,
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
    exitReasonClass: exitSource?.exitReasonClass ?? null,
    ...milestoneFlags(exitSource ?? auditSource),
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

async function appendCapped(redis, key, event, cap = ANALYTICS_EVENT_CAP) {
  await redis.rpush(key, JSON.stringify(event));
  const len = await redis.llen(key);
  if (len > cap) {
    await redis.ltrim(key, len - cap, -1);
  }
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
    await appendCapped(redis, TRADE_HISTORY_KEY, event);
  }
  for (const event of auditEvents) {
    await appendCapped(redis, TRADE_AUDIT_EVENTS_KEY, event);
  }
}

export async function saveLog(data) {
  try {
    const redis = getRedis();
    const log = {
      // ── Identity ────────────────────────────────────────────────────────────
      tradeId:         data.signal?.id              || 'NO_SIGNAL',
      strategyVersion: data.signal?.strategyVersion || STRATEGY_VERSION,
      entryType:       data.signal?.entryType       || null, // 'crossover' or 'pullback'
      isRelaxedMode:   data.signal?.isRelaxedMode   ?? data.signalDebug?.isRelaxedMode ?? false,
      hoursSinceLastTrade: data.signal?.hoursSinceLastTrade ?? data.signalDebug?.hoursSinceLastTrade ?? null,

      // ── Timing (always store UTC; UAE shown for human readability) ──────────
      time:    new Date().toISOString(),
      timeUAE: new Date().toLocaleString('en-US', { timeZone: 'Asia/Dubai' }),

      // ── Decision ────────────────────────────────────────────────────────────
      signalDetected: data.signal?.action   || 'NONE',
      tradeExecuted:  data.tradeExecuted    || false,
      reason:         data.reason           || null,

      // ── Trade details (null if not executed) ────────────────────────────────
      // Use executed values when available so audits reflect what was actually sent/filled.
      entryPrice:    data.result?.entry        ?? data.signal?.entryPrice ?? null,
      stopLoss:      data.result?.stopLoss     ?? data.signal?.stopLoss   ?? null,
      takeProfit:    data.result?.takeProfit   ?? data.signal?.takeProfit ?? null,
      size:          data.result?.size         ?? null,
      dealId:        data.result?.dealId       ?? null,
      dealReference: data.result?.dealReference ?? null,

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
    // Keep last 1000 logs
    const len = await redis.llen('trade_logs_list');

    if (len > 1000) {
      await redis.ltrim('trade_logs_list', len - 1000, -1);
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
        try { return JSON.parse(entry); } catch { return entry; }
      }
      return entry; 
    });
  } catch (err) {
    console.error('getLogs error:', err.message);
    return [];
  }
}
