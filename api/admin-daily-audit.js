// Protected daily audit backfill endpoint.
//
// POST /api/admin-daily-audit
// Header: Authorization: Bearer <CRON_SECRET>

/* global process */

import { getLogs } from '../lib/logger.js';
import { loadState, saveAudit } from '../lib/state.js';
import { buildDailyAuditFromLogs, getUaeDateString } from '../lib/daily_audit.js';

function requireAdminPost(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed. Use POST.' });
    return false;
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    res.status(500).json({ ok: false, error: 'CRON_SECRET not configured on server.' });
    return false;
  }

  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = String(authHeader).startsWith('Bearer ') ? String(authHeader).slice(7) : '';
  if (token !== cronSecret) {
    res.status(401).json({ ok: false, error: 'Unauthorized.' });
    return false;
  }

  return true;
}

export default async function handler(req, res) {
  if (!requireAdminPost(req, res)) return;

  try {
    const date = getUaeDateString();
    const [logs, state] = await Promise.all([
      getLogs(),
      loadState(),
    ]);

    const { audit, dayLogsCount } = buildDailyAuditFromLogs(logs, state, { date });
    const saved = await saveAudit({
      ...audit,
      schedulerSource: audit.schedulerSource || 'admin-backfill',
      generatedBy: 'admin-daily-audit',
    });

    if (!saved) {
      return res.status(500).json({
        ok: false,
        date,
        error: 'Failed to save daily audit.',
      });
    }

    return res.json({
      ok: true,
      date,
      message: `Daily audit generated for UAE date ${date}. Existing audit for that date was replaced if present.`,
      dayLogsCount,
      audit: {
        date: audit.date,
        totalDecisions: audit.totalDecisions,
        tradesExecuted: audit.tradesExecuted,
        setups: audit.setups,
        totalRejects: audit.totalRejects,
        brokerErrors: audit.brokerErrors,
        profitFactor: audit.profitFactor,
        conclusion: audit.conclusion,
        anomalies: audit.anomalies,
        generatedAt: audit.generatedAt,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
