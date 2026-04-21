// market_data.js — Fetch candles and current spread from Capital.com.
// Uses the same session as order execution (no extra auth calls).
//
// DESIGN DECISION: Always fetches 110 candles per invocation (no incremental caching).
// Rationale: Vercel is stateless — candles5m cannot persist across invocations without KV.
// Storing 100 candles in KV is too large and slow. At 96 runs/day × 3 timeframe fetches
// = ~288 API calls/day — well under the Capital.com limit. Simplicity beats fragile caching.

import { fetchWithTimeout, withRetries } from './fetch.js';

const MINUTE_MS = 60 * 1000;
const FIVE_MINUTES_MS = 5 * MINUTE_MS;
const HOUR_MS = 60 * MINUTE_MS;
const MIN_CANDLES_1H = 100;
const MIN_CANDLES_1M = 100;
const MIN_CANDLES_5M = 100;
const SETTLEMENT_THRESHOLD_SECONDS = 7;

function isFinitePrice(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function getCandleCloseTime(openTimeMs, timeframeMs) {
  return openTimeMs + timeframeMs;
}

function logCandleTiming(label, candle, timeframeMs, nowMs, secondsSinceClose = null) {
  if (!candle) return;

  const candleOpenTime = candle.time;
  const candleCloseTime = getCandleCloseTime(candleOpenTime, timeframeMs);
  const logParts = [
    `[DATA] ${label}: raw=${candle.rawTime ?? 'n/a'}`,
    `open=${new Date(candleOpenTime).toISOString()}`,
    `close=${new Date(candleCloseTime).toISOString()}`,
    `server=${new Date(nowMs).toISOString()}`,
  ];

  if (secondsSinceClose !== null) {
    logParts.push(`secondsSinceClose=${secondsSinceClose.toFixed(3)}`);
  }

  console.log(logParts.join(' | '));
}

function logSeriesStatus(label, candles, timeframeMs, nowMs, latestClosed = null, rawCount = null) {
  const latest = candles[candles.length - 1] ?? null;
  const latestClosedTime = latest ? getCandleCloseTime(latest.time, timeframeMs) : null;
  const isLatestClosed = latestClosed ?? (
    latestClosedTime != null
      ? latestClosedTime <= nowMs
      : false
  );

  console.log(
    `[DATA] ${label} status: rawCount=${rawCount ?? candles.length} | remaining=${candles.length} | ` +
    `latest=${latest ? new Date(latest.time).toISOString() : 'N/A'} | ` +
    `latestRaw=${latest?.rawTime ?? 'N/A'} | latestClosed=${isLatestClosed}`
  );
}

function discardUnclosedCandles(candles, timeframeMs, label, nowMs) {
  let discarded = 0;

  while (candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const lastCloseTime = getCandleCloseTime(lastCandle.time, timeframeMs);
    if (lastCloseTime <= nowMs) break;

    logCandleTiming(`Discarding unclosed ${label} candle`, lastCandle, timeframeMs, nowMs);
    candles.pop();
    discarded += 1;
  }

  return discarded;
}

function compareLatestToPersisted(latestCandleTime, lastProcessedCandle) {
  if (latestCandleTime === lastProcessedCandle) return 'equal';
  if (latestCandleTime < lastProcessedCandle) return 'older';
  return 'newer';
}

function validateCandleShape(candle) {
  if (!candle || typeof candle !== 'object') return false;
  if (!Number.isFinite(candle.time)) return false;
  return ['open', 'high', 'low', 'close'].every(key => Number.isFinite(candle[key]));
}

function validateCandleSeries(candles, label) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { ok: false, reason: `${label} returned no candles` };
  }

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (!validateCandleShape(candle)) {
      return { ok: false, reason: `${label} invalid candle structure at index ${i}` };
    }
  }

  return { ok: true, reason: null };
}

function dedupeCandles(candles, label) {
  const seen = new Set();
  const deduped = [];

  for (const candle of candles) {
    if (seen.has(candle.time)) {
      console.warn(`[DATA] ${label} duplicate timestamp discarded: ${candle.rawTime ?? candle.time}`);
      continue;
    }
    seen.add(candle.time);
    deduped.push(candle);
  }

  return deduped;
}

