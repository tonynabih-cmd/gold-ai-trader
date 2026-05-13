// api/dashboard.js — Returns state + logs together for the dashboard frontend.
// Single endpoint so dashboard makes one request instead of two.
/* global process */

import { loadState } from '../lib/state.js';
import { saveState } from '../lib/state.js';
import { BOT_STATE_KEY } from '../lib/state.js';
import { getLogsWithDebug, CYCLE_LOG_PRIMARY_KEY }   from '../lib/logger.js';
import { latestStrategyVersionFromLogs } from '../lib/daily_audit.js';
import { Redis }     from '@upstash/redis';
import { buildKillSwitchDiagnostics, repairExpiredKillSwitch } from '../lib/kill_switch.js';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const DAILY_AUDIT_HISTORY_KEY = 'daily_audit_history';

function parseAuditRecord(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function auditSortTime(audit) {
  const candidates = [audit?.generatedAt, audit?.ts, audit?.date];
  for (const candidate of candidates) {
    const time = candidate ? new Date(candidate).getTime() : NaN;
    if (Number.isFinite(time)) return time;
  }
  return 0;
}

function sortAuditsNewestFirst(audits) {
  return [...audits].sort((a, b) => auditSortTime(b) - auditSortTime(a));
}

function normalizeAuditVersions(audits, logs) {
  const latestVersion = latestStrategyVersionFromLogs(logs);
  return audits.map(audit => ({
    ...audit,
    strategyVersion: latestVersion,
  }));
}

async function getDailyAuditHistory() {
  const rawHistory = await redis.lrange(DAILY_AUDIT_HISTORY_KEY, 0, -1).catch(() => []);
  return sortAuditsNewestFirst(
    (Array.isArray(rawHistory) ? rawHistory : [])
      .map(parseAuditRecord)
      .filter(Boolean)
  );
}

export default async function handler(req, res) {
  try {
    const nowMs = Date.now();
    const [state, logPayload, dailyAuditHistory, legacyLastAudit] = await Promise.all([
      loadState(),
      getLogsWithDebug(),
      getDailyAuditHistory(),
      redis.get('last_audit').catch(() => null),
    ]);
    const logs = Array.isArray(logPayload?.logs) ? logPayload.logs : [];
    const repair = repairExpiredKillSwitch(state, nowMs);
    if (repair.repaired) {
      await saveState(state);
    }
    const killSwitchDiagnostics = buildKillSwitchDiagnostics(state, nowMs);

    const normalizedDailyAuditHistory = normalizeAuditVersions(dailyAuditHistory, logs);
    const normalizedLegacyLastAudit = legacyLastAudit
      ? normalizeAuditVersions([legacyLastAudit], logs)[0]
      : null;
    const lastAudit = normalizedDailyAuditHistory[0] || normalizedLegacyLastAudit || null;
    const latestLog = logs.length ? logs[logs.length - 1] : null;
    const inferredDecisionReason = state?.currentCycleReason || (state?.botEnabled === false ? 'Bot disabled via state' : null);
    const inferredDecisionTime = Number(state?.currentCycleTime) > 0
      ? state.currentCycleTime
      : (Number(state?.lastHeartbeat) > 0 ? state.lastHeartbeat : null);
    const lastDecisionSource = latestLog
      ? 'logs'
      : inferredDecisionReason || inferredDecisionTime
        ? 'state'
        : 'none';
    const lastLogTime = latestLog?.time || null;

    return res.json({
      state,
      killSwitchDiagnostics,
      killSwitchRepairedThisRequest: repair.repaired,
      logs,
      lastAudit,
      dailyAuditHistory: normalizedDailyAuditHistory,
      env:       process.env.CAPITAL_ENV || 'demo',
      dashboardMeta: {
        currentCycleTime: state.currentCycleTime ?? null,
        lastValidDataTime: state.lastValidDataTime ?? null,
        dataFreshnessStatus: state.dataFreshnessStatus ?? 'UNKNOWN',
        chartUpdatedThisCycle: state.chartUpdatedThisCycle === true,
        schedulerSource: state.schedulerSource ?? 'unknown',
        fallbackLastDecision: latestLog
          ? null
          : {
              signalDetected: 'NONE',
              tradeExecuted: false,
              reason: inferredDecisionReason ?? null,
              time: inferredDecisionTime ? new Date(inferredDecisionTime).toISOString() : null,
              currentCycleTime: inferredDecisionTime,
              lastValidDataTime: state.lastValidDataTime ?? null,
              dataFreshnessStatus: state.dataFreshnessStatus ?? 'UNKNOWN',
              chartUpdatedThisCycle: state.chartUpdatedThisCycle === true,
              schedulerSource: state.schedulerSource ?? 'unknown',
              sessionName: null,
              isAllowedSession: null,
              sessionRejectReason: null,
              ema20: null,
              ema50: null,
              atr: null,
              atrAverage: null,
              trend1h: null,
            },
      },
      loggerKeyUsed: logPayload?.keyUsed || CYCLE_LOG_PRIMARY_KEY,
      loggerCount: logPayload?.count ?? logs.length,
      stateKeyUsed: BOT_STATE_KEY,
      hasState: Boolean(state && typeof state === 'object'),
      lastDecisionSource,
      lastLogTime,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
