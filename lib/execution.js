// execution.js — Place and track orders on Capital.com.
// Session is created once in cron.js and passed in — no extra auth calls here.
// Only runs after risk.js returns 'APPROVED'.
//
// ── CFD SIZING MODEL (Capital.com GOLD) ──────────────────────────────────────
// Instrument : GOLD (XAU/USD CFD)
// Unit       : troy ounces (oz) — size field in the API is in oz
// Min size   : 0.01 oz
// Max leverage (retail): 20:1  →  margin rate = 5% of notional value
// Notional   : size (oz) × current price (USD/oz)
// Margin req : notional × 0.05
//
// P&L per $1 move in gold = size (oz) × $1 → e.g. 0.01 oz → $0.01/dollar move in gold
//
// RISK FORMULA (leverage-aware):
//   actualRiskDollars = size × stopDistance          (size in oz, stopDistance in $/oz)
//   This is independent of leverage — leverage only affects margin, NOT P&L per dollar.
//   So the old formula IS correct for P&L risk:
//     size = riskAmount / stopDistance
//   Leverage matters for: how much margin Capital.com holds from your balance.
//
// HARD CAPS (CRITICAL FINANCIAL SAFETY):
//   MAX single-trade risk = 2% of live balance — scales at any account size
//   MAX position size     = 1.0 oz
//   MIN position size     = 0.01 oz (Capital.com minimum)
//   MIN stop distance     = $0.50 (prevents gigantic positions from tiny stops)
//   Margin buffer         = available margin must be ≥ required margin × 1.5 (50% buffer)

import { fetchWithTimeout, withRetries } from './fetch.js';
import { saveStateCritical } from './state.js';
import { getAdaptiveSpreadLimit } from './risk.js';
import { randomUUID, createHash } from 'node:crypto';
import { STRATEGY_VERSION } from './strategy.js';

// ── Sync window: how long to wait for Capital.com history to appear after closure ──
// Exported so reconcilePositions (api/cron.js) and verifyExecutionCertainty use
// the same threshold, preventing the "missingCount mismatch" skip-loop bug.
export const SYNC_WINDOW_MS = 8 * 60 * 1000; // 8 minutes

// GOLD CFD Constants
const GOLD_MARGIN_RATE  = 0.05;   // 5% margin for retail (20:1 leverage)
const GOLD_LEVERAGE     = 20;     // Max retail leverage
const MIN_SIZE          = 0.01;   // Capital.com minimum lot size for GOLD (oz)
const MAX_SIZE          = 1.0;    // Hard cap: max oz per trade
const RISK_PCT          = 0.02;   // Target risk per trade as % of balance (2.0%)
const MAX_RISK_PCT      = 0.03;   // Hard cap: max risk per trade as % of balance (3%)
const MIN_STOP_DISTANCE = 0.50;   // Minimum stop distance in $/oz
const MARGIN_BUFFER     = 1.5;    // Must have 1.5× required margin available
const EXECUTION_STOP_LOSS_ATR_MULTIPLIER = 1.5;   // sync with strategy modeling (1.5x ATR)
const MIN_REWARD_R_MULTIPLE = 1.8;
const EXECUTION_TAKE_PROFIT_ATR_MULTIPLIER = EXECUTION_STOP_LOSS_ATR_MULTIPLIER * MIN_REWARD_R_MULTIPLE;
const MAX_STOP_ATR_RATIO = 2.5;                    // Skip trade if broker min stop distance exceeds this multiple of ATR
const MAX_SLIPPAGE_BASE = 4.00;                   // Conservative base slippage tolerance for low-ATR conditions
const MAX_SIGNAL_AGE_MS = 75 * 1000;
const MIN_EXECUTION_QUALITY_SCORE = 70;
const DEBUG_SYNC_RECON = process.env.DEBUG_SYNC_RECON === 'true';
const PRICE_DECIMALS = 2;
const PROFIT_LOCK_STAGES = Object.freeze([
  { triggerR: 2.0, lockR: 1.0, key: 'lock_1r_at_2r', label: '2.0R reached -> lock 1.0R' },
  { triggerR: 1.5, lockR: 0.5, key: 'lock_0_5r_at_1_5r', label: '1.5R reached -> lock 0.5R' },
  { triggerR: 1.0, lockR: 0.0, key: 'break_even_at_1r', label: '1.0R reached -> move to break-even' },
]);
export const EXIT_PLAN_VERSION = 'v1.6_scaleout_40_35_25';
const EXIT_STATE = Object.freeze({
  OPEN_FULL: 'OPEN_FULL',
  TP1_FILLED: 'TP1_FILLED',
  BE_ARMED: 'BE_ARMED',
  TP2_FILLED: 'TP2_FILLED',
  RUNNER_TRAILING: 'RUNNER_TRAILING',
});
const SCALE_OUT_LEVELS = Object.freeze({
  tp1R: 0.6,
  tp1Pct: 0.40,
  tp1StopR: -0.25,
  beTriggerR: 0.9,
  tp2R: 1.2,
  tp2Pct: 0.35,
  tp2StopR: 0.35,
  trailTriggerR: 1.5,
  trailAtr: 0.8,
  finalTpR: 1.8,
});

// ── Multi-Currency Configuration ──────────────────────────────────────────────
// The user's account is in AED, but GOLD is priced in USD.
// We must convert the AED balance to USD before calculating risk-based size.
// AED is pegged to USD at 3.6725.
export const USD_AED_PEG = 3.6725;
const EXTREME_ATR_MULTIPLIER = 4;
const EXTREME_PRICE_PCT = 0.02;
const MAX_PORTFOLIO_WORST_CASE_EQUITY_PCT = 0.27; // Allows one standard-risk trade on small balances while keeping stress cap defensive

function buildIdempotencyKey(signal) {
  // Use only the candle timestamp (extract from signal.id e.g. "1713184500000_BUY_v1.5")
  // This guarantees exactly ONE trade attempt per candle, preventing duplicate executions.
  const timestamp = String(signal.id).split('_')[0];
  const seed = `candle_${timestamp}`;
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 24);
  return `gold-${hash}`;
}

function extractStrictFilledSize(confirmData, expectedSize = null) {
  const affected = Array.isArray(confirmData?.affectedDeals) ? confirmData.affectedDeals : [];
  
  // Extract actual dealId from the broker's resulting position (the true single source of truth)
  // We ONLY want the dealId. The dealReference is for the transaction/order, not the position.
  const actualDealId = affected.length > 0 ? affected[0]?.dealId : null;
  
  // 1. Try to find size in the root confirmation object first
  const rootSize = Number(confirmData?.size ?? confirmData?.dealSize ?? confirmData?.filledSize);
  
  if (affected.length === 0) {
    if (Number.isFinite(rootSize) && rootSize > 0) {
      return { ok: true, reason: 'ROOT_SIZE_FOUND', filledSize: rootSize, actualDealId };
    }
    return { ok: false, reason: 'MISSING_FILL_BREAKDOWN', filledSize: null, actualDealId };
  }

  // 2. Sum up sizes from affected deals if present
  let sum = 0;
  let hasValidChildSize = false;
  for (const deal of affected) {
    const sz = Number(deal?.size ?? deal?.dealSize ?? deal?.filledSize);
    if (Number.isFinite(sz) && sz > 0) {
      sum += sz;
      hasValidChildSize = true;
    }
  }

  if (hasValidChildSize && sum > 0) {
    return { ok: true, reason: null, filledSize: sum, actualDealId };
  }

  // 3. Fallback to root size if children didn't have it
  if (Number.isFinite(rootSize) && rootSize > 0) {
    return { ok: true, reason: 'FALLBACK_ROOT_SIZE', filledSize: rootSize, actualDealId };
  }

  // 4. Last resort: if the broker says ACCEPTED and it's a single deal, use expected size.
  if (affected.length === 1 && expectedSize > 0) {
    const dealId = affected[0]?.dealId;
    if (dealId) {
      console.warn(`[EXEC] Confirmation for ${dealId} has no size field; adopting expected size ${expectedSize}`);
      return { ok: true, reason: 'ADOPTED_EXPECTED_SIZE', filledSize: expectedSize, actualDealId: dealId };
    }
  }

  return { ok: false, reason: 'INVALID_FILL_BREAKDOWN', filledSize: null, actualDealId };
}

/**
 * Normalizes an ID to ensure it is a string.
 */
function normalizeId(id) {
  if (id === null || id === undefined) return null;
  return String(id).trim();
}

function normalizeDirection(rawDirection) {
  const direction = String(rawDirection || '').toUpperCase();
  if (direction === 'BUY' || direction === 'SELL') return direction;
  return null;
}

function normalizePositiveSize(rawSize) {
  const size = Number(rawSize);
  if (!Number.isFinite(size) || size <= 0) return null;
  return size;
}

function sizesMatchExactly(left, right) {
  const a = normalizePositiveSize(left);
  const b = normalizePositiveSize(right);
  if (a === null || b === null) return false;
  return Math.abs(a - b) < 0.001;
}

function parseStopDistanceField(field) {
  if (field == null) return 0;
  if (typeof field === 'object') return parseFloat(field.value) || 0;
  return parseFloat(field) || 0;
}

function roundPrice(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return NaN;
  return Number(num.toFixed(PRICE_DECIMALS));
}

function isStopOnRiskSide(action, entry, stop) {
  if (!Number.isFinite(entry) || !Number.isFinite(stop)) return false;
  if (action === 'BUY') return stop < entry;
  if (action === 'SELL') return stop > entry;
  return false;
}

function isBetterStopLoss(action, candidateStop, currentStop) {
  if (!Number.isFinite(candidateStop) || !Number.isFinite(currentStop)) return false;
  if (action === 'BUY') return candidateStop > currentStop;
  if (action === 'SELL') return candidateStop < currentStop;
  return false;
}

function calculateDynamicWorstCaseMoveUsd(currentPrice, atr) {
  const px = Number(currentPrice);
  const atrValue = Number(atr);
  if (!Number.isFinite(px) || px <= 0) return null;
  if (!Number.isFinite(atrValue) || atrValue <= 0) return null;

  const atrExtremeMove = atrValue * EXTREME_ATR_MULTIPLIER;
  const pctExtremeMove = px * EXTREME_PRICE_PCT;
  const worstCaseMoveUsd = Math.max(atrExtremeMove, pctExtremeMove);

  if (!Number.isFinite(worstCaseMoveUsd) || worstCaseMoveUsd <= 0) return null;
  return worstCaseMoveUsd;
}