function trimNewestClosedHistory(candles, label, minCandles) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { candles: [], discarded: 0, reason: `${label} has no candles to trim` };
  }

  if (candles.length <= minCandles) {
    return {
      candles,
      discarded: 0,
      reason: `${label} has no spare newest candle to trim safely`,
    };
  }

  const newest = candles[candles.length - 1];
  console.log(
    `[DATA] ${label} discard reason: conservatively dropping newest candle to guarantee closed history | ` +
    `raw=${newest.rawTime ?? 'n/a'} | ts=${new Date(newest.time).toISOString()}`
  );

  return {
    candles: candles.slice(0, -1),
    discarded: 1,
    reason: 'dropped newest candle conservatively',
  };
}

function parseBrokerTimestamp(price, label) {
  const preferredRaw = price.snapshotTimeUTC ?? price.snapshotTime;
  let timeStr = String(preferredRaw ?? '');

  if (!timeStr) {
    throw new Error(`${label} candle missing snapshot timestamp`);
  }

  if (timeStr.includes('T') && !timeStr.endsWith('Z') && !timeStr.match(/[+-]\d{2}:?\d{2}$/)) {
    timeStr += 'Z';
  }

  const time = new Date(timeStr).getTime();
  if (!Number.isFinite(time)) {
    throw new Error(`${label} candle invalid timestamp: ${preferredRaw}`);
  }

  return {
    time,
    rawTime: price.snapshotTime ?? null,
    rawTimeUtc: price.snapshotTimeUTC ?? null,
    parsedTimeStr: timeStr,
  };
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
  if (!data.prices || data.prices.length === 0) return [];

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
      !isFinitePrice(bidOpen) ||
      !isFinitePrice(bidHigh) ||
      !isFinitePrice(bidLow) ||
      !isFinitePrice(bidClose)
    ) {
      console.warn(`Skipping candle with invalid bid OHLC: ${JSON.stringify(p)}`);
      continue;
    }

    // Compute mid-price if ask is available, otherwise fall back to bid
    const open  = isFinitePrice(askOpen)  ? (bidOpen  + askOpen)  / 2 : bidOpen;
    const high  = isFinitePrice(askHigh)  ? (bidHigh  + askHigh)  / 2 : bidHigh;
    const low   = isFinitePrice(askLow)   ? (bidLow   + askLow)   / 2 : bidLow;
    const close = isFinitePrice(askClose) ? (bidClose + askClose) / 2 : bidClose;

    // Sanity check: high must be >= low, open/close must be within high/low range
    if (high < low || open < low || open > high || close < low || close > high) {
      console.warn(`Skipping candle with inconsistent OHLC: O=${open} H=${high} L=${low} C=${close}`);
      continue;
    }

    let timestampInfo;
    try {
      timestampInfo = parseBrokerTimestamp(p, resolution);
    } catch (err) {
      console.warn(`[DATA] Skipping candle with invalid timestamp: ${err.message}`);
      continue;
    }

    candles.push({
      time: timestampInfo.time,
      rawTime: timestampInfo.rawTime,
      rawTimeUtc: timestampInfo.rawTimeUtc,
      parsedTimeStr: timestampInfo.parsedTimeStr,
      open,
      high,
      low,
      close,
    });
  }

  return candles;
}

