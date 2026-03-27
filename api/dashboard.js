// api/dashboard.js — Returns state + logs + stats together for the dashboard frontend.
// Single endpoint so dashboard makes one request instead of two.

import { loadState }            from '../lib/state.js';
import { getLogs }              from '../lib/logger.js';
import { computeSessionStats } from '../lib/stats.js';
import { Redis }                from '@upstash/redis';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  try {
    const [state, logs, lastAudit] = await Promise.all([
      loadState(),
      getLogs(),
      redis.get('last_audit').catch(() => null),
    ]);

    // Compute session stats server-side (single source of truth)
    // Pass broker stats from botState so trade metrics come from Capital.com
    const stats = computeSessionStats(logs, state);

    return res.json({
      state,
      logs,
      stats,
      lastAudit: lastAudit || null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