async function fetchDealConfirmation(session, dealReference) {
  const { baseUrl, cst, securityToken } = session;
  const res = await fetchWithTimeout(`${baseUrl}/api/v1/confirms/${dealReference}`, {
    headers: {
      'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
      'CST': cst,
      'X-SECURITY-TOKEN': securityToken,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`Order confirmation failed (HTTP ${res.status}): ${body}`);
  }
  return await res.json();
}

function calculatePortfolioWorstCaseRiskAED(openTrades, extraSize, worstCaseMoveUsd) {
  const move = Number(worstCaseMoveUsd);
  if (!Number.isFinite(move) || move <= 0) {
    return { ok: false, reason: 'INVALID_WORST_CASE_MOVE', riskAED: null };
  }

  const activeTrades = Array.isArray(openTrades) ? openTrades : [];
  let totalUsd = 0;

  for (const trade of activeTrades) {
    const size = normalizePositiveSize(trade?.size);
    const direction = normalizeDirection(trade?.action ?? trade?.direction);
    if (size === null || direction === null) {
      return { ok: false, reason: 'INVALID_OPEN_TRADE_FOR_RISK_MODEL', riskAED: null };
    }
    totalUsd += size * move;
  }

  const pendingSize = normalizePositiveSize(extraSize);
  if (pendingSize === null) {
    return { ok: false, reason: 'INVALID_PENDING_SIZE_FOR_RISK_MODEL', riskAED: null };
  }
  totalUsd += pendingSize * move;

  return { ok: true, reason: null, riskAED: totalUsd * USD_AED_PEG };
}

function resolveEffectiveRiskMultiplier(signal) {
  const baseMultiplier = Number(signal?.riskMultiplier);
  const existingRiskMultiplier = Number.isFinite(baseMultiplier) && baseMultiplier > 0
    ? baseMultiplier
    : 1.0;

  const policyMultiplier = Number(signal?.executionPolicy?.riskMultiplier);
  if (!Number.isFinite(policyMultiplier) || policyMultiplier <= 0) {
    return existingRiskMultiplier;
  }

  const clampedPolicyMultiplier = Math.min(policyMultiplier, 1.0);
  return Math.min(existingRiskMultiplier * clampedPolicyMultiplier, existingRiskMultiplier);
}

export function calculateFillSlippage(intendedEntryPrice, actualFillPrice, atr) {
  const intended = Number(intendedEntryPrice);
  const actual = Number(actualFillPrice);
  const atrValue = Number(atr);

  if (!Number.isFinite(intended) || !Number.isFinite(actual) || !Number.isFinite(atrValue) || atrValue <= 0) {
    return {
      intendedEntryPrice: Number.isFinite(intended) ? intended : null,
      actualFillPrice: Number.isFinite(actual) ? actual : null,
      absoluteSlippage: null,
      slippageToATR: null,
      fillQuality: 'UNKNOWN',
    };
  }

  const absoluteSlippage = Math.abs(actual - intended);
  const slippageToATR = absoluteSlippage / atrValue;
  let fillQuality = 'DEGRADED';
  if (slippageToATR <= 0.05) fillQuality = 'GOOD';
  else if (slippageToATR <= 0.15) fillQuality = 'ACCEPTABLE';

  return {
    intendedEntryPrice: intended,
    actualFillPrice: actual,
    absoluteSlippage: Number(absoluteSlippage.toFixed(4)),
    slippageToATR: Number(slippageToATR.toFixed(4)),
    fillQuality,
  };
}

function resolveInitialRiskStopLoss(trade, action, entry) {
  const explicitInitialStop = Number(trade?.initialStopLoss);
  if (
    Number.isFinite(explicitInitialStop) &&
    explicitInitialStop > 0 &&
    isStopOnRiskSide(action, entry, explicitInitialStop)
  ) {
    return { initialStopLoss: explicitInitialStop, riskSource: 'initialStopLoss' };
  }

  const currentStopLoss = Number(trade?.stopLoss);
  if (
    Number.isFinite(currentStopLoss) &&
    currentStopLoss > 0 &&
    isStopOnRiskSide(action, entry, currentStopLoss)
  ) {
    return { initialStopLoss: currentStopLoss, riskSource: 'currentStopLoss' };
  }

  return { initialStopLoss: null, riskSource: null };
}

/**
 * Builds a stop-loss update plan for progressive R-multiple profit locking.
 * The plan is pure/offline so it can be reused in tests and in cron trade management.
 */
export function calculateProgressiveStopPlan(trade, livePrice, options = {}) {
  const action = normalizeDirection(trade?.action ?? trade?.direction);
  const entry = Number(trade?.entry);
  const currentStopLoss = Number(trade?.stopLoss);
  const bid = Number(livePrice?.bid);
  const offer = Number(livePrice?.offer ?? livePrice?.ask);

  if (
    !action ||
    !Number.isFinite(entry) ||
    entry <= 0 ||
    !Number.isFinite(currentStopLoss) ||
    currentStopLoss <= 0 ||
    !Number.isFinite(bid) ||
    bid <= 0 ||
    !Number.isFinite(offer) ||
    offer <= 0
  ) {
    return { shouldModify: false, reason: 'INVALID_INPUT' };
  }

  const { initialStopLoss, riskSource } = resolveInitialRiskStopLoss(trade, action, entry);
  if (!Number.isFinite(initialStopLoss) || initialStopLoss <= 0) {
    return {
      shouldModify: false,
      reason: 'UNKNOWN_INITIAL_RISK',
      action,
      entry,
      currentStopLoss,
    };
  }

  const riskDistance = Math.abs(entry - initialStopLoss);
  if (!Number.isFinite(riskDistance) || riskDistance <= 0) {
    return {
      shouldModify: false,
      reason: 'INVALID_INITIAL_RISK',
      action,
      entry,
      currentStopLoss,
      initialStopLoss,
      riskSource,
    };
  }

  const currentPrice = action === 'BUY' ? bid : offer;
  const currentProfitDistance = action === 'BUY' ? currentPrice - entry : entry - currentPrice;
  const currentRMultiple = currentProfitDistance / riskDistance;
  const configuredMinStopDistance = Number(options.minStopDistance);
  const brokerMinStopDistance = Number.isFinite(configuredMinStopDistance) && configuredMinStopDistance > 0
    ? configuredMinStopDistance
    : MIN_STOP_DISTANCE;

  const basePlan = {
    action,
    entry,
    currentStopLoss,
    initialStopLoss,
    riskSource,
    riskDistance,
    currentPrice,
    currentProfitDistance,
    currentRMultiple,
    brokerMinStopDistance,
  };

  const stage = PROFIT_LOCK_STAGES.find(({ triggerR }) => currentRMultiple >= triggerR);
  if (!stage) {
    return {
      shouldModify: false,
      reason: 'THRESHOLD_NOT_REACHED',
      ...basePlan,
    };
  }

  const rawStopLevel = action === 'BUY'
    ? entry + (stage.lockR * riskDistance)
    : entry - (stage.lockR * riskDistance);
  const stopLevel = roundPrice(rawStopLevel);

  if (!Number.isFinite(stopLevel)) {
    return {
      shouldModify: false,
      reason: 'INVALID_TARGET_STOP',
      ...basePlan,
      triggerR: stage.triggerR,
      lockedR: stage.lockR,
      stageKey: stage.key,
      stageLabel: stage.label,
    };
  }

  if (!isBetterStopLoss(action, stopLevel, currentStopLoss)) {
    return {
      shouldModify: false,
      reason: 'STOP_NOT_BETTER',
      ...basePlan,
      stopLevel,
      triggerR: stage.triggerR,
      lockedR: stage.lockR,
      stageKey: stage.key,
      stageLabel: stage.label,
    };
  }

  const distanceToCurrent = action === 'BUY'
    ? currentPrice - stopLevel
    : stopLevel - currentPrice;
  if (!Number.isFinite(distanceToCurrent) || distanceToCurrent < brokerMinStopDistance) {
    return {
      shouldModify: false,
      reason: 'BROKER_MIN_DISTANCE',
      ...basePlan,
      stopLevel,
      distanceToCurrent,
      triggerR: stage.triggerR,
      lockedR: stage.lockR,
      stageKey: stage.key,
      stageLabel: stage.label,
    };
  }

  return {
    shouldModify: true,
    reason: 'READY',
    ...basePlan,
    stopLevel,
    distanceToCurrent,
    triggerR: stage.triggerR,
    lockedR: stage.lockR,
    stageKey: stage.key,
    stageLabel: stage.label,
  };
}

function floorSize(size) {
  const value = Number(size);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value * 100) / 100;
}

function getScaleOutRiskContext(trade, livePrice, options = {}) {
  const action = normalizeDirection(trade?.action ?? trade?.direction);
  const entry = Number(trade?.entry);
  const currentStopLoss = Number(trade?.stopLoss);
  const bid = Number(livePrice?.bid);
  const offer = Number(livePrice?.offer ?? livePrice?.ask);
  if (!action || !Number.isFinite(entry) || !Number.isFinite(currentStopLoss) || !Number.isFinite(bid) || !Number.isFinite(offer)) {
    return { ok: false, reason: 'INVALID_INPUT' };
  }

  const { initialStopLoss, riskSource } = resolveInitialRiskStopLoss(trade, action, entry);
  if (!Number.isFinite(initialStopLoss) || initialStopLoss <= 0) {
    return { ok: false, reason: 'UNKNOWN_INITIAL_RISK', action, entry, currentStopLoss };
  }

  const riskDistance = Math.abs(entry - initialStopLoss);
  if (!Number.isFinite(riskDistance) || riskDistance <= 0) {
    return { ok: false, reason: 'INVALID_INITIAL_RISK', action, entry, currentStopLoss, initialStopLoss };
  }

  const currentPrice = action === 'BUY' ? bid : offer;
  const currentProfitDistance = action === 'BUY' ? currentPrice - entry : entry - currentPrice;
  const currentRMultiple = currentProfitDistance / riskDistance;
  const brokerMinStopDistance = Number.isFinite(Number(options.minStopDistance)) && Number(options.minStopDistance) > 0
    ? Number(options.minStopDistance)
    : MIN_STOP_DISTANCE;

  return {
    ok: true,
    action,
    entry,
    currentStopLoss,
    initialStopLoss,
    riskSource,
    riskDistance,
    currentPrice,
    currentProfitDistance,
    currentRMultiple,
    brokerMinStopDistance,
    spread: Math.max(0, offer - bid),
  };
}

function stopAtR(action, entry, riskDistance, rMultiple) {
  return roundPrice(action === 'BUY'
    ? entry + rMultiple * riskDistance
    : entry - rMultiple * riskDistance);
}

function stopDistanceOk(action, currentPrice, stopLevel, brokerMinStopDistance) {
  const distanceToCurrent = action === 'BUY'
    ? currentPrice - stopLevel
    : stopLevel - currentPrice;
  return {
    ok: Number.isFinite(distanceToCurrent) && distanceToCurrent >= brokerMinStopDistance,
    distanceToCurrent,
  };
}

function buildStopAction(ctx, stopLevel, stageKey, stageLabel, lockedR) {
  if (!isBetterStopLoss(ctx.action, stopLevel, ctx.currentStopLoss)) {
    return { shouldManage: false, reason: 'STOP_NOT_BETTER', ...ctx, stopLevel, stageKey, stageLabel, lockedR };
  }
  const distance = stopDistanceOk(ctx.action, ctx.currentPrice, stopLevel, ctx.brokerMinStopDistance);
  if (!distance.ok) {
    return { shouldManage: false, reason: 'BROKER_MIN_DISTANCE', ...ctx, stopLevel, distanceToCurrent: distance.distanceToCurrent, stageKey, stageLabel, lockedR };
  }
  return {
    shouldManage: true,
    actionType: 'MODIFY_STOP',
    reason: 'READY',
    ...ctx,
    stopLevel,
    distanceToCurrent: distance.distanceToCurrent,
    stageKey,
    stageLabel,
    lockedR,
  };
}

