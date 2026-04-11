import fs from 'fs';
import { getCapitalSession } from '../lib/session.js';
import { fetchWithTimeout } from '../lib/fetch.js';

// Load .env.local
try {
  const env = fs.readFileSync('.env.local', 'utf-8');
  env.split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const val = parts.slice(1).join('=').trim().replace(/"/g, '').replace(/'/g, '');
      if (key) process.env[key] = val;
    }
  });
} catch (e) {}

async function test() {
  const session = await getCapitalSession();
  const from = new Date(Date.now()-14*24*60*60*1000).toISOString().split('.')[0];
  const url = session.baseUrl + '/api/v1/history/activity?from=' + from;
  const res = await fetchWithTimeout(url, {
    headers: {
      'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
      'CST': session.cst,
      'X-SECURITY-TOKEN': session.securityToken
    }
  });
  const data = await res.json();
  fs.writeFileSync('scratch/all_activity.json', JSON.stringify(data.activities, null, 2));
  console.log('Saved', data.activities?.length, 'activities');
}
test().catch(console.error);
