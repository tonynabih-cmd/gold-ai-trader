// risk.js — 21-rule safety gate. Every rule is checked before ANY trade is placed.
// Returns 'APPROVED' only when ALL rules pass. Any other return = no trade.

export function checkRisk(signal, botState, indicators) {
  try {
    const now  = new Date();
    const hour = now.getUTCHours();
    const day  = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat

    // ── RULE 1: Environment kill switch ──────────────────────────────────────
    // Hard stop via Vercel env var — change to 'false' and redeploy to stop bot instantly.
    if (process.env.BOT_ENABLED !== 'true')
      return 'SKIP: Bot disabled via environment';

    // ── Pre-calculate Spread Limit for logs ────────────────────────────────────
    const spreadLimit = parseFloat(process.env.MAX_SPREAD) || 0.40;
    if (!signal) {
      console.log(`Risk Check: MAX_SPREAD = ${process.env.MAX_SPREAD || 'unset'}, activeLimit = ${spreadLimit.toFixed(2)}`);
    }

    // ── RULE 2: State kill switch ─────────────────────────────────────────────
    // Set by monitor.js when drawdown or profit factor thresholds are breached.
    if (botState.botEnabled === false)
      return 'SKIP: Bot disabled via state (drawdown or performance threshold)';

    // ── RULE 2A: Integrity check ──────────────────────────────────────────────
    if (botState.stateIntegrityOk === false)
      return 'STOP: State integrity compromised — manual review required';

    // ── RULE 2B: Critical failure latch ───────────────────────────────────────
    if (botState.criticalFailure === true)
      return 'STOP: Critical failure active — manual recovery required';

    // ── RULE 2C: Risk data freshness is mandatory ─────────────────────────────
    if (botState.riskDataFresh !== true)
      return 'STOP: Risk data stale — broker stats sync required';

    const riskSyncAgeMs = Date.now() - (parseInt(botState.lastRiskSyncAt) || 0);
    if (riskSyncAgeMs > 6 * 60 * 1000)
      return 'STOP: Risk data expired — broker stats must be refreshed';

    // ── RULE 3: Weekend ───────────────────────────────────────────────────────
    // Gold market is closed Saturday and Sunday.
    if (day === 6 || day === 0)
      return 'SKIP: Weekend - market closed';

    // ── RULE 4: Friday close ──────────────────────────────────────────────────
    // Stop trading Friday at 8PM UAE = 16:00 UTC to avoid weekend gap risk.
    // MUST be checked BEFORE general hours rule to catch Friday 16:00-18:00 window.
    if (day === 5 && hour >= 16)
      return 'SKIP: Friday close - weekend gap risk (after 8PM UAE)';

    // ── RULE 5: Golden Hour only ──────────────────────────────────────────────
    // 11AM–8PM UAE = 07:00–16:00 UTC = London open + NY open overlap.
    // Tightest spreads, strongest EMA signals, highest gold volume globally.
    if (hour < 7 || hour >= 16)
      return 'SKIP: Outside Golden Hour (11AM-8PM UAE / 07:00-16:00 UTC)';

    // ── RULE 6: Signal must exist ─────────────────────────────────────────────
    if (!signal)
      return 'SKIP: No signal generated this cycle';

    // ── RULE 7: Signal must have required fields ──────────────────────────────
    if (
      typeof signal.entryPrice !== 'number' || isNaN(signal.entryPrice) ||
      typeof signal.stopLoss   !== 'number' || isNaN(signal.stopLoss)   ||
      typeof signal.takeProfit !== 'number' || isNaN(signal.takeProfit) ||
      typeof signal.score      !== 'number' || isNaN(signal.score)
    ) return 'SKIP: Signal has invalid or missing fields';

    // ── RULE 8: Stop loss direction sanity ───────────────────────────────────
    // BUY stop loss MUST be below entry. SELL stop loss MUST be above entry.
    if (!signal.action || (signal.action !== 'BUY' && signal.action !== 'SELL'))
      return 'SKIP: Signal action must be BUY or SELL';
    if (signal.action === 'BUY'  && signal.stopLoss >= signal.entryPrice)
      return 'SKIP: BUY stop loss is not below entry price';
    if (signal.action === 'SELL' && signal.stopLoss <= signal.entryPrice)
      return 'SKIP: SELL stop loss is not above entry price';

    // ── RULE 9: ATR range ─────────────────────────────────────────────────────
    if (typeof indicators.atr !== 'number' || isNaN(indicators.atr))
      return 'SKIP: ATR missing or invalid (null/undefined)';
    // ATR range: 1.2 to 50
    if (indicators.atr < 1.2)
      return `SKIP: ATR too low (volatility floor: 1.2, got ${indicators.atr.toFixed(2)})`;
    if (indicators.atr > 50)
      return `SKIP: ATR too high (ceiling: 50, got ${indicators.atr.toFixed(2)})`;

    // ── RULE 10: ATR spike protection ────────────────────────────────────────
    if (typeof indicators.atrAverage !== 'number' || isNaN(indicators.atrAverage))
      return 'SKIP: ATR baseline missing - cannot verify spike protection';
    // If current ATR is more than 2.5× the baseline, a news event is likely.
    if (indicators.atr > indicators.atrAverage * 2.5)
      return `SKIP: ATR spike - possible news event (${indicators.atr.toFixed(2)} vs avg ${indicators.atrAverage.toFixed(2)})`;

    // ── RULE 11: Spread check ─────────────────────────────────────────────────
    if (typeof indicators.spread !== 'number' || isNaN(indicators.spread))
      return 'SKIP: Spread unavailable - skipping for safety';

    if (indicators.spread > spreadLimit)
      return `SKIP: Spread too high ($${indicators.spread.toFixed(2)}) - exceeds $${spreadLimit.toFixed(2)} limit`;


    // ── RULE 12: Daily trade cap ──────────────────────────────────────────────
    if (parseInt(botState.dailyTrades) >= 10)
      return `SKIP: Daily trade limit reached (${botState.dailyTrades}/10)`;

    // ── RULE 12A: Anti-chop loss streak block ────────────────────────────────
    const recentOutcomes = Array.isArray(botState.recentOutcomes) ? botState.recentOutcomes : [];
    const recentLosses = recentOutcomes
      .slice(-3)
      .filter(o => typeof o?.pnl === 'number' && o.pnl < 0);
    if (recentLosses.length >= 2)
      return 'SKIP: Anti-chop active - recent loss streak detected';

    // ── RULE 12B: Rapid reversal filter ───────────────────────────────────────
    if (
      typeof indicators.prevEMA20 === 'number' &&
      typeof indicators.prevEMA50 === 'number' &&
      typeof indicators.currEMA20 === 'number' &&
      typeof indicators.currEMA50 === 'number'
    ) {
      const prevDiff = indicators.prevEMA20 - indicators.prevEMA50;
      const currDiff = indicators.currEMA20 - indicators.currEMA50;
      const crossed = (prevDiff > 0 && currDiff < 0) || (prevDiff < 0 && currDiff > 0);
      if (crossed && Math.abs(indicators.slopePercent) < 0.15) {
        return 'SKIP: Anti-chop active - rapid EMA reversal detected';
      }
    }

    // ── RULE 13: Daily loss limit (Performance check - uses BALANCE) ─────────
    // Realized loss must not exceed 3% of account balance.
    const dailyLoss = parseFloat(botState.dailyLoss);
    const balance   = parseFloat(botState.balance);
    const dailyLossLimitPct = 0.03; 
    if (balance > 0 && dailyLoss >= balance * dailyLossLimitPct)
      return `STOP: Daily loss limit reached ($${dailyLoss.toFixed(2)} of $${(balance * dailyLossLimitPct).toFixed(2)} limit)`;

    // ── RULE 14: Total drawdown hard stop (Risk check - uses EQUITY) ──────────
    // Includes unrealized P&L. If equity falls 20% below peak balance, disable.
    const equity = parseFloat(botState.equity || botState.balance);
    const peak   = parseFloat(botState.peakBalance);
    if (peak > 0) {
      const equityDrawdown = ((peak - equity) / peak) * 100;
      if (equityDrawdown >= 20) {
        botState.botEnabled = false;
        return `DISABLE: Equity drawdown (${equityDrawdown.toFixed(2)}%) reached limit (20%) — bot disabled. Status: Real-time risk exposure too high.`;
      }
    }

    // ── RULE 15: Profit Factor hard stop (Performance check - uses BALANCE stats) ─
    const brokerTradesCount = parseInt(botState.brokerTotalTrades) || 0;
    if (brokerTradesCount >= 50) {
      const grossProfitVal = parseFloat(botState.brokerGrossProfit) || 0;
      const grossLossVal   = Math.abs(parseFloat(botState.brokerGrossLoss)) || 0;
      if (grossLossVal > 0) {
        const profitFactor = grossProfitVal / grossLossVal;
        if (profitFactor < 1.1) {
          botState.botEnabled = false;
          return `DISABLE: Profit Factor (${profitFactor.toFixed(2)}) below minimum threshold (1.1) after ${brokerTradesCount} trades. Bot disabled for performance review.`;
        }
      }
    }

    // ── RULE 16: Insufficient balance ────────────────────────────────────────
    if (isNaN(balance) || balance <= 0)
      return 'SKIP: Balance not yet synced from Capital.com';
    if (balance < 80) // ~22 USD
      return `SKIP: Insufficient balance (AED ${balance.toFixed(2)}) — minimum 80 AED required for Gold safety.`;

    // ── RULE 17: Cooldown between trades ─────────────────────────────────────
    if (botState.lastOrderTimestamp > 0) {
      const minutesSinceLastTrade = (Date.now() - parseInt(botState.lastOrderTimestamp)) / 60000;
      if (minutesSinceLastTrade < 10)
        return `SKIP: Cooldown active (${Math.ceil(10 - minutesSinceLastTrade)} min remaining)`;
    }

    // ── RULE 18: Max open positions ──────────────────────────────────────────
    if (Array.isArray(botState.openTrades) && botState.openTrades.length >= 2)
      return `SKIP: Max 2 positions open (currently ${botState.openTrades.length})`;

    // ── RULE 19: Duplicate trade ID ──────────────────────────────────────────
    if (Array.isArray(botState.recentTradeIds) && botState.recentTradeIds.includes(signal.id))
      return 'SKIP: Duplicate signal ID - already processed this signal';

    // ── RULE 20: Minimum score ────────────────────────────────────────────────
    if (signal.score < 2)
      return `SKIP: Signal score too low (${signal.score}/required 2)`;

    // ── RULE 21: Margin buffer check (Risk check - uses EQUITY/AVAILABLE) ──────
    {
      const availableMargin = parseFloat(botState.availableMargin);
      if (!isNaN(availableMargin) && availableMargin > 0) {
        const stopDistance     = Math.abs(signal.entryPrice - signal.stopLoss);
        const targetRiskPct    = 0.005; // 0.5% risk (matches execution.js)
        const USD_AED          = 3.6725;
        const riskAmountUSD    = (balance / USD_AED) * targetRiskPct;
        const estimatedSize    = stopDistance > 0.50
          ? Math.min(Math.max(riskAmountUSD / stopDistance, 0.01), 1.0)
          : 0.01;
        const notional         = estimatedSize * signal.entryPrice;
        const marginRequired   = notional * 0.05; // 5% margin rate for GOLD
        const marginRequiredAED = marginRequired * USD_AED;
        const marginWithBufferAED = marginRequiredAED * 1.5;
        
        if (availableMargin < marginWithBufferAED) {
          return `SKIP: Insufficient margin — need AED ${marginWithBufferAED.toFixed(2)} (with 1.5× buffer), have AED ${availableMargin.toFixed(2)}`;
        }
      }
    }

    return 'APPROVED';

  } catch (err) {
    // Never throw — always return a safe skip reason
    return `SKIP: Risk check error - ${err.message}`;
  }
}
