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
  console.log("Authenticating with Capital.com...");
  const session = await getCapitalSession();
  
  const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('.')[0];
  const to = new Date().toISOString().split('.')[0];
  const url = `${session.baseUrl}/api/v1/history/transactions?from=${from}&to=${to}`;

  console.log(`Fetching 7 days of transactions...`);
  const res = await fetchWithTimeout(url, {
    headers: {
      'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
      'CST':              session.cst,
      'X-SECURITY-TOKEN': session.securityToken,
    },
  });

  if (!res.ok) {
    console.error(`Error: ${res.status}`);
    return;
  }

  const data = await res.json();
  const transactions = data.transactions || [];
  
  console.log(`Found ${transactions.length} total transactions.`);
  
  const goldTrades = transactions.filter(t => t.instrumentName?.includes('GOLD'));
  const types = [...new Set(goldTrades.map(t => t.transactionType))];
  const notes = [...new Set(goldTrades.map(t => t.note))];
  
  console.log("Unique GOLD transaction types:", types);
  console.log("Unique GOLD transaction notes:", notes);
  
  const opened = goldTrades.filter(t => t.note?.includes('opened'));
  console.log(`Opened: ${opened.length}`);
  if (opened.length > 0) {
      console.log("Sample opened:", JSON.stringify(opened[0], null, 2));
  }
}

run().catch(console.error);
