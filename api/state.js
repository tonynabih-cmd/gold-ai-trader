// api/state.js — API route that returns current bot state.
// Used by the dashboard to display balance, open trades, daily stats, etc.

import { loadState } from '../lib/state.js';
import { saveState } from '../lib/state.js';
import { buildKillSwitchDiagnostics, repairExpiredKillSwitch } from '../lib/kill_switch.js';

export default async function handler(req, res) {
  try {
    const nowMs = Date.now();
    const state = await loadState();
    const repair = repairExpiredKillSwitch(state, nowMs);
    if (repair.repaired) {
      await saveState(state);
    }
    const diagnostics = buildKillSwitchDiagnostics(state, nowMs);
    return res.json({
      ...state,
      ...diagnostics,
      killSwitchRepairedThisRequest: repair.repaired,
      killSwitchRepairReason: repair.reason,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
