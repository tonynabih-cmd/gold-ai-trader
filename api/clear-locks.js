// api/clear-locks.js — HTTP endpoint to clear stuck Redis candle locks.
//
// POST /api/clear-locks
// Header: Authorization: Bearer <CRON_SECRET>
//
// Returns JSON:
//   { ok: true, cleared: number, keys: string[], redisOk: true }
//   { ok: false, error: string }

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed. Use POST.' });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(500).json({ ok: false, error: 'CRON_SECRET not configured on server.' });
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (token !== cronSecret) {
    return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  }

  // ── Redis health check ────────────────────────────────────────────────────
  try {
    await redis.ping();
  } catch (err) {
    return res.status(503).json({ ok: false, error: `Redis unreachable: ${err.message}` });
  }

  // ── Scan for candle lock keys ─────────────────────────────────────────────
  let cursor = 0;
  const lockKeys = [];

  try {
    do {
      const [nextCursor, keys] = await redis.scan(cursor, { match: 'lock:candle:*', count: 100 });
      cursor = Number(nextCursor);
      lockKeys.push(...keys);
    } while (cursor !== 0);
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Scan failed: ${err.message}` });
  }

  if (lockKeys.length === 0) {
    return res.json({ ok: true, cleared: 0, keys: [], redisOk: true, message: 'No stuck locks found.' });
  }

  // ── Delete all found lock keys ────────────────────────────────────────────
  const cleared = [];
  const alreadyGone = [];

  for (const key of lockKeys) {
    try {
      const deleted = await redis.del(key);
      if (deleted) {
        cleared.push(key);
      } else {
        alreadyGone.push(key);
      }
    } catch (err) {
      return res.status(500).json({ ok: false, error: `Failed to delete ${key}: ${err.message}` });
    }
  }

  return res.json({
    ok: true,
    cleared: cleared.length,
    keys: cleared,
    alreadyExpired: alreadyGone,
    redisOk: true,
    message: `Cleared ${cleared.length} lock(s). Bot will process normally on next cron invocation.`,
  });
}
