// fetch.js — Shared fetch utility with timeout support.
// Used by all modules that make HTTP requests.

const FETCH_TIMEOUT_MS = 8000; // 8 seconds — Vercel function timeout is 10s

function createTimeoutError(url) {
  const err = new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`);
  err.code = 'FETCH_TIMEOUT';
  return err;
}

export async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw createTimeoutError(url);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
