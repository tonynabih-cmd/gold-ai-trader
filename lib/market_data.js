// market_data.js — Fetch candles and current spread from Capital.com.
// Uses the same session as order execution (no extra auth calls).
//
// DESIGN DECISION: Always fetches 110 candles per invocation (no incremental caching).
// Rationale: Vercel is stateless — candles5m cannot persist across invocations without KV.
// Storing 100 candles in KV is too large and slow. At 96 runs/day × 3 timeframe fetches
// = ~288 API calls/day — well under the Capital.com limit. Simplicity beats fragile caching.

const FETCH_TIMEOUT_MS = 8000; // 8 seconds — Vercel function timeout is 10s

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

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
    const open  = p.openPrice?.bid;
    const high  = p.highPrice?.bid;
    const low   = p.lowPrice?.bid;
    const close = p.closePrice?.bid;

    if (
      typeof open  !== 'number' || isNaN(open)  ||
      typeof high  !== 'number' || isNaN(high)  ||
      typeof low   !== 'number' || isNaN(low)   ||
      typeof close !== 'number' || isNaN(close)
    ) {
      console.warn(`Skipping candle with invalid OHLC: ${JSON.stringify(p)}`);
      continue;
    }

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
    const bid  = data.snapshot?.bid;
    const ask  = data.snapshot?.offer; // Capital.com uses 'offer' not 'ask'

    if (typeof bid !== 'number' || typeof ask !== 'number') return null;
    if (isNaN(bid) || isNaN(ask)) return null;

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
    const [candles1h, candles5mRaw, candles1m, spread] = await Promise.all([
      fetchCandles(session, 'HOUR', 60),
      fetchCandles(session, 'MINUTE_5', 110),
      fetchCandles(session, 'MINUTE', 5),
      fetchCurrentSpread(session),
    ]);

    if (!candles1h)    return { skip: true, reason: 'SKIP: Failed to fetch 1h candles' };
    if (!candles5mRaw) return { skip: true, reason: 'SKIP: Failed to fetch 5m candles' };
    if (!candles1m)    return { skip: true, reason: 'SKIP: Failed to fetch 1m candles' };

    // ── Deduplicate 5m candles by timestamp ───────────────────────────────
    const seen    = new Set();
    let candles5m = candles5mRaw.filter(c => {
      if (seen.has(c.time)) return false;
      seen.add(c.time);
      return true;
    });

    // ── Sort candles chronologically (oldest first) ───────────────────────
    candles5m = candles5m.sort((a, b) => a.time - b.time);

    // ── Keep last 100 ─────────────────────────────────────────────────────
    if (candles5m.length > 100) candles5m = candles5m.slice(-100);

    // ── Warmup check ──────────────────────────────────────────────────────
    // EMA50 requires at least 50 candles; we require 100 for reliable indicators.
    if (candles5m.length < 100) {
      return { skip: true, reason: `SKIP: Warming up (${candles5m.length}/100 candles needed)` };
    }

    // ── Duplicate candle guard ────────────────────────────────────────────
    // Prevents processing the same candle twice if two triggers fire in the same 5m window.
    const latestCandleTime = candles5m[candles5m.length - 1].time;
    if (latestCandleTime <= botState.lastProcessedCandle) {
      return { skip: true, reason: 'SKIP: Duplicate candle - already processed this period' };
    }

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
      spread,          // may be null — risk.js handles null gracefully
    };

  } catch (err) {
    return { skip: true, reason: `SKIP: Market data error - ${err.message}` };
  }
}
