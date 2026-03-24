import './load_env.js';
import { Redis } from '@upstash/redis';
import { getCapitalSession } from './lib/session.js';
import { fetchAccountData } from './lib/execution.js';
import { loadState } from './lib/state.js';

import { fetchWithTimeout } from './lib/fetch.js';

async function check() {
  console.log('--- GOLD TRADER BOT HEALTH CHECK ---');

  // 1. Spread Limit
  const rawSpread = process.env.MAX_SPREAD;
  const spreadLimit = parseFloat(rawSpread) || 0.40;
  if (spreadLimit === 0.40) {
    console.log('[PASS] Spread limit resolves to 0.40 (Ultra-Safe default)');
  } else if (spreadLimit < 0.50) {
    console.log(`[PASS] Spread limit resolves to ${spreadLimit} (tight limit)`);
  } else {
    console.log(`[WARN] Spread limit resolves to ${spreadLimit} (wider than default)`);
  }

  // 2. Upstash Connection
  try {
    const redis = new Redis({
      url:   process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
    const pong = await redis.ping();
    if (pong === 'PONG') {
      console.log('[PASS] Upstash connection is live (PONG)');
    } else {
      throw new Error(`Unexpected ping response: ${pong}`);
    }
  } catch (err) {
    console.log(`[FAIL] Upstash connection failed: ${err.message}`);
  }

  // 3. Capital.com API
  try {
    const session = await getCapitalSession();
    const accountData = await fetchAccountData(session);
    if (accountData) {
      console.log(`[PASS] Capital.com API reachable. Balance: ${accountData.balance} ${process.env.CAPITAL_ENV === 'demo' ? '(DEMO)' : '(LIVE)'}`);
    } else {
      throw new Error('Could not fetch account data');
    }
  } catch (err) {
    console.log(`[FAIL] Capital.com API failed: ${err.message}`);
  }

  // 4. Orphaned Trades
  try {
    const botState = await loadState();
    const openTrades = botState.openTrades || [];
    
    // Re-fetch live positions if session is available
    const session = await getCapitalSession().catch(() => null);
    if (session) {
      const { baseUrl, cst, securityToken } = session;
      const res = await fetchWithTimeout(`${baseUrl}/api/v1/positions`, {
        headers: {
          'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
          'CST':              cst,
          'X-SECURITY-TOKEN': securityToken,
        },
      });
      const data = await res.json();
      const livePositionsCount = data.positions ? data.positions.length : 0;
      
      if (openTrades.length === livePositionsCount) {
        console.log(`[PASS] Bot state and Broker state match (Open trades: ${openTrades.length})`);
      } else {
        console.log(`[FAIL] Mismatch! Bot thinks ${openTrades.length} trades open, but Broker has ${livePositionsCount}`);
      }
    } else {
      console.log('[SKIP] Could not verify orphaned trades (Broker API unreachable)');
    }
  } catch (err) {
    console.log(`[FAIL] Orphaned trades check failed: ${err.message}`);
  }

  console.log('--- HEALTH CHECK FINISHED ---');
}

check().catch(console.error);
