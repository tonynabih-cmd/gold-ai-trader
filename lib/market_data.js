// market_data.js — Fetch candles and current spread from Capital.com.
// Uses the same session as order execution (no extra auth calls).
//
// DESIGN DECISION: Always fetches 110 candles per invocation (no incremental caching).
// Rationale: Vercel is stateless — candles5m cannot persist across invocations without KV.
// Storing 100 candles in KV is too large and slow. At 96 runs/day × 3 timeframe fetches
// = ~288 API calls/day — well under the Capital.com limit. Simplicity beats fragile caching.

import { fetchWithTimeout } from './fetch.js';


async function fetchCandles(session, resolution, count) {
  const { baseUrl, cst, securityToken } = session;

  const res = await fetchWithTimeout(
    `${baseUrl}/api/v1/prices/GOLD?resolution=${resolution}&max=${count}`,
    {
      headers: {
        'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
        'CST':              cst,
        'X-SECURITY-TOKEN': securityToken,
      },
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`Failed to fetch ${resolution} candles (HTTP ${res.status}): ${body}`);
  }

  const data = await res.json();
  if (!data.prices || data.prices.length === 0) return null;

  const candles = [];
  for (const p of data.prices) {
    // Guard against null/undefined OHLC values (can happen if market is closed)
    // FIX: Use mid-price (bid+ask)/2 instead of bid-only.
    // Bid-only candles cause BUY trades to enter 1 full spread worse than modeled,
    // because execution happens at ask but all indicators were computed from bid.
    const bidOpen  = p.openPrice?.bid;
    const askOpen  = p.openPrice?.ask;
    const bidHigh  = p.highPrice?.bid;
    const askHigh  = p.highPrice?.ask;
    const bidLow   = p.lowPrice?.bid;
    const askLow   = p.lowPrice?.ask;
    const bidClose = p.closePrice?.bid;
    const askClose = p.closePrice?.ask;

    // Validate bid values (required)
    if (
      typeof bidOpen  !== 'number' || isNaN(bidOpen)  ||
      typeof bidHigh  !== 'number' || isNaN(bidHigh)  ||
      typeof bidLow   !== 'number' || isNaN(bidLow)   ||
      typeof bidClose !== 'number' || isNaN(bidClose)
    ) {
      console.warn(`Skipping candle with invalid bid OHLC: ${JSON.stringify(p)}`);
      continue;
    }

    // Compute mid-price if ask is available, otherwise fall back to bid
    const open  = (typeof askOpen  === 'number' && !isNaN(askOpen))  ? (bidOpen  + askOpen)  / 2 : bidOpen;
    const high  = (typeof askHigh  === 'number' && !isNaN(askHigh))  ? (bidHigh  + askHigh)  / 2 : bidHigh;
    const low   = (typeof askLow   === 'number' && !isNaN(askLow))   ? (bidLow   + askLow)   / 2 : bidLow;
    const close = (typeof askClose === 'number' && !isNaN(askClose)) ? (bidClose + askClose) / 2 : bidClose;

    // Sanity check: high must be >= low, open/close must be within high/low range
    if (high < low || open < low || open > high || close < low || close > high) {
      console.warn(`Skipping candle with inconsistent OHLC: O=${open} H=${high} L=${low} C=${close}`);
      continue;
    }

    candles.push({
      time:  new Date(p.snapshotTime).getTime(),
      open,
      high,
      low,
      close,
    });
  }

  return candles.length > 0 ? candles : null;
}

