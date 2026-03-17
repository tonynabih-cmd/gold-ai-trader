import { loadState } from './state.js';
import { getLogs } from './logger.js';

export default async function handler(req, res) {
  try {
    const [state, logs] = await Promise.all([
      loadState(),
      getLogs()
    ]);
    return res.json({ state, logs });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
