// risk.js — 21-rule safety gate. Every rule is checked before ANY trade is placed.
// Returns 'APPROVED' only when ALL rules pass. Any other return = no trade.

export function calculateDrawdown(peakBalance, equityOrBalance) {
  const peak = parseFloat(peakBalance) || 0;
  const equity = parseFloat(equityOrBalance) || 0;
  if (peak <= 0) return 0;
  return ((peak - equity) / peak) * 100;
}

const GOLD_MARGIN_RATE = 0.05;
const MARGIN_BUFFER = 1.5;
const GOLD_MIN_SIZE = 0.01;
const GOLD_MAX_SIZE = 1.0;
const USD_AED_PEG = 3.6725;
const CANDLE_MS = 5 * 60 * 1000;
const SAME_DIRECTION_STOP_COOLDOWN_CANDLES = 3;
const PULLBACK_EXTENSION_ATR_CAP = 2.0;
const ROLLING_PF_WINDOW = 5;
const ROLLING_PF_KILL_THRESHOLD = 0.7;

function normalizeDirection(direction) {
  const value = String(direction || '').toUpperCase();
  return value === 'BUY' || value === 'SELL' ? value : null;
}

function trendForAction(action) {
  if (action === 'BUY') return 'UP';
  if (action === 'SELL') return 'DOWN';
  return null;
}

function isStopLossOutcome(outcome) {
  if (!outcome || typeof outcome.pnl !== 'number') return false;
  if (outcome.exitReason === 'STOP_LOSS') return true;
  return outcome.pnl < -0.001;
}

function getSignalCandleTime(signal) {
  const fromId = Number(String(signal?.id || '').split('_')[0]);
  if (Number.isFinite(fromId) && fromId > 0) return fromId;
  const fromTimestamp = Number(signal?.timestamp);
  return Number.isFinite(fromTimestamp) && fromTimestamp > 0 ? fromTimestamp : Date.now();
}

function calculateProfitFactor(outcomes) {
  const grossProfit = outcomes
    .filter(o => typeof o?.pnl === 'number' && o.pnl > 0)
    .reduce((sum, o) => sum + o.pnl, 0);
  const grossLoss = Math.abs(outcomes
    .filter(o => typeof o?.pnl === 'number' && o.pnl < 0)
    .reduce((sum, o) => sum + o.pnl, 0));

  if (grossLoss === 0) return grossProfit > 0 ? 999 : 0;
  return grossProfit / grossLoss;
}

function ensureDirectionalCircuitState(botState) {
  if (!botState.directionalLossCircuit || typeof botState.directionalLossCircuit !== 'object') {
    botState.directionalLossCircuit = {};
  }
  for (const action of ['BUY', 'SELL']) {
    if (!botState.directionalLossCircuit[action] || typeof botState.directionalLossCircuit[action] !== 'object') {
      botState.directionalLossCircuit[action] = { active: false, activatedAt: 0, resetTrend: trendForAction(action) };
    }
  }
  return botState.directionalLossCircuit;
}

function getRecentOutcomes(botState) {
  return Array.isArray(botState?.recentOutcomes)
    ? botState.recentOutcomes.filter(o => o && typeof o.pnl === 'number')
    : [];
}

function hasTwoConsecutiveSameDirectionStopLosses(outcomes, action) {
  const sameDirection = outcomes
    .filter(o => normalizeDirection(o.action) === action)
    .slice(-2);
  return sameDirection.length === 2 && sameDirection.every(isStopLossOutcome);
}

export function resetDirectionalLossCircuitOnTrendReset(botState, indicators) {
  const circuit = ensureDirectionalCircuitState(botState);
  const trend = String(indicators?.trend1h || '').toUpperCase();
  let changed = false;

  for (const action of ['BUY', 'SELL']) {
    if (!circuit[action].active) continue;
    const blockedTrend = trendForAction(action);
    if (trend && trend !== blockedTrend) {
      circuit[action] = {
        active: false,
        activatedAt: 0,
        resetAt: Date.now(),
        resetTrend: trend,
      };
      changed = true;
    }
  }

  return changed;
}

export function getAdaptiveSpreadLimit(baseSpreadLimit, atr) {
  const base = parseFloat(baseSpreadLimit) || 0.5;
  const atrValue = parseFloat(atr);
  if (!Number.isFinite(atrValue) || atrValue <= 0) return base;
  return Math.min(0.80, Math.max(base, parseFloat((atrValue * 0.17).toFixed(2))));
}

