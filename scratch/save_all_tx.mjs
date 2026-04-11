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

  const now = new Date();
  const from = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19);
  const url = `${baseUrl}/api/v1/history/transactions?from=${from}`;

  const res = await fetchWithTimeout(url, {
    headers: { 'X-CAP-API-KEY': process.env.CAPITAL_API_KEY, 'CST': cst, 'X-SECURITY-TOKEN': securityToken },
  });

  const data = await res.json();
  fs.writeFileSync('scratch/all_tx.json', JSON.stringify(data.transactions, null, 2));
  console.log('Saved', data.transactions?.length, 'transactions');
}

main().catch(err => console.error('Error:', err.message));
