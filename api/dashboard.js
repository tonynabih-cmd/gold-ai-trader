// api/dashboard.js — Returns state + logs together for the dashboard frontend.
// Single endpoint so dashboard makes one request instead of two.
/* global process */

import { loadState } from '../lib/state.js';
import { getLogs }   from '../lib/logger.js';
import { latestStrategyVersionFromLogs } from '../lib/daily_audit.js';
import { Redis }     from '@upstash/redis';

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
    const [state, logs, dailyAuditHistory, legacyLastAudit] = await Promise.all([
      loadState(),
      getLogs(),
      getDailyAuditHistory(),
      redis.get('last_audit').catch(() => null),
    ]);

    const normalizedDailyAuditHistory = normalizeAuditVersions(dailyAuditHistory, logs);
    const normalizedLegacyLastAudit = legacyLastAudit
      ? normalizeAuditVersions([legacyLastAudit], logs)[0]
      : null;
    const lastAudit = normalizedDailyAuditHistory[0] || normalizedLegacyLastAudit || null;

    return res.json({
      state,
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
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
