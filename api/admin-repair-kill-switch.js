import { loadState, saveState } from '../lib/state.js';
import { KILL_SWITCH_POLICY, parseActivatedAtMs, repairExpiredKillSwitch } from '../lib/kill_switch.js';

function resolveToken(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  if (typeof req.query?.secret === 'string') return req.query.secret;
  if (typeof req.body?.secret === 'string') return req.body.secret;
  return '';
}

function isAuthorized(token) {
  if (!token) return false;
  const cronSecret = process.env.CRON_SECRET;
  const adminSecret = process.env.ADMIN_SECRET || process.env.ADMIN_API_SECRET;
  return token === cronSecret || (adminSecret && token === adminSecret);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed. Use POST.' });
  }

  const token = resolveToken(req);
  if (!isAuthorized(token)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  }

  const nowMs = Date.now();
  const nowUTC = new Date(nowMs).toISOString();

  const state = await loadState();
  const beforeKill = state?.expectancyKillSwitch && typeof state.expectancyKillSwitch === 'object'
    ? state.expectancyKillSwitch
    : {};
  const beforeActivatedAt = beforeKill.activatedAt ?? null;
  const beforeActivatedAtMs = parseActivatedAtMs(beforeActivatedAt, nowMs);
  const beforeHours = Number.isFinite(beforeActivatedAtMs)
    ? Number(((nowMs - beforeActivatedAtMs) / (60 * 60 * 1000)).toFixed(4))
    : null;

  const repair = repairExpiredKillSwitch(state, nowMs);
  if (repair.repaired) {
    await saveState(state);
  }

  const afterKill = state?.expectancyKillSwitch && typeof state.expectancyKillSwitch === 'object'
    ? state.expectancyKillSwitch
    : {};

  return res.json({
    ok: true,
    repaired: repair.repaired,
    nowUTC,
    killSwitchPolicy: {
      expiryHours: KILL_SWITCH_POLICY.expiryHours,
      expiryMs: KILL_SWITCH_POLICY.expiryMs,
    },
    before: {
      active: beforeKill.active === true,
      activatedAt: beforeActivatedAt,
      hoursSinceActivation: beforeHours,
    },
    after: {
      active: afterKill.active === true,
      resetReason: afterKill.resetReason ?? null,
    },
  });
}
