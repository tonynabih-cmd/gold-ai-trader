import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export async function acquireCandleLock(candleTime) {
  try {
    // CRITICAL RACE CONDITION FIX:
    // - Vercel functions timeout at 30s
    // - Lock must expire BEFORE next invocation starts
    // - With cron every 5 minutes (300s) and Vercel 30s timeout, we can safely use 90s
    // - This ensures: even if function hangs, lock expires before next 5m candle starts
    const key = `lock:candle:${candleTime}`;
    const lockValue = `locked:${Date.now()}:${Math.random()}`; // Include random to ensure uniqueness
    const result = await redis.set(key, lockValue, { nx: true, ex: 90 }); // Reduced from 240s to 90s
    
    if (result === 'OK') {
      console.log(`[LOCK] ✓ Acquired lock for candle ${candleTime} (expires in 90s)`);
      return true;
    } else {
      console.warn(`[LOCK] ✗ Failed to acquire lock for candle ${candleTime} — another invocation is processing it`);
      return false;
    }
  } catch (err) {
    console.error('[LOCK] Redis lock error:', err.message);
    return false; // Fail-closed: assume locked if we can't verify
  }
}

// candles5m is intentionally NOT in DEFAULT_STATE — it is never saved to KV.
// Vercel is stateless; candles are fetched fresh from Capital.com each invocation.
const DEFAULT_STATE = {
  lastProcessedCandle:     0,
  previousProcessedCandle: 0,
  openTrades:              [],
  dailyLoss:               0,
  dailyTrades:             0,
  totalDrawdown:           0,
  peakBalance:             0,      // 0 = not yet synced; syncBalance() sets real value
  balance:                 0,      // 0 = not yet synced; prevents trading before first sync
  equity:                  0,      // Account equity (balance + unrealized P&L)
  availableMargin:         0,      // Capital.com free margin — updated by syncBalance()
  startOfDayBalance:       0,
  lastTradingDay:          '',
  lastHeartbeat:           0,
  botEnabled:              true,
  recentTradeIds:          [],
  lastOrderTimestamp:      0,
  brokerGrossProfit:       0,
  brokerGrossLoss:         0,
  peakBrokerPnl:           0,
  strategyVersion:         'v1.1',
  lastStateSyncAt:         0,      // Timestamp of last broker ↔ local state reconciliation
  stateIntegrityOk:        true,   // Set to false if state becomes inconsistent — halts trading
};

export async function loadState() {
  try {
    const saved = await redis.get('bot_state');
    if (!saved) {
      console.log('[STATE] No saved state found — initializing defaults');
      return { ...DEFAULT_STATE };
    }

    const state = {
      ...DEFAULT_STATE,
      ...saved,

      // Use ?? (nullish coalescing) so saved value of 0 is respected, not treated as falsy.
      dailyLoss:           parseFloat(saved.dailyLoss          ?? 0),
      balance:             parseFloat(saved.balance            ?? 0),
      equity:              parseFloat(saved.equity             ?? 0),
      availableMargin:     parseFloat(saved.availableMargin    ?? 0),
      dailyTrades:         parseInt(saved.dailyTrades          ?? 0),
      totalDrawdown:       parseFloat(saved.totalDrawdown      ?? 0),
      peakBalance:         parseFloat(saved.peakBalance        ?? 0),
      startOfDayBalance:   parseFloat(saved.startOfDayBalance  ?? 0),
      lastOrderTimestamp:  parseInt(saved.lastOrderTimestamp   ?? 0),
      brokerGrossProfit:   parseFloat(saved.brokerGrossProfit   ?? 0),
      brokerGrossLoss:     parseFloat(saved.brokerGrossLoss     ?? 0),
      lastProcessedCandle: Number(saved.lastProcessedCandle  || 0),
      lastStateSyncAt:     parseInt(saved.lastStateSyncAt     ?? 0),
      stateIntegrityOk:    saved.stateIntegrityOk !== false,

      openTrades:          Array.isArray(saved.openTrades)     ? saved.openTrades     : [],
      recentTradeIds:      Array.isArray(saved.recentTradeIds) ? saved.recentTradeIds : [],

      // candles5m is NEVER loaded from KV — always start empty, fetch fresh each invocation
      candles5m:           [],

      // botEnabled: explicitly check for false so missing key defaults to true
      botEnabled:          saved.botEnabled !== false,
    };

    console.log(`[STATE] Loaded: balance=${state.balance.toFixed(2)}, openTrades=${state.openTrades.length}, integrity=${state.stateIntegrityOk}`);
    return state;
  } catch (err) {
    console.error('[STATE] Load error:', err.message);
    return { ...DEFAULT_STATE };
  }
}

export async function saveState(botState) {
  try {
    // CRITICAL: Strip candles5m before saving.
    // 100 candles of OHLC data is a large payload — storing it in Upstash KV
    // wastes space, slows reads/writes, and risks hitting size limits.
    // Candles are fetched fresh from Capital.com each invocation anyway.
    const { candles5m, ...stateToSave } = botState;

    await redis.set('bot_state', stateToSave);
    return true;
  } catch (err) {
    console.error('[STATE] Save error:', err.message);
    return false;
  }
}

