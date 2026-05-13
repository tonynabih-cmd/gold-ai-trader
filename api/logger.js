// api/logger.js — API route that returns all trade logs.
// Used by the dashboard to display the trade log table.

import { getTradeHistory, getLogsWithDebug, CYCLE_LOG_PRIMARY_KEY } from '../lib/logger.js';

export default async function handler(req, res) {
  try {
    const limit = Number.parseInt(req.query?.limit ?? '0', 10) || 0;
    const type = String(req.query?.type ?? 'cycle_logs');
    const debugMode = String(req.query?.debug ?? '0') === '1';

    if (type === 'trade_history') {
      const history = await getTradeHistory(limit);
      if (debugMode) {
        return res.json({
          type,
          keyUsed: 'trade_history',
          count: Array.isArray(history) ? history.length : 0,
          latest: Array.isArray(history) && history.length ? history[history.length - 1] : null,
          redisConnected: true,
          data: Array.isArray(history) ? history : [],
        });
      }
      return res.json(history);
    }

    const preferredKey = type && type !== 'cycle_logs' ? type : null;
    const payload = await getLogsWithDebug(limit, { preferredKey });
    if (debugMode) {
      return res.json({
        type,
        keyUsed: payload.keyUsed || CYCLE_LOG_PRIMARY_KEY,
        count: payload.count || 0,
        latest: payload.latest || null,
        redisConnected: payload.redisConnected !== false,
        data: payload.logs || [],
      });
    }
    return res.json(payload.logs || []);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
