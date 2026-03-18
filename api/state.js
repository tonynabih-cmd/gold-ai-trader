import { loadState } from '../lib/state.js';

export default async function handler(req, res) {
  const state = await loadState();
  return res.json(state);
}