async function fetchCurrentSpread(session) {
  // Fetch live bid/ask snapshot to calculate current spread.
  // This is separate from candle data — uses the market details endpoint.
  try {
    const { baseUrl, cst, securityToken } = session;

    const res = await fetchWithTimeout(
      `${baseUrl}/api/v1/markets/GOLD`,
      {
        headers: {
          'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
          'CST':              cst,
          'X-SECURITY-TOKEN': securityToken,
        },
      }
    );

    if (!res.ok) return null;

    const data = await res.json();
    const snapshot = data.snapshot || {};

    // Spread Check Bug Fix: Capital.com usually uses 'offer', but some versions/accounts 
    // might use 'ask' or even return a direct 'spread' field in the snapshot.
    const bid    = snapshot.bid;
    const ask    = snapshot.offer ?? snapshot.ask; 
    const spread = snapshot.spread;

    // If direct spread field exists, use it first
    if (typeof spread === 'number' && !isNaN(spread)) {
      return parseFloat(spread.toFixed(4));
    }

    if (typeof bid !== 'number' || typeof ask !== 'number') return null;
    if (isNaN(bid) || isNaN(ask) || ask <= bid) return null;

    return parseFloat((ask - bid).toFixed(4));
  } catch (err) {
    console.warn(`Spread fetch failed: ${err.message}`);
    return null; // Non-fatal — risk.js handles null spread gracefully
  }
}

