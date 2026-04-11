/**
 * Dump raw Capital.com transaction structure for debugging pairing logic.
 */
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

  const from = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19);
  const to = new Date().toISOString().slice(0, 19);
  const url = `${baseUrl}/api/v1/history/transactions?from=${from}&to=${to}`;

  const res = await fetchWithTimeout(url, {
    headers: {
      'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
      'CST': cst,
      'X-SECURITY-TOKEN': securityToken,
    },
  });

  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${await res.text()}`);
    return;
  }

  const data = await res.json();
  const transactions = data.transactions || [];
  
  console.log(`Total transactions: ${transactions.length}\n`);
  
  // Show ALL fields of first 10 transactions
  const goldTx = transactions.filter(t => t.instrumentName?.includes('Gold') || t.instrumentName?.includes('GOLD'));
  console.log(`Gold transactions: ${goldTx.length}\n`);
  
  for (let i = 0; i < Math.min(goldTx.length, 15); i++) {
    console.log(`--- TX #${i + 1} ---`);
    console.log(JSON.stringify(goldTx[i], null, 2));
    console.log('');
  }

  // Show unique field keys across all gold transactions
  const allKeys = new Set();
  for (const tx of goldTx) {
    for (const key of Object.keys(tx)) allKeys.add(key);
  }
  console.log('All keys:', [...allKeys].join(', '));

  // Show unique instrument names
  const instruments = new Set(transactions.map(t => t.instrumentName));
  console.log('\nInstrument names:', [...instruments]);

  // Show unique notes
  const notes = new Set(goldTx.map(t => t.note));
  console.log('\nUnique notes:', [...notes]);

  // Group by reference/dealId
  const byRef = {};
  for (const tx of goldTx) {
    const ref = tx.reference || tx.dealId || 'unknown';
    if (!byRef[ref]) byRef[ref] = [];
    byRef[ref].push(tx);
  }
  console.log(`\nGrouped by reference: ${Object.keys(byRef).length} groups`);
  for (const [ref, txs] of Object.entries(byRef)) {
    console.log(`  ${ref}: ${txs.length} txs → ${txs.map(t => t.note || '(no note)').join(' | ')}`);
  }
}

main().catch(err => console.error('Error:', err.message));
