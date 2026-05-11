export const KILL_SWITCH_POLICY = Object.freeze({
  expiryHours: 24,
  expiryMs: 24 * 60 * 60 * 1000,
});

function parseNumericTimestampMs(value, nowMs) {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value < 1e12) {
    const secondsAsMs = value * 1000;
    return secondsAsMs <= nowMs + (48 * 60 * 60 * 1000) ? secondsAsMs : null;
  }
  return value;
}

export function parseActivatedAtMs(rawActivatedAt, nowMs = Date.now()) {
  if (rawActivatedAt == null) return null;

  if (typeof rawActivatedAt === 'number') {
    return parseNumericTimestampMs(rawActivatedAt, nowMs);
  }

  if (typeof rawActivatedAt === 'string') {
    const trimmed = rawActivatedAt.trim();
    if (!trimmed) return null;

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return parseNumericTimestampMs(numeric, nowMs);
    }

    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

export function getKillSwitchHoursSinceActivation(expectancyKillSwitch, nowMs = Date.now()) {
  if (!expectancyKillSwitch || expectancyKillSwitch.active !== true) return null;
  const activatedAtMs = parseActivatedAtMs(expectancyKillSwitch.activatedAt, nowMs);
  if (!Number.isFinite(activatedAtMs)) return null;
  const ageMs = Math.max(0, nowMs - activatedAtMs);
  return Number((ageMs / (60 * 60 * 1000)).toFixed(4));
}

export function repairExpiredKillSwitch(botState, nowMs = Date.now()) {
  if (!botState || typeof botState !== 'object') {
    return { repaired: false, reason: 'NO_BOT_STATE', hoursSinceActivation: null };
  }

  const expectancyKill = botState.expectancyKillSwitch;
  if (!expectancyKill || typeof expectancyKill !== 'object' || expectancyKill.active !== true) {
    return { repaired: false, reason: 'NOT_ACTIVE', hoursSinceActivation: null };
  }

  const activatedAtMs = parseActivatedAtMs(expectancyKill.activatedAt, nowMs);
  const beforeActive = expectancyKill.active === true;
  const beforeActivatedAt = expectancyKill.activatedAt ?? null;
  const hoursSinceActivation = Number.isFinite(activatedAtMs)
    ? Number(((nowMs - activatedAtMs) / (60 * 60 * 1000)).toFixed(4))
    : null;

  let resetReason = null;
  if (!Number.isFinite(activatedAtMs)) {
    resetReason = 'INVALID_ACTIVATED_AT_REPAIRED';
  } else if ((nowMs - activatedAtMs) >= KILL_SWITCH_POLICY.expiryMs) {
    resetReason = '24H_EXPIRED';
  }

  if (!resetReason) {
    return {
      repaired: false,
      reason: 'NOT_EXPIRED',
      hoursSinceActivation,
      before: {
        active: beforeActive,
        activatedAt: beforeActivatedAt,
      },
      after: {
        active: expectancyKill.active === true,
        resetReason: expectancyKill.resetReason ?? null,
      },
    };
  }

  expectancyKill.active = false;
  expectancyKill.mode = null;
  expectancyKill.activationTrend = null;
  expectancyKill.resetReason = resetReason;
  expectancyKill.resetAt = new Date(nowMs).toISOString();
  expectancyKill.lastExpiredWindowKey = expectancyKill.windowKey || expectancyKill.lastExpiredWindowKey || null;
  expectancyKill.suppressedWindowKey = expectancyKill.windowKey || expectancyKill.suppressedWindowKey || null;
  expectancyKill.activatedAt = 0;
  if (typeof botState.currentCycleReason === 'string' && botState.currentCycleReason.toLowerCase().includes('kill')) {
    botState.currentCycleReason = '';
  }

  return {
    repaired: true,
    reason: resetReason,
    hoursSinceActivation,
    before: {
      active: beforeActive,
      activatedAt: beforeActivatedAt,
    },
    after: {
      active: expectancyKill.active === true,
      resetReason: expectancyKill.resetReason ?? null,
    },
  };
}

export function buildKillSwitchDiagnostics(botState, nowMs = Date.now()) {
  const expectancyKill = botState?.expectancyKillSwitch && typeof botState.expectancyKillSwitch === 'object'
    ? botState.expectancyKillSwitch
    : {};
  return {
    expectancyKillSwitch: {
      active: expectancyKill.active === true,
      activatedAt: expectancyKill.activatedAt ?? null,
      resetReason: expectancyKill.resetReason ?? null,
      resetAt: expectancyKill.resetAt ?? null,
      suppressedWindowKey: expectancyKill.suppressedWindowKey ?? null,
      lastExpiredWindowKey: expectancyKill.lastExpiredWindowKey ?? null,
      mode: expectancyKill.mode ?? null,
      windowKey: expectancyKill.windowKey ?? null,
      hoursSinceActivation: getKillSwitchHoursSinceActivation(expectancyKill, nowMs),
    },
    killSwitchPolicy: {
      expiryHours: KILL_SWITCH_POLICY.expiryHours,
      expiryMs: KILL_SWITCH_POLICY.expiryMs,
    },
    productionDeploymentVersion: process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || process.env.VERCEL_URL || null,
  };
}