export function calculateScaleOutManagementPlan(trade, livePrice, options = {}) {
  const ctx = getScaleOutRiskContext(trade, livePrice, options);
  if (!ctx.ok) return { shouldManage: false, reason: ctx.reason, ...ctx };

  const initialSize = Number(trade?.initialSize ?? trade?.originalSize ?? trade?.size);
  const currentSize = Number(trade?.size);
  const remainingSize = Number.isFinite(currentSize) && currentSize > 0 ? currentSize : initialSize;
  const minPartialSize = Number(options.minPartialSize ?? MIN_SIZE);
  const state = trade?.managementState || EXIT_STATE.OPEN_FULL;
  const partial1Filled =
    trade?.partial1Filled === true ||
    state === EXIT_STATE.TP1_FILLED ||
    state === EXIT_STATE.BE_ARMED ||
    state === EXIT_STATE.TP2_FILLED ||
    state === EXIT_STATE.RUNNER_TRAILING;
  const partial2Filled =
    trade?.partial2Filled === true ||
    state === EXIT_STATE.TP2_FILLED ||
    state === EXIT_STATE.RUNNER_TRAILING;
  const beArmed = trade?.breakEvenMoved === true || state === EXIT_STATE.BE_ARMED || state === EXIT_STATE.TP2_FILLED || state === EXIT_STATE.RUNNER_TRAILING;

  if (ctx.currentRMultiple >= SCALE_OUT_LEVELS.tp1R && !partial1Filled) {
    const requestedSize = floorSize((Number.isFinite(initialSize) ? initialSize : remainingSize) * SCALE_OUT_LEVELS.tp1Pct);
    const stopLevel = stopAtR(ctx.action, ctx.entry, ctx.riskDistance, SCALE_OUT_LEVELS.tp1StopR);
    if (requestedSize >= minPartialSize && requestedSize < remainingSize) {
      return {
        shouldManage: true,
        actionType: 'PARTIAL_CLOSE',
        reason: 'READY',
        ...ctx,
        closeSize: requestedSize,
        closePct: SCALE_OUT_LEVELS.tp1Pct,
        stopLevel,
        lockedR: SCALE_OUT_LEVELS.tp1StopR,
        nextState: EXIT_STATE.TP1_FILLED,
        stageKey: 'tp1_40_at_0_6r',
        stageLabel: 'TP1 40% at 0.6R',
      };
    }
    const stopAction = buildStopAction(ctx, stopLevel, 'tp1_size_too_small_protect', 'TP1 size too small -> protect at -0.25R', SCALE_OUT_LEVELS.tp1StopR);
    return { ...stopAction, partialBlockedReason: 'PARTIAL_SIZE_TOO_SMALL', nextState: EXIT_STATE.TP1_FILLED };
  }

  if (partial1Filled && !beArmed && ctx.currentRMultiple >= SCALE_OUT_LEVELS.beTriggerR) {
    const beBufferR = ctx.spread / ctx.riskDistance;
    const stopLevel = stopAtR(ctx.action, ctx.entry, ctx.riskDistance, beBufferR);
    const action = buildStopAction(ctx, stopLevel, 'be_plus_spread_at_0_9r', '0.9R reached -> BE plus spread buffer', beBufferR);
    return { ...action, nextState: EXIT_STATE.BE_ARMED };
  }

  if (ctx.currentRMultiple >= SCALE_OUT_LEVELS.tp2R && partial1Filled && !partial2Filled) {
    const requestedSize = floorSize((Number.isFinite(initialSize) ? initialSize : remainingSize) * SCALE_OUT_LEVELS.tp2Pct);
    const runnerFloor = floorSize((Number.isFinite(initialSize) ? initialSize : remainingSize) * 0.20);
    const maxClose = floorSize(Math.max(0, remainingSize - Math.max(runnerFloor, minPartialSize)));
    const closeSize = Math.min(requestedSize, maxClose);
    const stopLevel = stopAtR(ctx.action, ctx.entry, ctx.riskDistance, SCALE_OUT_LEVELS.tp2StopR);
    if (closeSize >= minPartialSize && closeSize < remainingSize) {
      return {
        shouldManage: true,
        actionType: 'PARTIAL_CLOSE',
        reason: 'READY',
        ...ctx,
        closeSize,
        closePct: SCALE_OUT_LEVELS.tp2Pct,
        stopLevel,
        lockedR: SCALE_OUT_LEVELS.tp2StopR,
        nextState: EXIT_STATE.TP2_FILLED,
        stageKey: 'tp2_35_at_1_2r',
        stageLabel: 'TP2 35% at 1.2R',
      };
    }
    const stopAction = buildStopAction(ctx, stopLevel, 'tp2_size_too_small_lock_0_35r', 'TP2 size too small -> lock 0.35R', SCALE_OUT_LEVELS.tp2StopR);
    return { ...stopAction, partialBlockedReason: 'PARTIAL_SIZE_TOO_SMALL', nextState: EXIT_STATE.TP2_FILLED };
  }

  if (ctx.currentRMultiple >= SCALE_OUT_LEVELS.trailTriggerR && (partial2Filled || state === EXIT_STATE.TP2_FILLED || state === EXIT_STATE.RUNNER_TRAILING)) {
    const atr = Number(trade?.atr);
    if (!Number.isFinite(atr) || atr <= 0) return { shouldManage: false, reason: 'INVALID_ATR_FOR_TRAIL', ...ctx };
    const rawTrailStop = ctx.action === 'BUY'
      ? ctx.currentPrice - SCALE_OUT_LEVELS.trailAtr * atr
      : ctx.currentPrice + SCALE_OUT_LEVELS.trailAtr * atr;
    const lockedStop = stopAtR(ctx.action, ctx.entry, ctx.riskDistance, SCALE_OUT_LEVELS.tp2StopR);
    const stopLevel = roundPrice(ctx.action === 'BUY'
      ? Math.max(rawTrailStop, lockedStop)
      : Math.min(rawTrailStop, lockedStop));
    const action = buildStopAction(ctx, stopLevel, 'atr_trail_after_1_5r', '1.5R reached -> 0.8 ATR runner trail', SCALE_OUT_LEVELS.tp2StopR);
    return { ...action, nextState: EXIT_STATE.RUNNER_TRAILING, trailStop: stopLevel };
  }

  return { shouldManage: false, reason: 'THRESHOLD_NOT_REACHED', ...ctx };
}

function nullableFiniteNumber(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function roundAuditNumber(value, decimals = 4) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Number(num.toFixed(decimals));
}

function roundQualityNumber(value, decimals = 4) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Number(num.toFixed(decimals));
}

export function assessExecutionQuality({ spread, maxSpread, slippage, slippageLimit, minStopDist, atr }) {
  const spreadRatio = Number.isFinite(Number(spread)) && Number.isFinite(Number(maxSpread)) && Number(maxSpread) > 0
    ? Number(spread) / Number(maxSpread)
    : 1;
  const slippageRatio = Number.isFinite(Number(slippage)) && Number.isFinite(Number(slippageLimit)) && Number(slippageLimit) > 0
    ? Number(slippage) / Number(slippageLimit)
    : 1;
  const stopAtrRatio = Number.isFinite(Number(minStopDist)) && Number.isFinite(Number(atr)) && Number(atr) > 0 && Number(minStopDist) > 0
    ? Number(minStopDist) / Number(atr)
    : 0;

  const spreadPenalty = Math.min(30, Math.max(0, spreadRatio) * 25);
  const slippagePenalty = Math.min(40, Math.max(0, slippageRatio) * 35);
  const stopPenalty = Math.min(25, Math.max(0, stopAtrRatio / MAX_STOP_ATR_RATIO) * 25);
  const score = Math.max(0, 100 - spreadPenalty - slippagePenalty - stopPenalty);

  return {
    score: roundQualityNumber(score, 2),
    grade: score >= 85 ? 'GOOD' : score >= MIN_EXECUTION_QUALITY_SCORE ? 'ACCEPTABLE' : 'DEGRADED',
    minScore: MIN_EXECUTION_QUALITY_SCORE,
    spreadRatio: roundQualityNumber(spreadRatio),
    slippageRatio: roundQualityNumber(slippageRatio),
    stopAtrRatio: roundQualityNumber(stopAtrRatio),
    components: {
      spreadPenalty: roundQualityNumber(spreadPenalty, 2),
      slippagePenalty: roundQualityNumber(slippagePenalty, 2),
      stopPenalty: roundQualityNumber(stopPenalty, 2),
    },
  };
}

function getTradeAuditRiskDistance(trade, action, entry) {
  const explicitRisk = nullableFiniteNumber(trade?.audit?.initialRiskDistance);
  if (explicitRisk !== null && explicitRisk > 0) return explicitRisk;

  const { initialStopLoss } = resolveInitialRiskStopLoss(trade, action, entry);
  if (!Number.isFinite(initialStopLoss) || initialStopLoss <= 0) return null;

  const riskDistance = Math.abs(entry - initialStopLoss);
  return Number.isFinite(riskDistance) && riskDistance > 0 ? riskDistance : null;
}

export function createTradePathAudit(trade) {
  const action = normalizeDirection(trade?.action ?? trade?.direction);
  const entry = nullableFiniteNumber(trade?.entry);
  const takeProfit = nullableFiniteNumber(trade?.takeProfit);
  const riskDistance = action && entry !== null
    ? getTradeAuditRiskDistance(trade, action, entry)
    : null;
  const rewardDistance = entry !== null && takeProfit !== null
    ? Math.abs(takeProfit - entry)
    : null;
  const initialTpR = riskDistance && rewardDistance !== null && rewardDistance > 0
    ? rewardDistance / riskDistance
    : null;

  return {
    initialRiskDistance: roundAuditNumber(riskDistance),
    initialRewardDistance: roundAuditNumber(rewardDistance),
    initialTpR: roundAuditNumber(initialTpR),
    mfePriceDistance: 0,
    maePriceDistance: 0,
    mfeR: 0,
    maeR: 0,
    reached1R: false,
    reached1_2R: false,
    reached1_5R: false,
    reached2R: false,
    reached2_5R: false,
    reachedTpR: false,
    firstReached1RAt: null,
    firstReached1_2RAt: null,
    firstReached1_5RAt: null,
    firstReached2RAt: null,
    firstReached2_5RAt: null,
    firstReachedTpRAt: null,
    maxFavorablePrice: null,
    maxAdversePrice: null,
    stopWasMoved: false,
    stopMoveCount: 0,
    stopMoveEvents: [],
  };
}

export function ensureTradePathAudit(trade) {
  const existing = trade?.audit && typeof trade.audit === 'object' ? trade.audit : {};
  const created = createTradePathAudit(trade);
  const stopMoveEvents = Array.isArray(existing.stopMoveEvents) ? existing.stopMoveEvents : [];
  const audit = {
    ...created,
    ...existing,
    initialRiskDistance: existing.initialRiskDistance ?? created.initialRiskDistance,
    initialRewardDistance: existing.initialRewardDistance ?? created.initialRewardDistance,
    initialTpR: existing.initialTpR ?? created.initialTpR,
    stopWasMoved: existing.stopWasMoved === true || stopMoveEvents.length > 0,
    stopMoveCount: Number.isFinite(Number(existing.stopMoveCount))
      ? Number(existing.stopMoveCount)
      : stopMoveEvents.length,
    stopMoveEvents,
  };

  if (trade && typeof trade === 'object') trade.audit = audit;
  return audit;
}

export function updateTradePathAudit(trade, livePrice, nowMs = Date.now()) {
  const action = normalizeDirection(trade?.action ?? trade?.direction);
  const entry = nullableFiniteNumber(trade?.entry);
  const bid = nullableFiniteNumber(livePrice?.bid);
  const offer = nullableFiniteNumber(livePrice?.offer ?? livePrice?.ask);

  if (!action || entry === null || bid === null || offer === null || bid <= 0 || offer <= 0) {
    return ensureTradePathAudit(trade);
  }

  const audit = ensureTradePathAudit(trade);
  const currentPrice = action === 'BUY' ? bid : offer;
  const currentProfitDistance = action === 'BUY'
    ? currentPrice - entry
    : entry - currentPrice;
  const favorableDistance = Math.max(currentProfitDistance, 0);
  const adverseDistance = Math.max(-currentProfitDistance, 0);
  const riskDistance = nullableFiniteNumber(audit.initialRiskDistance);
  const currentR = riskDistance && riskDistance > 0 ? currentProfitDistance / riskDistance : null;

  if (favorableDistance > Number(audit.mfePriceDistance || 0)) {
    audit.mfePriceDistance = roundAuditNumber(favorableDistance);
    audit.mfeR = riskDistance && riskDistance > 0
      ? roundAuditNumber(favorableDistance / riskDistance)
      : 0;
    audit.maxFavorablePrice = roundAuditNumber(currentPrice, PRICE_DECIMALS);
  }

  if (adverseDistance > Number(audit.maePriceDistance || 0)) {
    audit.maePriceDistance = roundAuditNumber(adverseDistance);
    audit.maeR = riskDistance && riskDistance > 0
      ? roundAuditNumber(adverseDistance / riskDistance)
      : 0;
    audit.maxAdversePrice = roundAuditNumber(currentPrice, PRICE_DECIMALS);
  }

  if (currentR !== null) {
    if (currentR >= 1.0 && !audit.reached1R) {
      audit.reached1R = true;
      audit.firstReached1RAt = nowMs;
    }
    if (currentR >= 1.2 && !audit.reached1_2R) {
      audit.reached1_2R = true;
      audit.firstReached1_2RAt = nowMs;
    }
    if (currentR >= 1.5 && !audit.reached1_5R) {
      audit.reached1_5R = true;
      audit.firstReached1_5RAt = nowMs;
    }
    if (currentR >= 2.0 && !audit.reached2R) {
      audit.reached2R = true;
      audit.firstReached2RAt = nowMs;
    }
    if (currentR >= 2.5 && !audit.reached2_5R) {
      audit.reached2_5R = true;
      audit.firstReached2_5RAt = nowMs;
    }

    const initialTpR = nullableFiniteNumber(audit.initialTpR);
    if (initialTpR !== null && currentR >= initialTpR && !audit.reachedTpR) {
      audit.reachedTpR = true;
      audit.firstReachedTpRAt = nowMs;
    }
  }

  return audit;
}

