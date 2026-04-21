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

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withRetries(task, {
  attempts = 3,
  delayMs = 750,
  backoffFactor = 2,
  label = 'operation',
} = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await task(attempt);
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === attempts;
      const waitMs = Math.round(delayMs * Math.pow(backoffFactor, attempt - 1));

      console.warn(`[FETCH] ${label} failed on attempt ${attempt}/${attempts}: ${err.message}`);

      if (isLastAttempt) break;
      await sleep(waitMs);
    }
  }

  throw lastError ?? new Error(`${label} failed after ${attempts} attempts`);
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
