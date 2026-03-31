// fetch.js — Shared fetch utility with timeout support.
// Used by all modules that make HTTP requests.
//
// Default timeout (8s) is calibrated for Capital.com broker API calls.
// Pass a custom timeoutMs for slower external APIs (e.g. 30s for LLM endpoints).

const FETCH_TIMEOUT_MS = 8000; // 8 seconds — suitable for broker API calls (Vercel function maxDuration is 60s)

function createTimeoutError(url, timeoutMs) {
  const err = new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
  err.code = 'FETCH_TIMEOUT';
  return err;
}

export async function fetchWithTimeout(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw createTimeoutError(url, timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
