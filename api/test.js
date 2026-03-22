import { getCapitalSession } from '../lib/session.js';
import { loadState } from '../lib/state.js';

export default async function handler(req, res) {
  const result = {
    capitalApi: { status: 'red', message: '' },
    cronJob:    { status: 'red', message: '' },
    kvStorage:  { status: 'red', message: '' },
  };

  // 1. Test KV Storage
  let botState;
  try {
    botState = await loadState();
    if (botState && typeof botState === 'object') {
      result.kvStorage.status = 'green';
      result.kvStorage.message = 'State loaded successfully from Upstash Redis';
    } else {
      result.kvStorage.message = 'loadState returned invalid data type';
    }
  } catch (err) {
    result.kvStorage.message = `KV error: ${err.message}`;
  }

  // 2. Test Capital.com API
  try {
    const session = await getCapitalSession();
    if (session && session.cst && session.securityToken) {
      result.capitalApi.status = 'green';
      result.capitalApi.message = 'Authenticated successfully with Capital.com';
    } else {
      result.capitalApi.message = 'Session created but missing tokens';
    }
  } catch (err) {
    result.capitalApi.message = `Capital.com auth failed: ${err.message}`;
  }

  // 3. Test Cron Job heartbeat
  try {
    if (botState && botState.lastHeartbeat) {
      // Compare current time with the last heartbeat timestamp
      const minsSinceHeartbeat = (Date.now() - botState.lastHeartbeat) / 60000;
      if (minsSinceHeartbeat < 15) { // Expected every 5-10m
        result.cronJob.status = 'green';
        result.cronJob.message = `Cron is actively running (last heartbeat ${Math.floor(minsSinceHeartbeat)} minutes ago)`;
      } else {
        result.cronJob.message = `Cron may be completely stalled or inactive (last heartbeat ${Math.floor(minsSinceHeartbeat)} minutes ago)`;
      }
    } else {
      result.cronJob.message = 'No heartbeat ping found in state. Cron has never run or state was wiped missing history.';
    }
  } catch (err) {
    result.cronJob.message = `Error checking cron heartbeat: ${err.message}`;
  }

  return res.json(result);
}