export function recordStopMoveAuditEvent(trade, plan, nowMs = Date.now()) {
  const audit = ensureTradePathAudit(trade);
  const event = {
    at: nowMs,
    fromStop: roundAuditNumber(plan?.currentStopLoss, PRICE_DECIMALS),
    toStop: roundAuditNumber(plan?.stopLevel, PRICE_DECIMALS),
    triggerR: roundAuditNumber(plan?.triggerR),
    lockedR: roundAuditNumber(plan?.lockedR),
    stageKey: plan?.stageKey ?? null,
    currentR: roundAuditNumber(plan?.currentRMultiple),
  };

  audit.stopWasMoved = true;
  audit.stopMoveEvents.push(event);
  audit.stopMoveCount = audit.stopMoveEvents.length;
  return event;
}

function classifyExitReasonFromAudit(realizedR, audit) {
  if (!Number.isFinite(realizedR)) return 'UNKNOWN';

  const initialTpR = nullableFiniteNumber(audit?.initialTpR);
  if (initialTpR !== null && realizedR >= initialTpR - 0.25) return 'TAKE_PROFIT';
  if (realizedR <= -0.5) return 'FULL_STOP';
  if (Math.abs(realizedR) <= 0.2 && audit?.stopWasMoved === true) return 'BREAK_EVEN';
  if (realizedR > 0.2 && audit?.stopWasMoved === true) return 'LOCKED_PROFIT';
  if (realizedR < -0.2) return 'FULL_STOP';
  return 'UNKNOWN';
}

function buildPostTradeReasonTags(realizedR, audit, exitReasonClass) {
  const tags = [exitReasonClass || 'UNKNOWN'];
  const mfeR = nullableFiniteNumber(audit?.mfeR);
  const maeR = nullableFiniteNumber(audit?.maeR);

  if (audit?.reachedTpR === true) tags.push('TARGET_REACHED');
  else if (audit?.reached2_5R === true) tags.push('REACHED_2_5R');
  else if (audit?.reached2R === true) tags.push('REACHED_2R');
  else if (audit?.reached1_5R === true) tags.push('REACHED_1_5R');
  else if (audit?.reached1R === true) tags.push('REACHED_1R');
  else tags.push('NO_1R');

  if (audit?.stopWasMoved === true) tags.push('STOP_MANAGED');
  if (Number.isFinite(realizedR) && realizedR < 0 && mfeR !== null && mfeR >= 1) tags.push('WINNER_TURNED_LOSS');
  if (Number.isFinite(realizedR) && mfeR !== null && mfeR - realizedR >= 1) tags.push('GAVE_BACK_1R_PLUS');
  if (maeR !== null && maeR >= 0.75) tags.push('DEEP_ADVERSE_EXCURSION');
  if (Number.isFinite(realizedR) && realizedR > 0 && exitReasonClass === 'LOCKED_PROFIT') tags.push('PROFIT_PROTECTED');

  return [...new Set(tags)];
}

export function buildExitAudit(trade, realizedPnl) {
  const audit = ensureTradePathAudit(trade);
  const pnl = nullableFiniteNumber(realizedPnl);
  const riskDistance = nullableFiniteNumber(audit.initialRiskDistance);
  const size = nullableFiniteNumber(trade?.size);
  const riskAED = riskDistance && size && riskDistance > 0 && size > 0
    ? riskDistance * size * USD_AED_PEG
    : null;
  const realizedR = pnl !== null && riskAED !== null && riskAED > 0
    ? pnl / riskAED
    : null;
  const mfeR = nullableFiniteNumber(audit.mfeR);
  const exitReasonClass = classifyExitReasonFromAudit(realizedR, audit);
  const postTradeReasonTags = buildPostTradeReasonTags(realizedR, audit, exitReasonClass);

  return {
    realizedPnl: pnl,
    realizedR: roundAuditNumber(realizedR),
    exitReasonClass,
    postTradeReasonTags,
    primaryPostTradeReason: postTradeReasonTags[0] ?? 'UNKNOWN',
    mfeR: roundAuditNumber(mfeR),
    maeR: roundAuditNumber(audit.maeR),
    reached1R: audit.reached1R === true,
    reached1_2R: audit.reached1_2R === true,
    reached1_5R: audit.reached1_5R === true,
    reached2R: audit.reached2R === true,
    reached2_5R: audit.reached2_5R === true,
    reachedTpR: audit.reachedTpR === true,
    gaveBackFromMfeR: realizedR !== null && mfeR !== null
      ? roundAuditNumber(Math.max(mfeR - realizedR, 0))
      : null,
  };
}

/**
 * Ensures local state matches broker state with tolerance for API propagation delays.
 * STRICTLY uses dealId as the unique identifier.
 */
export async function verifyExecutionCertainty(session, botState) {
  try {
    if (botState.criticalFailure === true) {
      return { ok: false, reason: 'CRITICAL_FAILURE_ACTIVE' };
    }

    // Pending orders are a source of uncertainty - wait for them to clear
    if (botState.pendingOrder && botState.pendingOrder.status !== 'cleared') {
      return { ok: false, reason: 'PENDING_ORDER_UNCERTAIN' };
    }

    const brokerPositions = await fetchBrokerPositions(session);
    if (brokerPositions === null) {
      return { ok: false, reason: 'BROKER_STATE_UNAVAILABLE' };
    }

    // Build map of broker positions by dealId
    const brokerByDealId = new Map();
    for (const p of brokerPositions) {
      const dealId = normalizeId(p.position?.dealId);
      if (!dealId) {
        console.error('[CERTAINTY] Broker position missing dealId', p.position);
        continue;
      }

      const brokerSize = normalizePositiveSize(p.position?.size ?? p.position?.dealSize);
      const brokerDirection = normalizeDirection(p.position?.direction);
      
      if (brokerSize === null || brokerDirection === null) {
        return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:INVALID_BROKER_POSITION:${dealId}` };
      }

      brokerByDealId.set(dealId, {
        size: brokerSize,
        direction: brokerDirection
      });
    }

    const localTrades = Array.isArray(botState.openTrades) ? botState.openTrades : [];
    const localByDealId = new Map();
    for (const t of localTrades) {
      const dealId = normalizeId(t?.dealId);
      if (!dealId) {
        // If we have a local trade without a dealId, it's a legacy or corrupted state
        // We trigger a mismatch reason but not necessarily a halt here.
        return { ok: false, reason: 'EXECUTION_STATE_UNCERTAIN:LOCAL_TRADE_MISSING_DEAL_ID' };
      }

      const localSize = normalizePositiveSize(t?.size);
      const localDirection = normalizeDirection(t?.action ?? t?.direction);
      if (localSize === null || localDirection === null) {
        return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:INVALID_LOCAL_POSITION:${dealId}` };
      }

      localByDealId.set(dealId, {
        size: localSize,
        direction: localDirection
      });
    }

    // Check for local trades missing on broker
    for (const [dealId, localPos] of localByDealId) {
      const brokerPos = brokerByDealId.get(dealId);
      if (!brokerPos) {
        // Find the trade to check its sync window status via firstMissingAt timestamp.
        // While a trade is within the SYNC_WINDOW_MS tolerance (i.e. reconcilePositions
        // is still waiting for history), we must NOT block new trades — that would
        // cause a multi-cycle skip loop lasting up to the full window.
        const trade = localTrades.find(t => String(t.dealId) === String(dealId));
        const firstMissingAt = trade?.firstMissingAt;

        if (!firstMissingAt || (Date.now() - firstMissingAt) < SYNC_WINDOW_MS) {
          const elapsedMin = firstMissingAt ? Math.floor((Date.now() - firstMissingAt) / 60000) : 0;
          console.warn(`[CERTAINTY] Local dealId ${dealId} NOT ON BROKER, within sync window (${elapsedMin}m / ${Math.floor(SYNC_WINDOW_MS / 60000)}m). Blocking new trades.`);
          return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:LOCAL_NOT_ON_BROKER:${dealId}` };
        }

        // Elapsed > SYNC_WINDOW_MS. reconcilePositions should have force-closed this
        // trade already, so reaching here is unexpected. Return UNCERTAIN so it is
        // treated as a SKIP (not a permanent halt) by the caller.
        console.warn(`[CERTAINTY] Local dealId ${dealId} NOT ON BROKER after ${Math.floor((Date.now() - firstMissingAt) / 60000)}m (beyond sync window). Matches: ${brokerByDealId.size}`);
        return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:LOCAL_NOT_ON_BROKER:${dealId}` };
      }

      if (!sizesMatchExactly(localPos.size, brokerPos.size)) {
        return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:SIZE_MISMATCH:${dealId} (local=${localPos.size}, broker=${brokerPos.size})` };
      }

      if (localPos.direction !== brokerPos.direction) {
        return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:DIRECTION_MISMATCH:${dealId} (local=${localPos.direction}, broker=${brokerPos.direction})` };
      }
    }

    // Check for broker positions missing locally
    for (const dealId of brokerByDealId.keys()) {
      if (!localByDealId.has(dealId)) {
        console.warn(`[CERTAINTY] Broker position ${dealId} NOT FOUND LOCALLY.`);
        return { ok: false, reason: `EXECUTION_STATE_UNCERTAIN:BROKER_NOT_LOCAL:${dealId}` };
      }
    }

    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `EXECUTION_CERTAINTY_ERROR:${err.message}` };
  }
}


// ── fetchAccountData ──────────────────────────────────────────────────────────
// Fetch real-time account balance, equity, and available margin from Capital.com.
// Returns { balance, equity, availableMargin } or null on failure.
export async function fetchAccountData(session) {
  try {
    const { baseUrl, cst, securityToken } = session;
    const res = await withRetries(async attempt => {
      const response = await fetchWithTimeout(`${baseUrl}/api/v1/accounts`, {
        headers: {
          'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
          'CST':              cst,
          'X-SECURITY-TOKEN': securityToken,
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} on attempt ${attempt}`);
      }
      return response;
    }, { attempts: 3, delayMs: 750, backoffFactor: 2, label: 'fetchAccountData' });
    let data;
    try { data = await res.json(); } catch { return null; }
    const account = data.accounts?.[0];
    if (!account) return null;

    const balance         = parseFloat(account.balance?.balance);
    const equity          = parseFloat(account.balance?.equity ?? account.balance?.balance);
    const availableMargin = parseFloat(account.balance?.available);  // Capital.com: "available" = free margin

    if (isNaN(balance) || balance < 0) return null;
    return {
      balance,
      equity:          isNaN(equity) ? balance : equity,
      availableMargin: isNaN(availableMargin) ? balance : availableMargin,
    };
  } catch (err) {
    console.error('[EXEC] fetchAccountData error:', err.message);
    return null;
  }
}


// ── fetchBrokerPositions ──────────────────────────────────────────────────────
// Fetch ALL open positions from Capital.com. Used for state reconciliation.
export async function fetchBrokerPositions(session) {
  try {
    const { baseUrl, cst, securityToken } = session;
    const res = await withRetries(async attempt => {
      const response = await fetchWithTimeout(`${baseUrl}/api/v1/positions`, {
        headers: {
          'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
          'CST':              cst,
          'X-SECURITY-TOKEN': securityToken,
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} on attempt ${attempt}`);
      }
      return response;
    }, { attempts: 3, delayMs: 750, backoffFactor: 2, label: 'fetchBrokerPositions' });

    let data;
    try { data = await res.json(); } catch { return null; }
    const positions = data.positions || [];
    
    // Filter to GOLD positions only
    return positions.filter(p =>
      (p.market?.epic && p.market.epic.includes('GOLD')) ||
      (p.position?.instrumentName && p.position.instrumentName.includes('GOLD'))
    );
  } catch (err) {
    console.error('[EXEC] fetchBrokerPositions error:', err.message);
    return null;
  }
}


