// api/dashboard.js — Returns state + logs together for the dashboard frontend.
// Single endpoint so dashboard makes one request instead of two.

import { loadState } from '../lib/state.js';
import { getLogs }   from '../lib/logger.js';
import { Redis }     from '@upstash/redis';

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

    return res.json({
      state,
      logs,
      lastAudit: lastAudit || null,
      env:       process.env.CAPITAL_ENV || 'demo',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
