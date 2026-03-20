// api/logger.js — API route that returns all trade logs.
// Used by the dashboard to display the trade log table.

import { getLogs } from '../lib/logger.js';

export default async function handler(req, res) {
  try {
    const logs = await getLogs();
    return res.json(logs);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
