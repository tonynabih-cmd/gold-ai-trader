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
    
    // Define London to end of NY roughly as 07:00 UTC to 21:00 UTC
    if (timeFloat < 7 || timeFloat > 21) {
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