export async function getMarketData(session, botState) {
  try {
    // ── Fetch all 3 timeframes ─────────────────────────────────────────────
    // Run 1h and spread fetch in parallel with 5m to save time
    let [candles1h, candles5mRaw, candles1m, spread] = await Promise.all([
      fetchCandles(session, 'HOUR', 60),
      fetchCandles(session, 'MINUTE_5', 1000), // Request up to 1000 candles for EMA accuracy
      fetchCandles(session, 'MINUTE', 5),
      fetchCurrentSpread(session),
    ]);

    if (!candles1h)    return { skip: true, reason: 'SKIP: Failed to fetch 1h candles' };
    if (!candles5mRaw) return { skip: true, reason: 'SKIP: Failed to fetch 5m candles' };
    if (!candles1m)    return { skip: true, reason: 'SKIP: Failed to fetch 1m candles' };
    if (typeof spread !== 'number' || isNaN(spread)) {
      return { skip: true, reason: 'SKIP: BROKER_MARKET_SNAPSHOT_UNAVAILABLE' };
    }

    // ── Deduplicate 5m candles by timestamp ───────────────────────────────
    const seen    = new Set();
    let candles5m = candles5mRaw.filter(c => {
      if (seen.has(c.time)) return false;
      seen.add(c.time);
      return true;
    });

    // ── Sort candles chronologically (oldest first) ───────────────────────
    candles5m = candles5m.sort((a, b) => a.time - b.time);

    // ── Timezone Alignment (Conservative Approach) ────────────────────────
    // RISK: Aggressive timezone auto-correction can misalign candles
    // Safe approach: Only correct if offset is EXACTLY one of standard UTC offsets
    //
    // Capital.com should return UTC times. If broker returns local "naive" times,
    // we can detect and correct ONLY if the offset is a known/standard UTC offset.
    // We do NOT round to nearest hour (that's too lossy).
    const latestRawTime = candles5m[candles5m.length - 1].time;
    const now           = Date.now();
    const rawDrift      = latestRawTime - now; // Milliseconds difference
    const hourMs        = 60 * 60 * 1000;
    const driftHours    = rawDrift / hourMs;

    // Standard UTC offsets: -12 to +14 (in 30-minute increments)
    // Check if drift matches a known offset with some tolerance (±10 minutes)
    const tolerance     = 10 * 60 * 1000; // 10 minute tolerance
    let tzOffsetMs      = 0;
    let correctedOffset = null;

    for (let offset = -12; offset <= 14; offset += 0.5) {
      const expectedMs = offset * hourMs;
      if (Math.abs(rawDrift - expectedMs) < tolerance) {
        correctedOffset = offset;
        tzOffsetMs = expectedMs;
        break;
      }
    }

    if (correctedOffset !== null && Math.abs(correctedOffset) > 0) {
      console.warn(`[DATA] ⚠️ Timezone drift detected: broker is ${correctedOffset > 0 ? '+' : ''}${correctedOffset}h from UTC`);
      console.warn(`[DATA]    Applying correction to align candles to system UTC time`);
      const align = (c) => ({ ...c, time: c.time - tzOffsetMs });
      candles5m = candles5m.map(align);
      candles1h = candles1h.map(align);
      candles1m = candles1m.map(align);
    } else if (Math.abs(driftHours) > 0.5) {
      // Drift is NOT a standard offset — this is suspicious
      console.warn(`[DATA] ⚠️ Unusual timezone drift: ${driftHours.toFixed(2)}h (not a standard UTC offset)`);
      console.warn(`[DATA]    Not correcting to avoid misalignment. Verify broker time settings.`);
    }

    // DIAGNOSTIC LOG
    console.log(`[DATA] 🕰️ Time Sync: Broker Latest: ${new Date(latestRawTime).toISOString()} | System UTC: ${new Date().toISOString()} | Drift: ${driftHours.toFixed(2)}h`);

    // ── Discard Live/In-Progress Candle ───────────────────────────────────
    // Broker data includes the candle that is currently forming. 
    // We only want to calculate indicators and trade on CLOSED candles.
    // If the latest candle's close time is in the future, remove it.
    const last5m = candles5m[candles5m.length - 1];
    const last5mClose = last5m.time + (5 * 60 * 1000);
    if (last5mClose > Date.now()) {
      console.log(`[DATA] Discarding live 5m candle (${new Date(last5m.time).toISOString()} -> ${new Date(last5mClose).toISOString()})`);
      candles5m.pop();
    }

    const last1h = candles1h[candles1h.length - 1];
    const last1hClose = last1h.time + (60 * 60 * 1000);
    if (last1hClose > Date.now()) {
      candles1h.pop();
    }

    // ── Keep up to 1000 candles for Indicator calculation ──────────────────
    if (candles5m.length > 1000) candles5m = candles5m.slice(-1000);

    // ── Warmup check ──────────────────────────────────────────────────────
    // EMA50 requires a deep history to match broker EMA numbers accurately.
    if (candles5m.length < 100) {
      return { skip: true, reason: `SKIP: Warming up (${candles5m.length}/100 minimum candles needed)` };
    }

    // ── Duplicate candle guard ────────────────────────────────────────────
    // Prevents processing the same candle twice if two triggers fire in the same 5m window.
    const latestCandleTime = candles5m[candles5m.length - 1].time;
    if (latestCandleTime <= botState.lastProcessedCandle) {
      return { 
        skip: true, 
        reason: `SKIP: Duplicate candle - already processed this period (latest: ${latestCandleTime}, lastProcessed: ${botState.lastProcessedCandle})`,
        candles5m,
        candles1h,
        candles1m,
        latestCandleTime,
        spread
      };
    }

    // ── Strict Execution Timing (5-10s delay after close) ──────────────────
    // Capital.com candles open exactly on the 5m mark (e.g., 08:00, 08:05).
    // The "latestCandle" in the array is the one that JUST CLOSED.
    // We must wait at least 7 seconds after closing (the 5m mark) to allow 
    // broker calculations to settle and the next candle to begin properly.
    const candleCloseTime = latestCandleTime + (5 * 60 * 1000);
    const secondsSinceClose = (Date.now() - candleCloseTime) / 1000;

    if (secondsSinceClose < 7) {
      return {
        skip: true,
        reason: `SKIP: Waiting for candle settlement (${secondsSinceClose.toFixed(1)}s since close, need 7s)`,
        candles5m,
        candles1h,
        candles1m,
        latestCandleTime,
        spread
      };
    }

    // FIX: Signal staleness guard — reject candles older than 90 seconds.
    // If the cron fires late (e.g., 4+ minutes after close), the market has
    // moved significantly and entering on stale data causes poor fills.
    if (secondsSinceClose > 180) {
      return {
        skip: true,
        reason: `SKIP: Candle too stale for reliable entry (${secondsSinceClose.toFixed(1)}s since close, max 180s)`,
        candles5m,
        candles1h,
        candles1m,
        latestCandleTime,
        spread
      };
    }
    
    console.log(`[DATA] Execution Timing: ${secondsSinceClose.toFixed(1)}s since candle close — OK`);

    // ── Validate 1m candles ───────────────────────────────────────────────
    if (candles1m.length === 0) {
      return { skip: true, reason: 'SKIP: No valid 1m candles returned' };
    }

    return {
      skip:            false,
      candles5m,
      candles1h,
      candles1m,
      latestCandleTime,
      spread,
    };

  } catch (err) {
    return { skip: true, reason: `SKIP: Market data error - ${err.message}` };
  }
}