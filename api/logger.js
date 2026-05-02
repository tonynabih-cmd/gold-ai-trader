// api/logger.js — API route that returns all trade logs.
// Used by the dashboard to display the trade log table.

import { getLogs, getTradeHistory } from '../lib/logger.js';

export default async function handler(req, res) {
  try {
    const limit = Number.parseInt(req.query?.limit ?? '0', 10) || 0;
    const type = String(req.query?.type ?? 'cycle_logs');
    const logs = type === 'trade_history'
      ? await getTradeHistory(limit)
      : await getLogs(limit);
    return res.json(logs);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
