// risk.js — 20-rule safety gate. Every rule is checked before ANY trade is placed.
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

    // ── RULE 2: State kill switch ─────────────────────────────────────────────
    // Set by monitor.js when drawdown or profit factor thresholds are breached.
    if (botState.botEnabled === false)
      return 'SKIP: Bot disabled via state (drawdown or performance threshold)';

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
    // 12PM–8PM UAE = 08:00–16:00 UTC = London open + NY open overlap.
    // Tightest spreads, strongest EMA signals, highest gold volume globally.
    if (hour < 8 || hour >= 16)
      return 'SKIP: Outside Golden Hour (12PM-8PM UAE / 08:00-16:00 UTC)';

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
    // ATR < 0.5 = dead/frozen market. ATR > 12 = crisis/news spike.
    if (indicators.atr < 0.5 || indicators.atr > 12)
      return `SKIP: ATR ${indicators.atr?.toFixed(2)} out of normal range (0.5–12)`;

    // ── RULE 10: ATR spike protection ────────────────────────────────────────
    // If current ATR is more than 2.5× the baseline, a news event is likely.
    if (indicators.atr > indicators.atrAverage * 2.5)
      return `SKIP: ATR spike detected (${indicators.atr?.toFixed(2)} vs avg ${indicators.atrAverage?.toFixed(2)}) - possible news event`;

    // ── RULE 11: Spread check ─────────────────────────────────────────────────
    // Capital.com spread for Gold during Golden Hour: typically $0.40–$0.80.
    // If spread > $1.20, conditions are abnormal (thin market or news event).
    // indicators.spread is fetched by market_data.js from the snapshot endpoint.
    if (typeof indicators.spread === 'number' && indicators.spread > 1.20)
      return `SKIP: Spread too high ($${indicators.spread?.toFixed(2)}) - possible news event`;

    // ── RULE 12: Daily trade cap ──────────────────────────────────────────────
    if (parseInt(botState.dailyTrades) >= 5)
      return `SKIP: Daily trade limit reached (${botState.dailyTrades}/5)`;

    // ── RULE 13: Daily loss limit ─────────────────────────────────────────────
    // Stop trading if daily loss reaches 5% of account balance.
    const dailyLoss = parseFloat(botState.dailyLoss);
    const balance   = parseFloat(botState.balance);
    if (balance > 0 && dailyLoss >= balance * 0.05)
      return `STOP: Daily loss limit reached ($${dailyLoss.toFixed(2)} of $${(balance * 0.05).toFixed(2)} limit)`;

    // ── RULE 14: Total drawdown hard stop ────────────────────────────────────
    // Permanent disable if account has lost 20% from its peak balance.
    // Sets botEnabled = false so Rule 2 blocks all future cycles until manual re-enable.
    const totalDrawdown = parseFloat(botState.totalDrawdown);
    if (!isNaN(totalDrawdown) && totalDrawdown >= 20) {
      botState.botEnabled = false;
      return `DISABLE: Max drawdown (${totalDrawdown}%) reached - bot disabled. Set botEnabled=true in Upstash to re-enable.`;
    }

    // ── RULE 15: Insufficient balance ────────────────────────────────────────
    // Don't trade if balance hasn't been synced yet (0) or is dangerously low.
    if (isNaN(balance) || balance <= 0)
      return 'SKIP: Balance not yet synced from Capital.com';
    if (balance < 10)
      return `SKIP: Insufficient balance ($${balance.toFixed(2)})`;

    // ── RULE 16: Cooldown between trades ─────────────────────────────────────
    // Minimum 10 minutes between trades to prevent overtrading.
    if (botState.lastOrderTimestamp > 0) {
      const minutesSinceLastTrade = (Date.now() - parseInt(botState.lastOrderTimestamp)) / 60000;
      if (minutesSinceLastTrade < 10)
        return `SKIP: Cooldown active (${Math.ceil(10 - minutesSinceLastTrade)} min remaining)`;
    }

    // ── RULE 17: Max open positions ──────────────────────────────────────────
    if (Array.isArray(botState.openTrades) && botState.openTrades.length >= 2)
      return `SKIP: Max 2 positions open (currently ${botState.openTrades.length})`;

    // ── RULE 18: Duplicate trade ID ──────────────────────────────────────────
    // Prevents same signal from firing twice (e.g. if two triggers fire simultaneously).
    if (Array.isArray(botState.recentTradeIds) && botState.recentTradeIds.includes(signal.id))
      return 'SKIP: Duplicate signal ID - already processed this signal';

    // ── RULE 19: Slippage protection ─────────────────────────────────────────
    // If price has moved more than $1.00 since signal was generated, skip.
    // Capital.com prices can differ slightly from candle close; $1.00 is generous.
    if (indicators.lastCandle && typeof indicators.lastCandle.close === 'number') {
      const slippage = Math.abs(indicators.lastCandle.close - signal.entryPrice);
      if (slippage > 1.0)
        return `SKIP: Price moved too fast (slippage: $${slippage.toFixed(2)})`;
    }

    // ── RULE 20: Minimum score ────────────────────────────────────────────────
    if (signal.score < 2)
      return `SKIP: Signal score too low (${signal.score}/required 2)`;

    return 'APPROVED';

  } catch (err) {
    // Never throw — always return a safe skip reason
    return `SKIP: Risk check error - ${err.message}`;
  }
}
