// logger.js — Save every bot decision to Upstash KV, including all skips.
// Every single cron invocation is logged — this is the source of truth for audit and analysis.

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export async function saveLog(data) {
  try {
    const log = {
      // ── Identity ────────────────────────────────────────────────────────────
      tradeId:         data.signal?.id              || 'NO_SIGNAL',
      strategyVersion: data.signal?.strategyVersion || 'v1.4',
      entryType:       data.signal?.entryType       || null, // 'crossover' or 'pullback'
      isRelaxedMode:   data.signal?.isRelaxedMode   ?? data.signalDebug?.isRelaxedMode ?? false,
      hoursSinceLastTrade: data.signal?.hoursSinceLastTrade ?? data.signalDebug?.hoursSinceLastTrade ?? null,

      // ── Timing (always store UTC; UAE shown for human readability) ──────────
      time:    new Date().toISOString(),
      timeUAE: new Date().toLocaleString('en-US', { timeZone: 'Asia/Dubai' }),

      // ── Decision ────────────────────────────────────────────────────────────
      signalDetected: data.signal?.action   || 'NONE',
      tradeExecuted:  data.tradeExecuted    || false,
      reason:         data.reason           || null,

      // ── Trade details (null if not executed) ────────────────────────────────
      // Use executed values when available so audits reflect what was actually sent/filled.
      entryPrice:    data.result?.entry        ?? data.signal?.entryPrice ?? null,
      stopLoss:      data.result?.stopLoss     ?? data.signal?.stopLoss   ?? null,
      takeProfit:    data.result?.takeProfit   ?? data.signal?.takeProfit ?? null,
      size:          data.result?.size         ?? null,
      dealReference: data.result?.dealReference ?? null,

      // ── Leverage & margin telemetry (populated on executed trades) ──────────
      // actualRiskDollars: real $ at risk based on size × stopDistance
      // dollarExposure:    total notional value = size × entryPrice
      // marginUsed:        margin Capital.com holds = notional × 5%
      // leverage:          leverage applied (always 20 for GOLD retail)
      actualRiskDollars: data.result?.actualRiskDollars ?? null,
      dollarExposure:    data.result?.notionalValue     ?? null,
      marginUsed:        data.result?.marginRequired    ?? null,
      leverage:          data.result?.leverage          ?? null,

      // ── Indicators (null if indicators were skipped) ─────────────────────────
      ema20:      data.indicators?.currEMA20    ?? null,
      ema50:      data.indicators?.currEMA50    ?? null,
      emaSlope:   data.indicators?.slopePercent ?? null,
      atr:        data.indicators?.atr          ?? null,
      atrAverage: data.indicators?.atrAverage   ?? null,
      rsi:        data.indicators?.rsi          ?? null,
      score:      data.signal?.score            ?? null,
      resistance: data.indicators?.resistance   ?? null,
      support:    data.indicators?.support      ?? null,
      trend1h:    data.indicators?.trend1h      ?? null,
      spread:     data.indicators?.spread       ?? null,
      goldPrice:  data.indicators?.lastCandle?.close ?? null,

      // ── Risk state at time of decision ──────────────────────────────────────
      // Use ?? (not ||) so that 0 values are preserved correctly.
      balance:       data.botState?.balance              ?? null,
      equity:        data.botState?.equity               ?? null, // Decoupled for real-time risk tracking
      dailyTrades:   data.botState?.dailyTrades          ?? null,
      dailyLoss:     data.botState?.dailyLoss            ?? null,
      openPositions: data.botState?.openTrades?.length   ?? 0,
      totalDrawdown: data.botState?.totalDrawdown        ?? null,
      integrityOk:   data.botState?.stateIntegrityOk     ?? true,

      // ── Strategy debug (logged every cycle for signal diagnosis) ─────────────
      dbgCurrE20:          data.signalDebug?.dbgCurrE20          ?? null,
      dbgCurrE50:          data.signalDebug?.dbgCurrE50          ?? null,
      dbgPrevE20:          data.signalDebug?.dbgPrevE20          ?? null,
      dbgPrevE50:          data.signalDebug?.dbgPrevE50          ?? null,
      dbgEmaSeparation:    data.signalDebug?.dbgEmaSeparation    ?? null,
      dbgDistToEMA20:      data.signalDebug?.dbgDistToEMA20      ?? null,
      dbgCrossoverChecked: data.signalDebug?.dbgCrossoverChecked ?? null,
      dbgBuyCrossover:     data.signalDebug?.dbgBuyCrossover     ?? null,
      dbgSellCrossover:    data.signalDebug?.dbgSellCrossover    ?? null,
      dbgPullbackChecked:  data.signalDebug?.dbgPullbackChecked  ?? null,
      dbgAction:           data.signalDebug?.dbgAction           ?? null,
      dbgEntryType:        data.signalDebug?.dbgEntryType        ?? null,
      dbgScore:            data.signalDebug?.dbgScore            ?? null,
      dbgPullbackReason:   data.signalDebug?.dbgPullbackReason   ?? null,
      dbgSetupReady:       data.signalDebug?.dbgSetupReady       ?? false,
      dbgRejectReason:     data.signalDebug?.dbgRejectReason     ?? null,
      dbg1mMomentumNet:    data.signalDebug?.dbg1mMomentumNet    ?? null,

      // ── Sync / fallback resolution flag ──────────────────────────────────────
      // true when a trade was force-closed after the sync window expired without
      // a matching transaction history record (FALLBACK_RESOLUTION_USED).
      fallbackUsed: data.result?.fallbackUsed ?? false,
    };

    // Atomic append using Redis list — no read/write race condition
    await redis.rpush('trade_logs_list', JSON.stringify(log));
    // Keep last 1000 logs
    const len = await redis.llen('trade_logs_list');

    if (len > 1000) {
      await redis.ltrim('trade_logs_list', len - 1000, -1);
    }
    return log;

  } catch (err) {
    console.error('saveLog error:', err.message);
  }
}

export async function getLogs() {
  try {
    const raw = await redis.lrange('trade_logs_list', 0, -1);
    if (!Array.isArray(raw)) return [];
    return raw.map(entry => {
      if (typeof entry === 'string') {
        try { return JSON.parse(entry); } catch { return entry; }
      }
      return entry; 
    });
  } catch (err) {
    console.error('getLogs error:', err.message);
    return [];
  }
}