// ── syncBalance ───────────────────────────────────────────────────────────────
// Syncs BOTH balance (closed P&L only) and equity (includes unrealized P&L).
// Balance is the source of truth for performance tracking.
// Equity is used for risk monitoring only.
export async function syncBalance(session, botState) {
  try {
    const accountData = await fetchAccountData(session);
    if (!accountData) {
      console.error('[EXEC] Balance sync: failed to fetch account data');
      return botState;
    }

    const { balance: realBalance, equity: realEquity, availableMargin } = accountData;

    botState.balance         = realBalance;
    botState.equity          = realEquity;
    botState.availableMargin = availableMargin;

    console.log(
      `[EXEC] Balance synced: ` +
      `balance=AED ${realBalance.toFixed(2)} | ` +
      `equity=AED ${realEquity.toFixed(2)} | ` +
      `margin=AED ${availableMargin.toFixed(2)} | ` +
      `unrealizedPnL=AED ${(realEquity - realBalance).toFixed(2)}`
    );
    return botState;

  } catch (err) {
    console.error('[EXEC] Balance sync error:', err.message);
    return botState;
  }
}

/**
 * Fetches the actual realized P&L for a closed trade from Capital.com transaction history.
 * @param {Object} session - Capital.com session
 * @param {string} targetId - The trade's unique dealId (position ID)
 * @param {number} [openedAt] - Optional timestamp when the trade was opened
 * @returns {Promise<number|null>} - The profit/loss in account currency, or null if not found
 */
/**
 * Single attempt at fetching the closed-trade P&L from Capital.com transaction history.
 * Returns the profit/loss number, or null if not found / API error.
 * @private
 */
function parseCapitalUtcTimestamp(value) {
  if (!value) return null;
  const raw = String(value);
  const iso = /(?:Z|[+-]\d\d:\d\d)$/.test(raw) ? raw : `${raw}Z`;
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function toCompletedCandleTime(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return Math.floor(timestamp / (5 * 60 * 1000)) * (5 * 60 * 1000);
}

async function _fetchClosedTradePnlDetailsOnce(session, targetId, openedAt) {
  const { baseUrl, cst, securityToken } = session;

  let from;
  if (openedAt && !isNaN(openedAt)) {
    // Look back from 2 hours before it was opened to be very safe
    from = new Date(openedAt - 2 * 60 * 60 * 1000).toISOString().split('.')[0];
  } else {
    from = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString().split('.')[0];
  }

  const to = new Date().toISOString().split('.')[0];
  const url = `${baseUrl}/api/v1/history/transactions?from=${from}&to=${to}`;

  if (DEBUG_SYNC_RECON) {
    console.log('[SYNC_DEBUG] fetchClosedTradePnlOnce request', {
      targetId,
      openedAt: openedAt ?? null,
      openedAtIso: openedAt && !isNaN(openedAt) ? new Date(openedAt).toISOString() : null,
      from,
      to,
      url,
    });
  }

  const res = await fetchWithTimeout(url, {
    headers: {
      'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
      'CST': cst,
      'X-SECURITY-TOKEN': securityToken,
    },
  });

  if (!res.ok) return null;

  const data = await res.json();
  const transactions = Array.isArray(data.transactions) ? data.transactions : [];

  if (DEBUG_SYNC_RECON) {
    console.log('[SYNC_DEBUG] transactions returned', {
      targetId,
      count: transactions.length,
    });
  }

  // Search for a transaction that matches our dealId in any of the possible fields
  const tx = transactions.find(t => {
    const tid = String(targetId).trim();
    const candidate = {
      dealId: t.dealId ?? null,
      dealReference: t.dealReference ?? null,
      reference: t.reference ?? null,
      positionId: t.positionId ?? null,
      orderId: t.orderId ?? null,
      transactionType: t.transactionType ?? null,
      note: t.note ?? null,
      profitAndLoss: t.profitAndLoss ?? null,
      size: t.size ?? null,
      date: t.date ?? null,
    };
    const idMatch = (String(t.dealId).trim() === tid) ||
                    (String(t.dealReference).trim() === tid) ||
                    (String(t.reference).trim() === tid) ||
                    (String(t.positionId).trim() === tid) ||
                    (String(t.orderId).trim() === tid);

    if (!idMatch) {
      if (DEBUG_SYNC_RECON) {
        console.log('[SYNC_DEBUG] tx non-match', {
          targetId: tid,
          dealId: t.dealId ?? null,
          dealReference: t.dealReference ?? null,
          reference: t.reference ?? null,
          positionId: t.positionId ?? null,
          orderId: t.orderId ?? null,
          transactionType: t.transactionType ?? null,
          note: t.note ?? null,
          date: t.date ?? null,
          idMatch: false,
        });
      }
      return false;
    }

    // If it matches ID, and has a P&L, it's almost certainly our closing transaction.
    // We are less strict about the "note" because Capital.com notes can vary.
    // But we exclude "opening" or "margin" notes if possible.
    const note = String(t.note || '').toLowerCase();
    const isOpening = note.includes('open') || note.includes('accepted');
    const hasPnl = t.profitAndLoss != null && !isNaN(parseFloat(t.profitAndLoss));
    const noteClosure = note.includes('closed') || note.includes('stop') || note.includes('limit') || note.includes('liquid');
    const accepted = idMatch && ((hasPnl && !isOpening) || noteClosure);

    if (DEBUG_SYNC_RECON) {
      console.log('[SYNC_DEBUG] tx candidate', {
        targetId: tid,
        ...candidate,
        idMatch,
        hasPnl,
        isOpening,
        noteClosure,
        accepted,
      });
    }

    return accepted;
  });

  if (!tx) {
    if (DEBUG_SYNC_RECON) {
      console.log('[SYNC_DEBUG] no matching closure transaction found', { targetId });
    }
    return null;
  }
  const pnlField = tx.profitAndLoss !== undefined ? tx.profitAndLoss : tx.size;
  const pnl = parseFloat(pnlField);
  if (isNaN(pnl)) return null;
  const closedAt = parseCapitalUtcTimestamp(tx.dateUtc ?? tx.dateUTC ?? tx.date);
  return {
    pnl,
    closedAt,
    closedCandleTime: toCompletedCandleTime(closedAt),
    closeDate: tx.date ?? null,
    closeDateUtc: tx.dateUtc ?? tx.dateUTC ?? null,
  };
}

/**
 * Fetches the actual realized P&L for a closed trade from Capital.com transaction history.
 * Uses internal exponential-backoff retry to handle transient API propagation delays.
 *
 * @param {Object} session       - Capital.com session
 * @param {string} targetId      - The trade's unique dealId (position ID)
 * @param {number} [openedAt]    - Optional timestamp when the trade was opened
 * @param {number[]} [_retryDelaysMs] - Override retry delays in ms (default: [2000, 5000]).
 *   Pass [0, 0] in unit tests to avoid real sleeps.
 * @returns {Promise<number|null>} - The profit/loss in account currency, or null if not found
 */
export async function fetchClosedTradePnl(session, targetId, openedAt, _retryDelaysMs = [2000, 5000]) {
  const details = await fetchClosedTradePnlDetails(session, targetId, openedAt, _retryDelaysMs);
  return details ? details.pnl : null;
}

export async function fetchClosedTradePnlDetails(session, targetId, openedAt, _retryDelaysMs = [2000, 5000]) {
  // Attempt 1 (no delay), then retry after each configured delay.
  // Total overhead: sum(_retryDelaysMs) = 7s by default — safe within Vercel 60s limit.
  // Cross-cycle retry is handled by firstMissingAt in reconcilePositions.
  for (let attempt = 0; attempt <= _retryDelaysMs.length; attempt++) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, _retryDelaysMs[attempt - 1]));
    }
    try {
      const result = await _fetchClosedTradePnlDetailsOnce(session, targetId, openedAt);
      if (result !== null) {
        if (attempt > 0) {
          console.log(`[EXEC] fetchClosedTradePnl: found ${targetId} on attempt ${attempt + 1}`);
        }
        return result;
      }
    } catch (err) {
      console.warn(`[EXEC] fetchClosedTradePnl attempt ${attempt + 1} error for ${targetId}: ${err.message}`);
    }
  }
  return null;
}

/**
 * Fetches actual trade statistics from Capital.com transaction history.
 * SINGLE SOURCE OF TRUTH for all trade metrics.
 */