async function fetchCandlesRobust(session, {
  resolution,
  label,
  minCandles,
  preferredCount,
  maxCount,
}) {
  const requestedCounts = [...new Set([preferredCount, maxCount])];
  let lastError = null;

  for (const count of requestedCounts) {
    try {
      const candles = await withRetries(
        async attempt => {
          const result = await fetchCandles(session, resolution, count);
          console.log(`[DATA] ${label} fetch attempt ${attempt}: requested=${count}, returned=${result.length}`);

          const validation = validateCandleSeries(result, label);
          if (!validation.ok) {
            throw new Error(validation.reason);
          }

          if (result.length < minCandles) {
            throw new Error(`${label} partial response (${result.length}/${minCandles})`);
          }

          return result;
        },
        {
          attempts: 3,
          delayMs: 800,
          backoffFactor: 2,
          label: `${label} candles`,
        }
      );

      return candles;
    } catch (err) {
      lastError = err;
      console.error(`[DATA] ${label} fetch failed for requested=${count}: ${err.message}`);
    }
  }

  throw lastError ?? new Error(`${label} candles unavailable`);
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
      fetchCandlesRobust(session, {
        resolution: 'HOUR',
        label: '1h',
        minCandles: MIN_CANDLES_1H,
        preferredCount: 120,
        maxCount: 240,
      }),
      fetchCandlesRobust(session, {
        resolution: 'MINUTE_5',
        label: '5m',
        minCandles: MIN_CANDLES_5M,
        preferredCount: 1000,
        maxCount: 1000,
      }),
      fetchCandlesRobust(session, {
        resolution: 'MINUTE',
        label: '1m',
        minCandles: MIN_CANDLES_1M,
        preferredCount: 120,
        maxCount: 240,
      }),
      withRetries(async attempt => {
        const currentSpread = await fetchCurrentSpread(session);
        if (!Number.isFinite(currentSpread)) {
          throw new Error(`spread unavailable on attempt ${attempt}`);
        }
        return currentSpread;
      }, {
        attempts: 3,
        delayMs: 750,
        backoffFactor: 2,
        label: 'spread snapshot',
      }),
    ]);

    if (!candles1h?.length)    return { skip: true, reason: 'SKIP: Failed to fetch 1h candles', dataStatus: 'FAIL' };
    if (!candles5mRaw?.length) return { skip: true, reason: 'SKIP: Failed to fetch 5m candles', dataStatus: 'FAIL' };
    if (!candles1m?.length)    return { skip: true, reason: 'SKIP: Failed to fetch 1m candles', dataStatus: 'FAIL' };
    if (typeof spread !== 'number' || isNaN(spread)) {
      return { skip: true, reason: 'SKIP: BROKER_MARKET_SNAPSHOT_UNAVAILABLE', dataStatus: 'FAIL' };
    }

    const raw1hCount = candles1h.length;
    const raw5mCount = candles5mRaw.length;
    const raw1mCount = candles1m.length;

    // ── Deduplicate candles by timestamp ──────────────────────────────────
    candles1h = dedupeCandles(candles1h, '1h');
    let candles5m = dedupeCandles(candles5mRaw, '5m');
    candles1m = dedupeCandles(candles1m, '1m');

    // ── Sort candles chronologically (oldest first) ───────────────────────
    candles1h = candles1h.sort((a, b) => a.time - b.time);
    candles5m = candles5m.sort((a, b) => a.time - b.time);
    candles1m = candles1m.sort((a, b) => a.time - b.time);

    // ── Diagnostic Logs (Task 5) ──────────────────────────────────────────
    // Broker timestamps are now consistently parsed as UTC via Date parsing.
    const latestCandleRaw = candles5m[candles5m.length - 1];
    const latestOpenEpoch = latestCandleRaw.time;
    const latestCloseEpoch = latestOpenEpoch + FIVE_MINUTES_MS;
    
    console.log(
      `[DATA] 🕰️ Time Sync Audit: ` +
      `raw='${latestCandleRaw.rawTime}' | ` +
      `iso='${new Date(latestOpenEpoch).toISOString()}' | ` +
      `epoch=${latestOpenEpoch} | ` +
      `open='${new Date(latestOpenEpoch).toISOString()}' | ` +
      `close='${new Date(latestCloseEpoch).toISOString()}'`
    );

    // Alignment check
    if (latestOpenEpoch % FIVE_MINUTES_MS !== 0) {
      console.warn(`[DATA] ⚠️ ALIGNMENT ERROR: Candle time ${latestOpenEpoch} is not a multiple of 5 minutes!`);
    } else {
      console.log(`[DATA] ✓ Alignment: Candle aligns perfectly with 5m UTC grid.`);
    }

    // ── Discard Live/In-Progress Candle ───────────────────────────────────
    // Broker data includes the candle that is currently forming. 
    // We only want to calculate indicators and trade on CLOSED candles.
    // If the latest candle's close time is in the future, remove it.
    const timingNowMs = Date.now();
    const discarded5m = discardUnclosedCandles(candles5m, FIVE_MINUTES_MS, '5m', timingNowMs);
    const trimmed1h = trimNewestClosedHistory(candles1h, '1h', MIN_CANDLES_1H);
    candles1h = trimmed1h.candles;
    const trimmed1m = trimNewestClosedHistory(candles1m, '1m', MIN_CANDLES_1M);
    candles1m = trimmed1m.candles;

    logSeriesStatus('1h', candles1h, HOUR_MS, timingNowMs, true, raw1hCount);
    logSeriesStatus('1m', candles1m, MINUTE_MS, timingNowMs, true, raw1mCount);
    logSeriesStatus('5m', candles5m, FIVE_MINUTES_MS, timingNowMs, null, raw5mCount);

    console.log(`[DATA] 1h candles fetched: ${raw1hCount}, remaining after validation: ${candles1h.length}, discarded=${trimmed1h.discarded}`);
    console.log(`[DATA] 1m candles fetched: ${raw1mCount}, remaining after validation: ${candles1m.length}, discarded=${trimmed1m.discarded}`);
    console.log(`[DATA] 5m candles fetched: ${raw5mCount}, remaining after validation: ${candles5m.length}, discarded=${discarded5m}`);

    if (candles5m.length === 0) {
      return { skip: true, reason: 'SKIP: No closed 5m candles available after validation', dataStatus: 'FAIL' };
    }
    if (candles1h.length === 0) {
      return { skip: true, reason: 'SKIP: No closed 1h candles available after validation', dataStatus: 'FAIL' };
    }
    if (candles1m.length === 0) {
      return { skip: true, reason: 'SKIP: No closed 1m candles available after validation', dataStatus: 'FAIL' };
    }
    if (candles1h.length < MIN_CANDLES_1H) {
      return { skip: true, reason: `SKIP: Not enough closed 1h candles (${candles1h.length}/${MIN_CANDLES_1H})`, dataStatus: 'FAIL' };
    }
    if (candles1m.length < MIN_CANDLES_1M) {
      return { skip: true, reason: `SKIP: Not enough closed 1m candles (${candles1m.length}/${MIN_CANDLES_1M})`, dataStatus: 'FAIL' };
    }

    // ── Keep up to 1000 candles for Indicator calculation ──────────────────
    if (candles5m.length > 1000) candles5m = candles5m.slice(-1000);

    // ── Warmup check ──────────────────────────────────────────────────────
    // EMA50 requires a deep history to match broker EMA numbers accurately.
    if (candles5m.length < 100) {
      return { skip: true, reason: `SKIP: Warming up (${candles5m.length}/100 minimum candles needed)`, dataStatus: 'FAIL' };
    }

    // ── Duplicate candle guard ────────────────────────────────────────────
    // Prevents processing the same candle twice if two triggers fire in the same 5m window.
    const latestCandle = candles5m[candles5m.length - 1];
    const latestCandleTime = latestCandle.time;
    const lastProcessedCandle = Number(botState.lastProcessedCandle ?? 0);
    const comparison = compareLatestToPersisted(latestCandleTime, lastProcessedCandle);
    console.log(
      `[DATA] Candle State: fetchedLatest=${latestCandleTime} | persistedLastProcessed=${lastProcessedCandle} | comparison=${comparison}`
    );

    if (comparison === 'equal') {
      console.log('[DATA] Candle State Action: duplicate candle skip');
      return { 
        skip: true, 
        reason: `SKIP: Duplicate candle - already processed this period (latest: ${latestCandleTime}, lastProcessed: ${lastProcessedCandle})`,
        candles5m,
        candles1h,
        candles1m,
        latestCandleTime,
        spread,
        dataStatus: 'OK'
      };
    }

    if (comparison === 'older') {
      console.warn(
        `[DATA] Candle State Action: stale market data abort (fetchedLatest=${latestCandleTime} < persistedLastProcessed=${lastProcessedCandle})`
      );
      return {
        skip: true,
        reason: `SKIP: Stale market data - fetched candle older than persisted state (latest: ${latestCandleTime}, lastProcessed: ${lastProcessedCandle})`,
        candles5m,
        candles1h,
        candles1m,
        latestCandleTime,
        spread,
        dataStatus: 'FAIL'
      };
    }

    console.log('[DATA] Candle State Action: newer candle accepted');

    // ── Strict Execution Timing (5s delay after close) ──────────────────
    // Capital.com candles open exactly on the 5m mark (e.g., 08:00, 08:05).
    // The "latestCandle" in the array is the one that JUST CLOSED.
    // We must wait at least 5 seconds after closing (the 5m mark) to allow 
    // broker calculations to settle and the next candle to begin properly.
    const settlementNowMs = Date.now();
    const candleCloseTime = getCandleCloseTime(latestCandleTime, FIVE_MINUTES_MS);
    const secondsSinceClose = (settlementNowMs - candleCloseTime) / 1000;
    
    console.log(
      `[DATA] ⏱️ Settlement Audit: ` +
      `now='${new Date(settlementNowMs).toISOString()}' | ` +
      `close='${new Date(candleCloseTime).toISOString()}' | ` +
      `diff=${secondsSinceClose.toFixed(3)}s`
    );

    logCandleTiming('5m settlement candidate', latestCandle, FIVE_MINUTES_MS, settlementNowMs, secondsSinceClose);

    if (candleCloseTime > settlementNowMs || secondsSinceClose < 0) {
      return {
        skip: true,
        reason: `SKIP: Invalid future 5m candle timestamp from broker (${secondsSinceClose.toFixed(1)}s since close)`,
        candles5m,
        candles1h,
        candles1m,
        latestCandleTime,
        spread,
        dataStatus: 'FAIL'
      };
    }

    console.log(`[DATA] 5m settlement delay this cycle: ${secondsSinceClose.toFixed(3)}s (threshold ${SETTLEMENT_THRESHOLD_SECONDS}s)`);

    if (secondsSinceClose >= 0 && secondsSinceClose < SETTLEMENT_THRESHOLD_SECONDS) {
      return {
        skip: true,
        reason: `SKIP: Waiting for candle settlement (${secondsSinceClose.toFixed(1)}s since close, need ${SETTLEMENT_THRESHOLD_SECONDS}s)`,
        candles5m,
        candles1h,
        candles1m,
        latestCandleTime,
        spread,
        dataStatus: 'OK'
      };
    }

    // Signal staleness guard — reject candles that arrived too late to act on.
    // Threshold raised from 180s to 295s based on observed GitHub Actions scheduling
    // jitter: logs show cron delivery clustering at 183–185s and 243–245s after candle
    // close. Both clusters are caused by GHA runner queue delays (3–4 min), NOT by
    // pipeline overhead (pipeline itself is ~3–5s). 295s is the maximum safe window:
    // it covers the observed 245s worst-case with a 50s margin while staying inside
    // the 300s (5-minute) candle boundary. The duplicate-candle guard and
    // discardUnclosedCandles() already prevent cross-candle contamination.
    if (secondsSinceClose > 295) {
      return {
        skip: true,
        reason: `SKIP: Candle too stale for reliable entry (${secondsSinceClose.toFixed(1)}s since close, max 295s)`,
        candles5m,
        candles1h,
        candles1m,
        latestCandleTime,
        spread
      };
    }
    
    console.log(`[DATA] Execution Timing: ${secondsSinceClose.toFixed(1)}s since candle close — OK`);

    // ── Validate 1m candles ───────────────────────────────────────────────
    const oneMinuteValidation = validateCandleSeries(candles1m, '1m');
    const oneHourValidation = validateCandleSeries(candles1h, '1h');
    if (!oneMinuteValidation.ok) {
      return { skip: true, reason: `SKIP: ${oneMinuteValidation.reason}`, dataStatus: 'FAIL' };
    }
    if (!oneHourValidation.ok) {
      return { skip: true, reason: `SKIP: ${oneHourValidation.reason}`, dataStatus: 'FAIL' };
    }

    return {
      skip:            false,
      candles5m,
      candles1h,
      candles1m,
      latestCandleTime,
      spread,
      dataStatus: 'OK',
    };

  } catch (err) {
    console.error(`[DATA] Market data failure: ${err.message}`);
    return { skip: true, reason: `SKIP: Market data error - ${err.message}`, dataStatus: 'FAIL' };
  }
}
