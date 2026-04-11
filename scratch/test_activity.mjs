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
  const url = session.baseUrl + '/api/v1/history/activity?from=' + new Date(Date.now()-7*24*60*60*1000).toISOString().split('.')[0];
  const res = await fetchWithTimeout(url, {
    headers: {
      'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
      'CST': session.cst,
      'X-SECURITY-TOKEN': session.securityToken
    }
  });
  console.log('Status:', res.status);
  const data = await res.json();
  console.log(JSON.stringify(data.activities?.slice(0, 5), null, 2));
}
test().catch(console.error);
