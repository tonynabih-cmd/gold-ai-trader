// session.js — Create an authenticated Capital.com API session.
// Returns { baseUrl, cst, securityToken } used by all other Capital.com API calls.
// Session tokens expire after ~10 minutes of inactivity — a fresh session is
// created at the start of each cron invocation (no token reuse across invocations).

import { fetchWithTimeout } from './fetch.js';

async function getCachedSession() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try {
    const res = await fetchWithTimeout(`${process.env.KV_REST_API_URL}/get/capital_session_cache`, {
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body.result) return null;
    const cached = JSON.parse(body.result);
    // Use cache if it's less than 8 minutes old
    if (cached.cst && cached.securityToken && (Date.now() - cached.timestamp < 8 * 60 * 1000)) {
      return cached;
    }
  } catch (err) {
    console.warn('[SESSION] Redis cache read error:', err.message);
  }
  return null;
}

async function setCachedSession(cst, securityToken) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return;
  try {
    const payload = JSON.stringify({ cst, securityToken, timestamp: Date.now() });
    await fetchWithTimeout(`${process.env.KV_REST_API_URL}/set/capital_session_cache`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
      body: payload
    });
  } catch (err) {
    console.warn('[SESSION] Redis cache write error:', err.message);
  }
}

async function attemptSession(baseUrl) {
  // Validate required env vars before attempting auth
  if (!process.env.CAPITAL_API_KEY)  throw new Error('CAPITAL_API_KEY env var is not set');
  if (!process.env.CAPITAL_EMAIL)    throw new Error('CAPITAL_EMAIL env var is not set');
  if (!process.env.CAPITAL_PASSWORD) throw new Error('CAPITAL_PASSWORD env var is not set');

  const cached = await getCachedSession();
  if (cached) {
    return { baseUrl, cst: cached.cst, securityToken: cached.securityToken };
  }

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

  await setCachedSession(cst, securityToken);
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
