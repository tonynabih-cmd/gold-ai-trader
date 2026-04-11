import fs from 'fs';
import { getCapitalSession } from '../lib/session.js';
import { fetchWithTimeout } from '../lib/fetch.js';

// Simple .env.local loader
try {
  const env = fs.readFileSync('.env.local', 'utf-8');
  env.split('\n').forEach(line => {
    if (line.trim() && !line.startsWith('#')) {
      const idx = line.indexOf('=');
      if (idx !== -1) {
        const k = line.substring(0, idx).trim();
        const v = line.substring(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        process.env[k] = v;
      }
    }
  });
} catch (e) {
  console.log("Could not load .env.local:", e.message);
}

async function run() {
  const session = await getCapitalSession();
  const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('.')[0];
  const url = `${session.baseUrl}/api/v1/history/transactions?from=${from}`;

  const res = await fetchWithTimeout(url, {
    headers: {
      'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
      'CST':              session.cst,
      'X-SECURITY-TOKEN': session.securityToken,
    },
  });

  const data = await res.json();
  const transactions = data.transactions || [];
  
  if (transactions.length > 0) {
      console.log("Common fields in transactions:");
      const allKeys = new Set();
      transactions.forEach(t => Object.keys(t).forEach(k => allKeys.add(k)));
      console.log([...allKeys]);
      
      const gold = transactions.filter(t => t.instrumentName?.includes('GOLD'));
      if (gold.length > 0) {
          console.log("Example GOLD transaction:");
          console.log(gold[0]);
      }
  }
}

run().catch(console.error);
