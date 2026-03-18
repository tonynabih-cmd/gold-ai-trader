import { getLogs } from '../lib/logger.js';

export default async function handler(req, res) {
  const logs = await getLogs();
  return res.json(logs);
}