function estimateMarginAwareSize(signal, balanceAED, availableMarginAED, riskMultiplier = 1.0) {
  const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);
  if (!Number.isFinite(stopDistance) || stopDistance <= 0.50) {
    return { estimatedSize: GOLD_MIN_SIZE, marginWithBufferAED: signal.entryPrice * GOLD_MIN_SIZE * GOLD_MARGIN_RATE * USD_AED_PEG * MARGIN_BUFFER };
  }

  const activeRiskPct = 0.02 * riskMultiplier;
  const riskAmountUSD = (balanceAED / USD_AED_PEG) * activeRiskPct;
  const riskSize = riskAmountUSD / stopDistance;
  const marginCapSize = availableMarginAED / (signal.entryPrice * GOLD_MARGIN_RATE * USD_AED_PEG * MARGIN_BUFFER);
  const rawSize = Math.min(riskSize, marginCapSize, GOLD_MAX_SIZE);
  const estimatedSize = Math.floor(Math.max(rawSize, 0) * 100) / 100;
  const marginWithBufferAED = estimatedSize * signal.entryPrice * GOLD_MARGIN_RATE * USD_AED_PEG * MARGIN_BUFFER;

  return { estimatedSize, marginWithBufferAED };
}

export function checkRisk(signal, botState, indicators) {
  try {
    const now  = new Date();
    const hour = now.getUTCHours();
    const day  = now.getUTCDay(); 

    // ── RULE 1: Environment kill switch ──────────────────────────────────────
    if (process.env.BOT_ENABLED !== 'true') return 'SKIP: Bot disabled via environment';

    const spreadLimit = getAdaptiveSpreadLimit(process.env.MAX_SPREAD, indicators?.atr);

    // ── RULE 2: State kill switches ───────────────────────────────────────────
    if (botState.botEnabled === false) return 'SKIP: Bot disabled via state (drawdown or performance threshold)';
    if (botState.stateIntegrityOk === false) return 'STOP: State integrity compromised — manual review required';
    if (botState.criticalFailure === true) return 'STOP: Critical failure active — manual recovery required';
    if (botState.riskDataFresh !== true) return 'STOP: Risk data stale — broker stats sync required';

    const riskSyncAgeMs = Date.now() - (parseInt(botState.lastRiskSyncAt) || 0);
    if (riskSyncAgeMs > 6 * 60 * 1000) return 'STOP: Risk data expired — broker stats must be refreshed';

    // ── RULE 3: Soft Liquidity Multiplier (Asia Session vs London/NY) ─────────
    const min = now.getUTCMinutes();
    const timeFloat = hour + min / 60;
    
    // Define London to end of NY roughly as 07:00 UTC to 18:05 UTC (10:05 PM UAE)
    if (timeFloat < 7 || timeFloat > 18.08) {
      if (signal) signal.riskMultiplier = 0.5; // Reduce position size for low liquidity / Asia session
    } else {
      if (signal) signal.riskMultiplier = 1.0; // Normal risk for London / NY session
    }

    // ── RULE 4: Signal checks ──────────────────────────────────────────────────
    if (!signal) return 'SKIP: No signal generated this cycle';

    if (
      typeof signal.entryPrice !== 'number' || isNaN(signal.entryPrice) ||
      typeof signal.stopLoss   !== 'number' || isNaN(signal.stopLoss)   ||
      typeof signal.takeProfit !== 'number' || isNaN(signal.takeProfit)
    ) return 'SKIP: Signal has invalid or missing fields';

    // ── RULE 5: Stop loss direction sanity ───────────────────────────────────
    if (!signal.action || (signal.action !== 'BUY' && signal.action !== 'SELL'))
      return 'SKIP: Signal action must be BUY or SELL';
    if (signal.action === 'BUY'  && signal.stopLoss >= signal.entryPrice)
      return 'SKIP: BUY stop loss is not below entry price';
    if (signal.action === 'SELL' && signal.stopLoss <= signal.entryPrice)
      return 'SKIP: SELL stop loss is not above entry price';

    const action = normalizeDirection(signal.action);
    const recentOutcomes = getRecentOutcomes(botState);
    const signalCandleTime = getSignalCandleTime(signal);

    // ── RULE 5A: Rolling expectancy kill switch ───────────────────────────────
    const last5Outcomes = recentOutcomes.slice(-ROLLING_PF_WINDOW);
    if (last5Outcomes.length === ROLLING_PF_WINDOW) {
      const rollingProfitFactor5 = calculateProfitFactor(last5Outcomes);
      botState.rollingProfitFactor5 = parseFloat(rollingProfitFactor5.toFixed(2));
      if (rollingProfitFactor5 < ROLLING_PF_KILL_THRESHOLD) {
        botState.botEnabled = false;
        botState.performanceReviewNeeded = true;
        botState.performanceReviewReason = `PF 5=${rollingProfitFactor5.toFixed(2)} < ${ROLLING_PF_KILL_THRESHOLD.toFixed(2)}`;
        return `DISABLE: Rolling 5-trade profit factor ${rollingProfitFactor5.toFixed(2)} below ${ROLLING_PF_KILL_THRESHOLD.toFixed(2)} — expectancy kill switch`;
      }
    }

    // ── RULE 5B: Same-direction cooldown after stop loss ──────────────────────
    const lastSameDirectionStopLoss = recentOutcomes
      .filter(o => normalizeDirection(o.action) === action && isStopLossOutcome(o))
      .slice(-1)[0];
    if (lastSameDirectionStopLoss?.closedAt) {
      const cooldownUntil = Math.floor(Number(lastSameDirectionStopLoss.closedAt) / CANDLE_MS) * CANDLE_MS
        + (SAME_DIRECTION_STOP_COOLDOWN_CANDLES * CANDLE_MS);
      if (signalCandleTime <= cooldownUntil) {
        return `PAUSE: ${action} cooldown after stop loss — wait ${SAME_DIRECTION_STOP_COOLDOWN_CANDLES} completed candles`;
      }
    }

    // ── RULE 5C: Consecutive same-direction stop-loss circuit breaker ─────────
    const circuit = ensureDirectionalCircuitState(botState);
    if (hasTwoConsecutiveSameDirectionStopLosses(recentOutcomes, action)) {
      circuit[action] = {
        active: true,
        activatedAt: circuit[action].activatedAt || Date.now(),
        resetTrend: trendForAction(action),
      };
    }
    if (circuit[action]?.active) {
      return `PAUSE: ${action} circuit breaker active after 2 same-direction stop losses — waiting for 1h trend reset`;
    }

    // ── RULE 5D: No same-direction pullback clustering ────────────────────────
    const hasSameDirectionOpenPullback = Array.isArray(botState.openTrades) && botState.openTrades.some(t =>
      normalizeDirection(t?.action ?? t?.direction) === action &&
      String(t?.entryType || '').toLowerCase() === 'pullback'
    );
    if (signal.entryType === 'pullback' && hasSameDirectionOpenPullback) {
      return `PAUSE: ${action} pullback clustering blocked — same-direction pullback already open`;
    }

    // ── RULE 5E: Pullback extension guard ─────────────────────────────────────
    if (signal.entryType === 'pullback') {
      const ema20 = Number(indicators?.currEMA20);
      const atrValue = Number(indicators?.atr ?? signal.atr);
      if (!Number.isFinite(ema20) || !Number.isFinite(atrValue) || atrValue <= 0) {
        return 'SKIP: Pullback extension guard missing EMA20/ATR';
      }
      const extensionAtr = Math.abs(signal.entryPrice - ema20) / atrValue;
      if (extensionAtr > PULLBACK_EXTENSION_ATR_CAP) {
        return `SKIP: Pullback entry extended ${extensionAtr.toFixed(2)} ATR from EMA20 (cap ${PULLBACK_EXTENSION_ATR_CAP.toFixed(2)})`;
      }
    }

    // ── RULE 6: Spread check ─────────────────────────────────────────────────
    if (typeof indicators.spread !== 'number' || isNaN(indicators.spread))
      return 'SKIP: Spread unavailable - skipping for safety';
    if (indicators.spread > spreadLimit)
      return 'SKIP: high spread';

    // ── RULE 7: Max open positions ───────────────────────────────────────────
    if (Array.isArray(botState.openTrades) && botState.openTrades.length >= 2)
      return `SKIP: Max 2 positions open (currently ${botState.openTrades.length})`;

    // ── RULE 8: Daily loss limit ──────────────────────────────────────────────
    const dailyLoss = parseFloat(botState.dailyLoss);
    const balance   = parseFloat(botState.balance);
    const dailyLossLimitPct = 0.05; 
    if (balance > 0 && dailyLoss >= balance * dailyLossLimitPct)
      return 'STOP: daily loss limit reached';

    // ── RULE 9: Total drawdown hard stop ──────────────────────────────────────
    const equity = parseFloat(botState.equity || botState.balance);
    const peak   = parseFloat(botState.peakBalance);
    if (peak > 0) {
      const equityDrawdown = calculateDrawdown(peak, equity);
      if (equityDrawdown >= 20) {
        botState.botEnabled = false;
        return `DISABLE: Equity drawdown (${equityDrawdown.toFixed(2)}%) reached limit (20%) — bot disabled. Status: Real-time risk exposure too high.`;
      }
    }

    if (isNaN(balance) || balance <= 0)
      return 'SKIP: Balance not yet synced from Capital.com';
    if (balance < 80)
      return `SKIP: Balance too low for minimum size (need 80 AED, have ${balance.toFixed(2)})`;

    // ── RULE 10: Margin buffer check ──────────────────────────────────────────
    const availableMargin = parseFloat(botState.availableMargin);
    if (!isNaN(availableMargin) && availableMargin > 0) {
      const { estimatedSize, marginWithBufferAED } = estimateMarginAwareSize(
        signal,
        balance,
        availableMargin,
        signal.riskMultiplier || 1.0
      );

      if (estimatedSize < GOLD_MIN_SIZE) {
        return `SKIP: Insufficient margin — need AED ${marginWithBufferAED.toFixed(2)} (with 1.5× buffer), have AED ${availableMargin.toFixed(2)}`;
      }
    }

    // ── RULE 11: Duplicate trade ID ───────────────────────────────────────────
    if (Array.isArray(botState.recentTradeIds) && botState.recentTradeIds.includes(signal.id))
      return 'SKIP: Duplicate signal ID - already processed this signal';

    return 'APPROVED';

  } catch (err) {
    return `SKIP: Risk check error - ${err.message}`;
  }
}

