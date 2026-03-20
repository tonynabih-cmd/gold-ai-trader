// session.js — Create an authenticated Capital.com API session.
// Returns { baseUrl, cst, securityToken } used by all other Capital.com API calls.
// Session tokens expire after ~10 minutes of inactivity — a fresh session is
// created at the start of each cron invocation (no token reuse across invocations).

const FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Auth request timed out after ${FETCH_TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function attemptSession(baseUrl) {
  // Validate required env vars before attempting auth
  if (!process.env.CAPITAL_API_KEY)  throw new Error('CAPITAL_API_KEY env var is not set');
  if (!process.env.CAPITAL_EMAIL)    throw new Error('CAPITAL_EMAIL env var is not set');
  if (!process.env.CAPITAL_PASSWORD) throw new Error('CAPITAL_PASSWORD env var is not set');

  const res = await fetchWithTimeout(`${baseUrl}/api/v1/session`, {
    method: 'POST',
    headers: {
      'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      identifier: process.env.CAPITAL_EMAIL,
      password:   process.env.CAPITAL_PASSWORD,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`Capital.com auth failed (HTTP ${res.status}): ${body}`);
  }

  const cst           = res.headers.get('CST');
  const securityToken = res.headers.get('X-SECURITY-TOKEN');

  if (!cst)           throw new Error('Capital.com session: CST token missing from response headers');
  if (!securityToken) throw new Error('Capital.com session: X-SECURITY-TOKEN missing from response headers');

  return { baseUrl, cst, securityToken };
}

export async function getCapitalSession() {
  // Capital.com API base URL — demo vs live based on env var
  const baseUrl = process.env.CAPITAL_ENV === 'demo'
    ? 'https://demo-api-capital.backend-capital.com'
    : 'https://api-capital.backend-capital.com';

  // Attempt 1
  try {
    return await attemptSession(baseUrl);
  } catch (firstErr) {
    console.warn(`Capital.com session attempt 1 failed: ${firstErr.message}. Retrying in 2s...`);
  }

  // Wait 2 seconds then retry once
  await new Promise(resolve => setTimeout(resolve, 2000));

  try {
    return await attemptSession(baseUrl);
  } catch (secondErr) {
    // Both attempts failed — throw with combined context
    throw new Error(`Capital.com auth failed after 2 attempts: ${secondErr.message}`);
  }
}