export async function fetchBrokerTradeStats(session) {
  try {
    const { baseUrl, cst, securityToken } = session;
    
    // Look back 30 days to capture ALL recent trades
    const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('.')[0];
    const to = new Date().toISOString().split('.')[0];
    
    // 1. Fetch Transactions
    const historyUrl = `${baseUrl}/api/v1/history/transactions?from=${from}&to=${to}`;
    const hRes = await fetchWithTimeout(historyUrl, {
      headers: { 'X-CAP-API-KEY': process.env.CAPITAL_API_KEY, 'CST': cst, 'X-SECURITY-TOKEN': securityToken },
    });

    // 2. Fetch Open Positions
    const posUrl = `${baseUrl}/api/v1/positions`;
    const pRes = await fetchWithTimeout(posUrl, {
      headers: { 'X-CAP-API-KEY': process.env.CAPITAL_API_KEY, 'CST': cst, 'X-SECURITY-TOKEN': securityToken },
    });

    if (!hRes.ok) {
      console.warn(`[EXEC] fetchBrokerTradeStats: history API error ${hRes.status}`);
      return null;
    }

    const hData = await hRes.json();
    const transactions = hData.transactions || [];
    const goldTransactions = transactions.filter(t => t.instrumentName?.includes('GOLD'));
    
    // 3. Process open positions
    let livePositions = [];
    if (pRes.ok) {
      const pData = await pRes.json();
      livePositions = (pData.positions || []).filter(p => 
        (p.market?.epic && p.market.epic.includes('GOLD')) || 
        (p.position?.instrumentName && p.position.instrumentName.includes('GOLD'))
      );
    }

    // UAE Time Constants for filtering
    const uaeNow = new Date(Date.now() + 4 * 60 * 60 * 1000);
    const todayStr = uaeNow.toISOString().slice(0, 10);
    
    const todayDealIds = new Set();
    let todayBuys = 0;
    let todaySells = 0;
    const pnlsToday = [];
    const pnls30d = [];

    // Process closed trades from history
    goldTransactions.forEach(t => {
      const pnlField = t.profitAndLoss !== undefined ? t.profitAndLoss : t.size;
      let pnlValue = parseFloat(pnlField || 0);
      const uaeDate = new Date(new Date(t.date).getTime() + (4 * 60 * 60 * 1000));
      const dateStr = uaeDate.toISOString().slice(0, 10);
      const isToday = dateStr === todayStr;
      
      const noteLC = (t.note ?? '').toLowerCase();
      const isClosure = noteLC.includes('closed') || noteLC.includes('stop') || noteLC.includes('limit') || noteLC.includes('liquid');
      const isOpening = noteLC.includes('open') || noteLC.includes('accepted');

      // P&L is only counted for closure transactions (to avoid double counting with opening or fees if they have sizes)
      if (isClosure && !isNaN(pnlValue)) {
        pnls30d.push(pnlValue);
        if (isToday) pnlsToday.push(pnlValue);
      } else if (t.transactionType === 'SWAP' || (t.transactionType === 'REBATE' && noteLC.includes('spread'))) {
        // Also count fees and rebates in 30d/Today totals
        if (!isNaN(pnlValue)) {
            pnls30d.push(pnlValue);
            if (isToday) pnlsToday.push(pnlValue);
        }
      }

      // Today-trade counting must reflect when the trade was OPENED, not when it closed.
      if (isToday && isOpening && !isClosure) {
        const dealId = String(t.dealId || t.reference || '');
        if (dealId && !todayDealIds.has(dealId)) {
          todayDealIds.add(dealId);
        }
      }
    });

    // Process open trades
    livePositions.forEach(p => {
      const createdStr = p.position?.createdDate || p.position?.date;
      const isToday = createdStr && new Date(new Date(createdStr).getTime() + (4 * 60 * 60 * 1000)).toISOString().slice(0, 10) === todayStr;
      
      if (isToday) {
        const dealId = String(p.position?.dealId || '');
        if (dealId) todayDealIds.add(dealId);
        
        const direction = p.position?.direction;
        if (direction === 'BUY') todayBuys++;
        else if (direction === 'SELL') todaySells++;
      }
    });

    const todayExecuted = todayDealIds.size;

    const totalPnl   = pnls30d.reduce((sum, p) => sum + p, 0);
    const wins       = pnls30d.filter(p => p > 0.001).length;
    const losses     = pnls30d.filter(p => p < -0.001).length;
    const winRate    = pnls30d.length > 0 ? parseFloat(((wins / pnls30d.length) * 100).toFixed(2)) : 0;
    const bestTrade  = pnls30d.length > 0 ? Math.max(...pnls30d) : 0;
    const worstTrade = pnls30d.length > 0 ? Math.min(...pnls30d) : 0;

    const sessionWins       = pnlsToday.filter(p => p > 0.001).length;
    const sessionWinRate    = pnlsToday.length > 0 ? parseFloat(((sessionWins / pnlsToday.length) * 100).toFixed(2)) : 0;
    const sessionBest       = pnlsToday.length > 0 ? Math.max(...pnlsToday) : 0;
    const sessionWorst      = pnlsToday.length > 0 ? Math.min(...pnlsToday) : 0;

    const sessionCount = pnlsToday.length;
    const finalSessionWorst = sessionCount > 0 ? Math.min(...pnlsToday) : 0;
    
    const grossProfitVal = pnls30d.filter(p => p > 0).reduce((sum, p) => sum + p, 0);
    const grossLossVal   = Math.abs(pnls30d.filter(p => p < 0).reduce((sum, p) => sum + p, 0));

    console.log(`[EXEC] fetchBrokerTradeStats: TodayExecuted ${todayExecuted} | WR ${sessionWinRate}%`);

    const todayNetPnl = pnlsToday.reduce((sum, p) => sum + p, 0);

    return {
      totalTrades: goldTransactions.length,
      totalPnl: parseFloat(totalPnl.toFixed(2)),
      grossProfit: parseFloat(grossProfitVal.toFixed(2)),
      grossLoss:   parseFloat(grossLossVal.toFixed(2)),
      wins, losses, winRate, bestTrade, worstTrade, pnls: pnls30d,
      todayTrades: todayExecuted,
      todayNetPnl: parseFloat(todayNetPnl.toFixed(2)),
      todayBuys, todaySells,
      todayWinRate: sessionWinRate,
      todayBest: sessionBest,
      todayWorst: finalSessionWorst,
      syncedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[EXEC] fetchBrokerTradeStats error:', err.message);
    return null;
  }
}


// ── calculatePositionSize ─────────────────────────────────────────────────────
// Leverage-aware and Currency-aware position sizing for Capital.com GOLD CFD.
export function calculatePositionSize(balanceAED, stopDistanceUSD, currentPriceUSD, availableMarginAED, riskMultiplier = 1.0) {
  if (isNaN(balanceAED) || balanceAED <= 0)          return { size: 0, error: 'Invalid balance' };
  if (isNaN(stopDistanceUSD) || stopDistanceUSD <= 0) return { size: 0, error: 'Invalid stop distance' };
  if (isNaN(currentPriceUSD) || currentPriceUSD <= 0) return { size: 0, error: 'Invalid current price' };

  const balanceUSD = balanceAED / USD_AED_PEG;

  if (stopDistanceUSD < MIN_STOP_DISTANCE) {
    return {
      size:  0,
      error: `Stop distance $${stopDistanceUSD.toFixed(3)} is below minimum $${MIN_STOP_DISTANCE} — would create oversized position`,
    };
  }

  const activeRiskPct     = RISK_PCT * riskMultiplier;
  const riskAmountUSD     = balanceUSD * activeRiskPct;             // default 2.0% of account, adjusted by multiplier
  const maxRiskUSD        = balanceUSD * MAX_RISK_PCT;          // Hard limit 3% for safety
  const sizeFromRisk      = riskAmountUSD / stopDistanceUSD;
  const sizeFromMargin    = availableMarginAED / (currentPriceUSD * GOLD_MARGIN_RATE * USD_AED_PEG * MARGIN_BUFFER);
  const riskSizedSize     = Math.min(sizeFromRisk, MAX_SIZE);

  let positionSize = Math.min(sizeFromRisk, sizeFromMargin, MAX_SIZE);
  positionSize = Math.floor(Math.max(positionSize, 0) * 100) / 100;

  if (sizeFromMargin < riskSizedSize) {
    const marginCappedSize = Math.floor(Math.max(Math.min(sizeFromMargin, MAX_SIZE), 0) * 100) / 100;
    console.log('[EXEC] Margin cap reduced position size', {
      sizeFromRisk: parseFloat(sizeFromRisk.toFixed(4)),
      sizeFromMargin: parseFloat(sizeFromMargin.toFixed(4)),
      riskSizedSize: parseFloat(riskSizedSize.toFixed(2)),
      marginCappedSize,
      availableMarginAED: parseFloat(availableMarginAED.toFixed(2)),
      finalSize: positionSize,
    });
  }

  if (positionSize < MIN_SIZE) {
    const minMarginWithBufferAED = MIN_SIZE * currentPriceUSD * GOLD_MARGIN_RATE * USD_AED_PEG * MARGIN_BUFFER;
    if (sizeFromMargin < MIN_SIZE) {
      return {
        size:  0,
        error: `Insufficient margin: need AED ${minMarginWithBufferAED.toFixed(2)} (with ${MARGIN_BUFFER}× buffer), have AED ${availableMarginAED.toFixed(2)}`,
      };
    }
    positionSize = MIN_SIZE;
  }

  const actualRiskUSD = parseFloat((positionSize * stopDistanceUSD).toFixed(2));
  const actualRiskAED = parseFloat((actualRiskUSD * USD_AED_PEG).toFixed(2));

  if (actualRiskUSD > maxRiskUSD) {
    return {
      size:  0,
      error: `Even minimum size (${MIN_SIZE}oz) risks $${actualRiskUSD.toFixed(2)} (AED ${actualRiskAED.toFixed(2)}), exceeding 3% balance cap ($${maxRiskUSD.toFixed(2)})`,
    };
  }

  const notionalValueUSD    = positionSize * currentPriceUSD;
  const marginRequiredUSD   = notionalValueUSD * GOLD_MARGIN_RATE;
  const marginRequiredAED   = marginRequiredUSD * USD_AED_PEG;
  const marginWithBufferAED = marginRequiredAED * MARGIN_BUFFER;

  if (availableMarginAED < marginWithBufferAED) {
    return {
      size:  0,
      error: `Insufficient margin: need AED ${marginWithBufferAED.toFixed(2)} (with ${MARGIN_BUFFER}× buffer), have AED ${availableMarginAED.toFixed(2)}`,
    };
  }

  return {
    size:              positionSize,
    actualRiskDollars: actualRiskUSD,
    actualRiskAED,
    notionalValue:     parseFloat(notionalValueUSD.toFixed(2)),
    marginRequired:    parseFloat(marginRequiredAED.toFixed(2)),
    leverage:          GOLD_LEVERAGE,
    marginRate:        GOLD_MARGIN_RATE,
    error:             null,
  };
}


// ── placeTrade ────────────────────────────────────────────────────────────────
export async function placeTrade(session, signal, botState) {
  try {
    const { baseUrl, cst, securityToken } = session;

    if (!signal || !signal.action || !signal.entryPrice || !signal.stopLoss || !signal.takeProfit) {
      return { success: false, reason: 'ERROR: Signal missing required fields', brokerResponse: null };
    }
    if (isNaN(signal.entryPrice) || isNaN(signal.stopLoss) || isNaN(signal.takeProfit)) {
      return { success: false, reason: 'ERROR: Signal contains NaN values', brokerResponse: null };
    }
    if (signal.action === 'BUY'  && signal.stopLoss >= signal.entryPrice) {
      return { success: false, reason: 'ERROR: BUY stop loss is not below entry price', brokerResponse: null };
    }
    if (signal.action === 'SELL' && signal.stopLoss <= signal.entryPrice) {
      return { success: false, reason: 'ERROR: SELL stop loss is not above entry price', brokerResponse: null };
    }
    if (signal.timestamp && (Date.now() - signal.timestamp) > MAX_SIGNAL_AGE_MS) {
      return { success: false, reason: `REJECTED: Signal is stale (${Math.round((Date.now() - signal.timestamp) / 1000)}s old)`, brokerResponse: null };
    }

    // ── PRE-TRADE: Verify no duplicate trade for this signal ────────────────
    if (Array.isArray(botState.openTrades)) {
      const alreadyOpen = botState.openTrades.some(t => t.tradeId === signal.id);
      if (alreadyOpen) {
        return { success: false, reason: 'ERROR: Trade with this signal ID is already open', brokerResponse: null };
      }
    }

    // ── PRE-TRADE: Verify state integrity ──────────────────────────────────
    if (botState.stateIntegrityOk === false || botState.criticalFailure === true) {
      return { success: false, reason: 'ERROR: State integrity compromised — refusing to trade until manual review', brokerResponse: null };
    }

    if (botState.riskDataFresh !== true) {
      return { success: false, reason: 'ERROR: Risk data is stale — refusing to trade', brokerResponse: null };
    }

    if (botState.pendingOrder && botState.pendingOrder.status !== 'cleared') {
      return { success: false, reason: 'ERROR: Pending order state is unresolved', brokerResponse: null };
    }

    const idempotencyKey = buildIdempotencyKey(signal);
    botState.recentOrderKeys = Array.isArray(botState.recentOrderKeys) ? botState.recentOrderKeys : [];
    if (botState.recentOrderKeys.includes(idempotencyKey)) {
      return { success: false, reason: 'ERROR: Duplicate idempotency key detected', brokerResponse: null };
    }

    const accountData = await fetchAccountData(session);
    if (!accountData) {
      return { success: false, reason: 'ERROR: Could not fetch account data for pre-trade margin check', brokerResponse: null };
    }
    const { balance, equity, availableMargin } = accountData;

    // ── PRE-TRADE: Log both balance and equity ────────────────────────────
    console.log(`[EXEC] Pre-trade account: balance=AED ${balance.toFixed(2)}, equity=AED ${equity.toFixed(2)}, margin=AED ${availableMargin.toFixed(2)}`);

    // ── EQUITY SAFETY CHECK: Ensure equity is above minimum threshold ─────────
    // Equity includes unrealized P&L. If equity is too low, market downturn could trigger liquidation.
    const minEquitySafetyMarginAED = 150; // Minimum equity buffer to keep bot safe
    if (equity < minEquitySafetyMarginAED) {
      return { 
        success: false, 
        reason: `REJECTED: Equity (AED ${equity.toFixed(2)}) below safety threshold (AED ${minEquitySafetyMarginAED}). Account at liquidation risk.`,
        brokerResponse: null,
      };
    }

    // ── Live slippage and spread check ───────────────────────────────────────
    const mktRes = await withRetries(async attempt => {
      const res = await fetchWithTimeout(`${baseUrl}/api/v1/markets/GOLD`, {
        headers: {
          'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
          'CST': cst,
          'X-SECURITY-TOKEN': securityToken,
        },
      });
      if (!res.ok) {
        throw new Error(`Market snapshot unavailable (HTTP ${res.status}) on attempt ${attempt}`);
      }
      return res;
    }, { attempts: 3, delayMs: 1000, backoffFactor: 2, label: 'placeTrade market snapshot' });

    const mktData = await mktRes.json();
    const snapshot = mktData.snapshot || {};
    const liveBid = parseFloat(snapshot.bid);
    const liveAsk = parseFloat(snapshot.offer ?? snapshot.ask);

    if (isNaN(liveBid) || isNaN(liveAsk) || liveAsk <= liveBid) {
      return { success: false, reason: 'REJECTED: Invalid live bid/ask snapshot', brokerResponse: null };
    }

    const spread = liveAsk - liveBid;
    const maxSpread = getAdaptiveSpreadLimit(process.env.MAX_SPREAD, signal.atr);
    if (spread > maxSpread) {
      return { success: false, reason: `REJECTED: Spread too wide ($${spread.toFixed(2)} > $${maxSpread.toFixed(2)})`, brokerResponse: null };
    }

    const executionPrice = signal.action === 'BUY' ? liveAsk : liveBid;
    const slippage = Math.abs(executionPrice - signal.entryPrice);
    const slippageLimit = Math.max(MAX_SLIPPAGE_BASE, signal.atr * 0.5);
    if (slippage > slippageLimit) {
      return { success: false, reason: `REJECTED: Slippage too high ($${slippage.toFixed(2)} > allowed limit $${slippageLimit.toFixed(2)})`, brokerResponse: null };
    }

    // ── SL/TP Calculation with Broker Minimum Distance Enforcement ──────────
    // 1. Calculate base levels using ATR multiplier
    let tentativeSL = signal.action === 'BUY'
      ? executionPrice - (EXECUTION_STOP_LOSS_ATR_MULTIPLIER * signal.atr)
      : executionPrice + (EXECUTION_STOP_LOSS_ATR_MULTIPLIER * signal.atr);
    
    // 2. Parse broker minimum stop distance.
    // Capital.com may return this field as { value: N, unit: '...' } or as a plain number.
    const minStopDist = parseStopDistanceField(snapshot.minControlledRiskStopDistance)
                     || parseStopDistanceField(snapshot.minNormalStopDistance)
                     || 0;

    // 3. If broker did not supply stop distance data, log a warning and proceed without
    //    broker-minimum enforcement. The ATR-based SL above is still applied.
    //    The broker will return a clear error if the SL is too close, which we handle below.
    if (minStopDist <= 0) {
      console.warn('[EXEC] Broker min stop distance not provided — proceeding with ATR-based SL (no broker minimum enforcement)', {
        minControlledRiskStopDistance: snapshot.minControlledRiskStopDistance,
        minNormalStopDistance:         snapshot.minNormalStopDistance,
      });
    }

    // 4. Safety: skip trade if broker minimum stop distance is too large vs ATR
    if (minStopDist > 0 && minStopDist > signal.atr * MAX_STOP_ATR_RATIO) {
      console.warn(`[EXEC] Stop distance too large vs ATR: minStopDist=${minStopDist.toFixed(2)} atr=${signal.atr.toFixed(2)} threshold=${(signal.atr * MAX_STOP_ATR_RATIO).toFixed(2)}`);
      return { success: false, reason: 'SKIPPED: stop distance too large vs ATR', brokerResponse: null };
    }

    const executionQuality = assessExecutionQuality({
      spread,
      maxSpread,
      slippage,
      slippageLimit,
      minStopDist,
      atr: signal.atr,
    });
    signal.executionQualityScore = executionQuality.score;
    signal.executionQuality = executionQuality;
    if (executionQuality.score < MIN_EXECUTION_QUALITY_SCORE) {
      return {
        success: false,
        reason: `REJECTED: Execution quality score ${executionQuality.score.toFixed(2)} below minimum ${MIN_EXECUTION_QUALITY_SCORE}`,
        brokerResponse: null,
        executionQuality,
      };
    }

    const distance = Math.abs(executionPrice - tentativeSL);

    if (minStopDist > 0 && distance < minStopDist) {
      console.log(`[EXEC] ATR stop dist ${distance.toFixed(2)} is below broker minimum ${minStopDist.toFixed(2)}. Adjusting SL to exact minimum.`);
      tentativeSL = signal.action === 'BUY'
        ? executionPrice - minStopDist
        : executionPrice + minStopDist;
    }

    const adjustedSL = tentativeSL;
    const adjustedTP = signal.action === 'BUY'
      ? executionPrice + (EXECUTION_TAKE_PROFIT_ATR_MULTIPLIER * signal.atr)
      : executionPrice - (EXECUTION_TAKE_PROFIT_ATR_MULTIPLIER * signal.atr);

    // ── Position sizing: use the ACTUAL execution SL distance, not the stale signal SL ──
    const stopDistance  = Math.abs(executionPrice - adjustedSL);
    const currentPrice  = executionPrice;
    const effectiveRiskMultiplier = resolveEffectiveRiskMultiplier(signal);
    const sizing        = calculatePositionSize(balance, stopDistance, currentPrice, availableMargin, effectiveRiskMultiplier);

    if (sizing.error || sizing.size <= 0) {
      return { success: false, reason: `REJECTED: Position sizing failed — ${sizing.error}`, brokerResponse: null };
    }

    const positionSize      = sizing.size;
    const actualRiskDollars = sizing.actualRiskDollars;
    const notionalValue     = sizing.notionalValue;
    const marginRequired    = sizing.marginRequired;
    const fillSlippage      = calculateFillSlippage(signal.entryPrice, executionPrice, signal.atr);

    const worstCaseMoveUsd = calculateDynamicWorstCaseMoveUsd(currentPrice, signal?.atr);
    if (worstCaseMoveUsd === null) {
      botState.pendingOrder = null;
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = 'INVALID_WORST_CASE_RISK_INPUTS';
      await saveStateCritical(botState, 'invalid_worst_case_risk_inputs');
      return { success: false, reason: 'CRITICAL_FAILURE: Dynamic worst-case risk model inputs invalid', brokerResponse: null };
    }

    const portfolioWorstCase = calculatePortfolioWorstCaseRiskAED(botState.openTrades, positionSize, worstCaseMoveUsd);
    if (!portfolioWorstCase.ok) {
      botState.pendingOrder = null;
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = `INVALID_PORTFOLIO_RISK_MODEL:${portfolioWorstCase.reason}`;
      await saveStateCritical(botState, `invalid_portfolio_risk_model:${portfolioWorstCase.reason}`);
      return { success: false, reason: 'CRITICAL_FAILURE: Portfolio worst-case risk model invalid', brokerResponse: null };
    }

    const portfolioWorstCaseAED = portfolioWorstCase.riskAED;
    const maxAllowedWorstCaseAED = equity * MAX_PORTFOLIO_WORST_CASE_EQUITY_PCT;
    if (portfolioWorstCaseAED > maxAllowedWorstCaseAED) {
      return {
        success: false,
        reason: `REJECTED: Portfolio worst-case risk AED ${portfolioWorstCaseAED.toFixed(2)} exceeds limit AED ${maxAllowedWorstCaseAED.toFixed(2)}`,
        brokerResponse: null,
      };
    }

    // ── FIX: Recalculate SL/TP from actual execution price ──────────────────
    // The signal's SL/TP were computed from the closed candle price at signal time.
    // The actual execution price may differ due to spread and market movement.
    // Using stale SL/TP systematically distorts true risk/reward.

    console.log('[EXEC] SL_DEBUG', {
      entryPrice:                          executionPrice,
      stopLoss:                            adjustedSL,
      distance:                            Math.abs(executionPrice - adjustedSL),
      minControlledRiskStopDistance:       snapshot.minControlledRiskStopDistance?.value,
      minNormalStopDistance:               snapshot.minNormalStopDistance?.value,
    });

    // ── Broker slippage gate ──────────────────────────────────────────────────
    const currentMarketPrice = executionPrice;
    const maxSlippage = parseFloat(snapshot.maxSlippage ?? snapshot.maxExecutionSlippage) || MAX_SLIPPAGE_BASE;
    const expectedSlippage = Math.abs(currentMarketPrice - signal.entryPrice);
    console.log('[EXEC] SLIPPAGE_DEBUG', {
      entryPrice: signal.entryPrice,
      currentMarketPrice,
      expectedSlippage,
      maxSlippage,
    });
    if (expectedSlippage > maxSlippage) {
      return {
        success: false,
        reason: 'SKIPPED: slippage too high',
        brokerResponse: null,
      };
    }

    const orderBody = {
      epic:          'GOLD',
      direction:     signal.action === 'BUY' ? 'BUY' : 'SELL',
      size:          positionSize,
      guaranteedStop: false,  // TEST MODE: disabled to confirm if guaranteed stops cause broker rejection
      stopLevel:     parseFloat(adjustedSL.toFixed(2)),
      profitLevel:   parseFloat(adjustedTP.toFixed(2)),
    };

    const requestId = randomUUID();
    botState.pendingOrder = {
      idempotencyKey,
      signalId: signal.id,
      requestId,
      status: 'submitting',
      expectedSize: positionSize,
      createdAt: Date.now(),
    };

    const pendingSaved = await saveStateCritical(botState, `pending_order:${idempotencyKey}`);
    if (!pendingSaved) {
      return { success: false, reason: 'CRITICAL_FAILURE: Pending order state save failed', brokerResponse: null };
    }

    const res = await fetchWithTimeout(`${baseUrl}/api/v1/positions`, {
      method: 'POST',
      headers: {
        'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
        'CST': cst,
        'X-SECURITY-TOKEN': securityToken,
        'Content-Type': 'application/json',
        'X-REQUEST-ID': requestId,
        'X-IDEMPOTENCY-KEY': idempotencyKey,
      },
      body: JSON.stringify(orderBody),
    });

    let result;
    try {
      result = await res.json();
    } catch (_) {
      botState.pendingOrder.status = 'unknown';
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = 'ORDER_RESPONSE_INVALID_JSON';
      await saveStateCritical(botState, 'order_response_invalid_json');
      return { success: false, reason: 'CRITICAL_FAILURE: Invalid order response payload' };
    }

    if (!res.ok || result.errorCode) {
      botState.pendingOrder.status = 'rejected';
      botState.pendingOrder.errorCode = result.errorCode || null;
      botState.pendingOrder.rejectedAt = Date.now();
      await saveStateCritical(botState, `order_rejected:${idempotencyKey}`);
      botState.pendingOrder = null;
      await saveStateCritical(botState, `order_rejected_clear:${idempotencyKey}`);
      const brokerResponse = {
        errorCode:                    result.errorCode                    || null,
        message:                      result.message                      || null,
        minControlledRiskStopDistance: result.minControlledRiskStopDistance ?? null,
        minNormalStopDistance:         result.minNormalStopDistance         ?? null,
        stopLevel:                     result.stopLevel                     ?? null,
        dealReference:                 result.dealReference                 ?? null,
      };
      console.warn('[EXEC] Order rejected by broker:', brokerResponse);
      return { success: false, reason: `REJECTED: ${result.errorCode || result.message || 'Order rejected'}`, brokerResponse };
    }

    const dealReference = result.dealReference;
    if (!dealReference) {
      botState.pendingOrder.status = 'unknown';
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = 'ORDER_ACCEPTED_WITHOUT_REFERENCE';
      await saveStateCritical(botState, `order_unknown:${idempotencyKey}`);
      return { success: false, reason: 'CRITICAL_FAILURE: No dealReference in order response' };
    }

    let confirm;
    try {
      confirm = await fetchDealConfirmation(session, dealReference);
    } catch (err) {
      botState.pendingOrder.status = 'unknown';
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = `ORDER_CONFIRMATION_UNAVAILABLE:${dealReference}`;
      await saveStateCritical(botState, `confirm_unavailable:${dealReference}`);
      return { success: false, reason: `CRITICAL_FAILURE: ${err.message}` };
    }

    const dealStatus = String(confirm?.dealStatus || '').toUpperCase();
    if (dealStatus !== 'ACCEPTED') {
      botState.pendingOrder.status = 'unknown';
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = `ORDER_NOT_ACCEPTED:${dealStatus || 'UNKNOWN'}`;
      await saveStateCritical(botState, `order_not_accepted:${dealReference}`);
      return { success: false, reason: `CRITICAL_FAILURE: Order not accepted (${dealStatus || 'UNKNOWN'})` };
    }

    const fillValidation = extractStrictFilledSize(confirm, positionSize);
    if (!fillValidation.ok) {
      botState.pendingOrder.status = 'critical_failure';
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = `CRITICAL_FILL_VALIDATION_FAILURE:${dealReference}:${fillValidation.reason}`;
      await saveStateCritical(botState, `critical_fill_validation_failure:${dealReference}:${fillValidation.reason}`);
      return { success: false, reason: `CRITICAL_FAILURE: Fill validation failed for ${dealReference}: ${fillValidation.reason}` };
    }

    if (!sizesMatchExactly(fillValidation.filledSize, positionSize)) {
      botState.pendingOrder.status = 'partial_or_unknown_fill';
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = `PARTIAL_OR_UNKNOWN_FILL:${dealReference}`;
      await saveStateCritical(botState, `partial_or_unknown_fill:${dealReference}`);
      return { success: false, reason: 'CRITICAL_FAILURE: Partial or unknown fill detected' };
    }

    // EXTRACT THE REAL DEAL ID (position identifier)
    // This is the SINGLE SOURCE OF TRUTH for this position moving forward.
    const actualDealId = fillValidation.actualDealId;
    if (!actualDealId) {
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = `MISSING_DEAL_ID_IN_CONFIRMATION:${dealReference}`;
      await saveStateCritical(botState, `missing_deal_id:${dealReference}`);
      return { success: false, reason: `CRITICAL_FAILURE: Broker confirmed ACCEPTED but did not return a dealId (ref=${dealReference})` };
    }

    const finalDealId = actualDealId;

    // ── CRITICAL: Record trade in local state IMMEDIATELY ─────────────────────
    botState.recentTradeIds = Array.isArray(botState.recentTradeIds) ? botState.recentTradeIds : [];
    botState.recentTradeIds.push(signal.id);
    botState.recentTradeIds = botState.recentTradeIds.slice(-20);

    botState.openTrades = Array.isArray(botState.openTrades) ? botState.openTrades : [];

    const openedAt = Date.now();

    const tradeRecord = {
      tradeId:         signal.id,
      dealId:          finalDealId,
      dealReference:   dealReference,
      pair:            'GOLD',
      action:          signal.action,
      entry:           executionPrice,
      size:            positionSize,
      initialSize:     positionSize,
      stopLoss:        adjustedSL,
      takeProfit:      adjustedTP,
      atr:             signal.atr,
      initialStopLoss: adjustedSL,
      initialTakeProfit: adjustedTP,
      breakEvenMoved:  false,
      profitLockStage: null,
      lastStopLockR:   null,
      exitPlanVersion: signal.exitPlanVersion || EXIT_PLAN_VERSION,
      managementState: signal.managementState || EXIT_STATE.OPEN_FULL,
      partial1Filled:  false,
      partial2Filled:  false,
      remainingSize:   positionSize,
      realizedPartialR: 0,
      unrealizedR:     0,
      bestRBeforeFirstPartial: null,
      mfeBeforeTP1:    null,
      timeToTP1Ms:     null,
      timeToBETriggerMs: null,
      trailActivated:  false,
      trailStop:       null,
      partialCloseEvents: [],
      notionalValue,
      marginRequired,
      actualRiskDollars,
      effectiveRiskMultiplier,
      intendedEntryPrice: fillSlippage.intendedEntryPrice,
      actualFillPrice: fillSlippage.actualFillPrice,
      absoluteSlippage: fillSlippage.absoluteSlippage,
      slippageToATR: fillSlippage.slippageToATR,
      fillQuality: fillSlippage.fillQuality,
      executionQualityScore: executionQuality.score,
      executionQuality,
      openedAt,
      entryType:       signal.entryType || 'unknown',
      strategyVersion: signal.strategyVersion || STRATEGY_VERSION,
      missingCount:    0,
    };
    tradeRecord.audit = createTradePathAudit(tradeRecord);

    botState.openTrades.push(tradeRecord);
    botState.dailyTrades        = (botState.dailyTrades ?? 0) + 1;
    botState.lastOrderTimestamp = openedAt;
    botState.pendingOrder = null;
    botState.recentOrderTimestamps = Array.isArray(botState.recentOrderTimestamps)
      ? botState.recentOrderTimestamps
      : [];
    botState.recentOrderTimestamps = botState.recentOrderTimestamps
      .map(ts => Number(ts))
      .filter(ts => Number.isFinite(ts) && openedAt - ts < 60 * 1000);
    botState.recentOrderTimestamps.push(openedAt);
    botState.recentOrderTimestamps = botState.recentOrderTimestamps.slice(-2);
    botState.recentOrderKeys.push(idempotencyKey);
    botState.recentOrderKeys = botState.recentOrderKeys.slice(-100);

    // ── CRITICAL SAVE: Persist state immediately after trade open ──────────────
    // This prevents "discovered" trades — if the process crashes after this point,
    // the trade is already saved and will be found on next startup.
    const slDist = Math.abs(executionPrice - adjustedSL);
    const tpDist = Math.abs(executionPrice - adjustedTP);
    const rrRatio = slDist > 0 ? (tpDist / slDist).toFixed(2) : '0';

    console.log(`[EXEC] ✅ TRADE OPENED (${signal.entryType}): ${signal.action} ${positionSize}oz GOLD @ ${executionPrice.toFixed(2)} | dealId=${finalDealId}`);
    console.log(`[EXEC] SL distance: $${slDist.toFixed(2)} | TP distance: $${tpDist.toFixed(2)} | RR ratio: ${rrRatio}`);
    
    const saved = await saveStateCritical(botState, `trade_opened:${finalDealId}`);
    if (!saved) {
      return { success: false, reason: 'CRITICAL_FAILURE: Trade executed but state save failed' };
    }

    // The post-trade certainty check was removed because Capital.com's /positions endpoint 
    // is often eventually consistent. The synchronous fetchDealConfirmation above is 
    // sufficient to guarantee execution before we recorded the trade.

    return {
      success:          true,
      dealId:           finalDealId,
      dealReference:    dealReference,
      size:             positionSize,
      entry:            executionPrice,
      stopLoss:         adjustedSL,
      takeProfit:       adjustedTP,
      actualRiskDollars,
      notionalValue,
      marginRequired,
      leverage:         GOLD_LEVERAGE,
      idempotencyKey,
      effectiveRiskMultiplier,
      intendedEntryPrice: fillSlippage.intendedEntryPrice,
      actualFillPrice: fillSlippage.actualFillPrice,
      absoluteSlippage: fillSlippage.absoluteSlippage,
      slippageToATR: fillSlippage.slippageToATR,
      fillQuality: fillSlippage.fillQuality,
      executionQualityScore: executionQuality.score,
      executionQuality,
      audit:            tradeRecord.audit,
    };

  } catch (err) {
    console.error('[EXEC] placeTrade error:', err.message);
    if (botState && botState.pendingOrder && botState.pendingOrder.status !== 'cleared') {
      botState.pendingOrder.status = 'unknown';
      botState.pendingOrder.error = err.message;
      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = err?.code === 'FETCH_TIMEOUT'
        ? 'CRITICAL_TIMEOUT_DURING_ORDER'
        : 'CRITICAL_UNCERTAIN_ORDER_STATE';
      await saveStateCritical(botState, 'place_trade_exception');
      return { success: false, reason: `CRITICAL_FAILURE: ${botState.criticalFailureReason}` };
    }
    return { success: false, reason: `ERROR: ${err.message}` };
  }
}

/**
 * Fetches the current GOLD bid/offer snapshot from Capital.com.
 * Used by reconcilePositions to estimate P&L for MIA (fallback-resolved) trades.
 * @param {Object} session - Capital.com session
 * @returns {Promise<{bid: number, offer: number, minStopDistance: number|null}|null>}
 */
export async function fetchCurrentGoldPrice(session) {
  try {
    const { baseUrl, cst, securityToken } = session;
    const res = await withRetries(async attempt => {
      const response = await fetchWithTimeout(`${baseUrl}/api/v1/markets/GOLD`, {
        headers: {
          'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
          'CST':              cst,
          'X-SECURITY-TOKEN': securityToken,
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} on attempt ${attempt}`);
      }
      return response;
    }, { attempts: 3, delayMs: 750, backoffFactor: 2, label: 'fetchCurrentGoldPrice' });
    let data;
    try { data = await res.json(); } catch { return null; }
    const snapshot = data.snapshot || {};
    const bid   = parseFloat(snapshot.bid);
    const offer = parseFloat(snapshot.offer ?? snapshot.ask);
    if (!Number.isFinite(bid) || !Number.isFinite(offer) || bid <= 0 || offer <= 0) return null;
    const minStopDistance = parseStopDistanceField(snapshot.minControlledRiskStopDistance)
                         || parseStopDistanceField(snapshot.minNormalStopDistance)
                         || 0;
    return {
      bid,
      offer,
      minStopDistance: minStopDistance > 0 ? minStopDistance : null,
    };
  } catch (err) {
    console.warn('[EXEC] fetchCurrentGoldPrice error:', err.message);
    return null;
  }
}

/**
 * Modifies an existing position's stop loss and/or take profit on Capital.com.
 * @param {Object} session - Capital.com session
 * @param {string} dealId - The position's dealId
 * @param {Object} levels - { stopLevel, profitLevel }
 */
export async function modifyTradeStopLoss(session, dealId, levels) {
  try {
    const { baseUrl, cst, securityToken } = session;
    const res = await fetchWithTimeout(`${baseUrl}/api/v1/positions/${dealId}`, {
      method: 'PUT',
      headers: {
        'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
        'CST':              cst,
        'X-SECURITY-TOKEN': securityToken,
        'Content-Type':     'application/json',
      },
      body: JSON.stringify(levels),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '(unreadable)');
      console.error(`[EXEC] Failed to modify trade ${dealId} (HTTP ${res.status}): ${body}`);
      return { success: false, reason: `HTTP_${res.status}` };
    }

    const data = await res.json();
    return { success: true, dealReference: data.dealReference };
  } catch (err) {
    console.error(`[EXEC] modifyTrade error for ${dealId}:`, err.message);
    return { success: false, reason: err.message };
  }
}

/**
 * Partially closes an existing Capital.com position.
 * Capital.com supports closing a position through DELETE /positions/{dealId};
 * size is supplied to close less than the full position.
 */
export async function closePartialPosition(session, dealId, { size }) {
  try {
    const closeSize = Number(size);
    if (!Number.isFinite(closeSize) || closeSize < MIN_SIZE) {
      return { success: false, reason: 'INVALID_PARTIAL_SIZE' };
    }

    const { baseUrl, cst, securityToken } = session;
    const res = await fetchWithTimeout(`${baseUrl}/api/v1/positions/${dealId}`, {
      method: 'DELETE',
      headers: {
        'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
        'CST':              cst,
        'X-SECURITY-TOKEN': securityToken,
        'Content-Type':     'application/json',
      },
      body: JSON.stringify({ size: closeSize }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '(unreadable)');
      console.error(`[EXEC] Failed to partial-close trade ${dealId} size=${closeSize} (HTTP ${res.status}): ${body}`);
      return { success: false, reason: `HTTP_${res.status}` };
    }

    const data = await res.json().catch(() => ({}));
    return { success: true, dealReference: data.dealReference ?? null, closedSize: closeSize };
  } catch (err) {
    console.error(`[EXEC] closePartialPosition error for ${dealId}:`, err.message);
    return { success: false, reason: err.message };
  }
}
