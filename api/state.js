// api/state.js — API route that returns current bot state.
// Used by the dashboard to display balance, open trades, daily stats, etc.

import { loadState } from '../lib/state.js';

export default async function handler(req, res) {
  try {
    const state = await loadState();
    return res.json(state);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