// ── Immediate state save after critical events ────────────────────────────────
// Called right after trade open or close to prevent state loss on crash/timeout.
export async function saveStateCritical(botState, reason) {
  console.log(`[STATE] CRITICAL SAVE: ${reason}`);
  const saved = await saveState(botState);
  if (!saved) {
    console.error(`[STATE] ⚠️ CRITICAL SAVE FAILED: ${reason} — state may be inconsistent`);
    botState.stateIntegrityOk = false;
  }
  return saved;
}

export function dailyReset(botState) {
  // Use UAE time (UTC+4) for reset logic. UAE time is the bot's standard
  // for Golden Hour and weekend gap rules. UTC-only reset causes a delay
  // for users in UAE (at 01:00 UAE, it's still 21:00 previous day UTC).
  const uaeDate = new Date(new Date().getTime() + (4 * 60 * 60 * 1000));
  const today = uaeDate.toISOString().slice(0, 10);
  
  if (botState.lastTradingDay !== today) {
    botState.dailyLoss      = 0;
    botState.dailyTrades    = 0;
    botState.lastTradingDay = today;
    botState.startOfDayBalance = parseFloat(botState.balance) || 0;
    console.log(`[STATE] Daily reset applied for ${today} (UAE Time)`);
  }
  return botState;
}

export async function saveAudit(data) {
  try {
    await redis.set('last_audit', data);
    return true;
  } catch (err) {
    console.error('Save audit error:', err.message);
    return false;
  }
}

// ── STATE INTEGRITY VALIDATION ────────────────────────────────────────────────
// Validates state consistency after critical operations (broker sync, reconciliation)
// If state is corrupted, halts trading to prevent catastrophic losses
export function validateStateIntegrity(botState, context = 'unknown') {
  const issues = [];

  // ── Essential fields must exist ──────────────────────────────────────────────
  if (typeof botState.balance !== 'number' || botState.balance < 0) {
    issues.push(`Balance invalid (${botState.balance})`);
  }
  if (typeof botState.equity !== 'number' || botState.equity < 0) {
    issues.push(`Equity invalid (${botState.equity})`);
  }
  if (typeof botState.availableMargin !== 'number' || botState.availableMargin < 0) {
    issues.push(`Available margin invalid (${botState.availableMargin})`);
  }

  // ── Equity cannot be significantly less than balance (unrealized loss too extreme) ──
  const unrealizedPnL = botState.equity - botState.balance;
  if (unrealizedPnL < -1000) { // More than AED 1000 unrealized loss is suspicious
    issues.push(`Unrealized P&L suspiciously large (AED ${unrealizedPnL.toFixed(2)}) — possible state corruption`);
  }

  // ── Open trades should be an array ────────────────────────────────────────────
  if (!Array.isArray(botState.openTrades)) {
    issues.push(`openTrades is not an array (${typeof botState.openTrades})`);
  } else {
    // Each open trade should have required fields
    for (let i = 0; i < botState.openTrades.length; i++) {
      const trade = botState.openTrades[i];
      if (!trade.dealReference || !trade.entry || !trade.size) {
        issues.push(`Open trade ${i} missing required fields (ref=${trade.dealReference}, entry=${trade.entry}, size=${trade.size})`);
      }
      if (trade.size <= 0 || isNaN(trade.size)) {
        issues.push(`Open trade ${i} has invalid size (${trade.size})`);
      }
    }
  }

  // ── Daily stats should be reasonable ──────────────────────────────────────────
  if (botState.dailyTrades < 0) {
    issues.push(`Daily trades is negative (${botState.dailyTrades})`);
  }
  if (botState.dailyLoss > botState.balance * 0.5) { // More than 50% balance lost in one day
    issues.push(`Daily loss is more than 50% of balance (AED ${botState.dailyLoss.toFixed(2)})`);
  }

  // ── Available margin should be positive (unless heavily leveraged) ──────────────
  if (botState.availableMargin < 0 && botState.openTrades?.length === 0) {
    issues.push(`Negative available margin with no open trades (${botState.availableMargin.toFixed(2)})`);
  }

  // ── Log and alert ────────────────────────────────────────────────────────────
  if (issues.length > 0) {
    console.error(`[STATE] ⚠️ Integrity check FAILED (context: ${context})`);
    for (const issue of issues) {
      console.error(`[STATE]   → ${issue}`);
    }
    botState.stateIntegrityOk = false;
    return false; // State is corrupted
  }

  console.log(`[STATE] ✓ Integrity check PASSED (context: ${context})`);
  botState.stateIntegrityOk = true;
  return true; // State is valid
}

// API route handler (api/state.js imports from here)
export default async function handler(req, res) {
  const state = await loadState();
  return res.json(state);
}
