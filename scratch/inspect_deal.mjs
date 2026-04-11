import fs from 'fs';
import { getCapitalSession } from '../lib/session.js';
import { fetchWithTimeout } from '../lib/fetch.js';

const envFile = fs.readFileSync('.env.local', 'utf-8');
envFile.split('\n').forEach(line => {
  const parts = line.split('=');
  if (parts.length >= 2) {
    const key = parts[0].trim();
    const val = parts.slice(1).join('=').trim().replace(/"/g, '').replace(/'/g, '');
    if (key) process.env[key] = val;
  }
});

async function main() {
  const session = await getCapitalSession();
  const { baseUrl, cst, securityToken } = session;

  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19);
  const url = `${baseUrl}/api/v1/history/transactions?from=${from}`;

  const res = await fetchWithTimeout(url, {
    headers: {
      'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
      'CST': cst,
      'X-SECURITY-TOKEN': securityToken,
    },
  });

  const data = await res.json();
  const transactions = data.transactions || [];
  
  // Find a specific dealId from a closed trade
  const closed = transactions.find(t => t.note?.includes('closed') && t.dealId);
  if (!closed) {
    console.log('No closed trades found');
    return;
  }

  const targetId = closed.dealId;
  console.log('Inspecting transactions for dealId:', targetId);
  
  const related = transactions.filter(t => t.dealId === targetId || t.reference === targetId || t.note?.includes(targetId));
  console.log(JSON.stringify(related, null, 2));
}

main().catch(err => console.error('Error:', err.message));
