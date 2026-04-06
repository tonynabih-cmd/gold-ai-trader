import fs from 'fs';
import { getCapitalSession } from './lib/session.js';
import { fetchWithTimeout } from './lib/fetch.js';

async function main() {
  try {
    const env = fs.readFileSync('.env.local', 'utf-8');
    env.split('\n').forEach(line => {
      const parts = line.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const val = parts.slice(1).join('=').trim().replace(/"/g, '');
        process.env[key] = val;
      }
    });

    const session = await getCapitalSession();
    const { baseUrl, cst, securityToken } = session;

    // Look back since start of today UAE (which is 2026-04-05 20:00:00 UTC)
    const from = '2026-04-05T20:00:00';
    const to = new Date().toISOString().split('.')[0];
    const url = `${baseUrl}/api/v1/history/transactions?from=${from}&to=${to}`;

    const res = await fetchWithTimeout(url, {
      headers: {
        'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
        'CST': cst,
        'X-SECURITY-TOKEN': securityToken,
      },
    });

    if (!res.ok) {
      throw new Error(`History fetch failed: ${res.status}`);
    }

    const data = await res.json();
    const goldOnly = (data.transactions || []).filter(t => t.instrumentName?.includes('GOLD'));
    
    console.log(`--- GOLD TRANSACTIONS SINCE 11 AM UAE (Approx) ---`);
    goldOnly.forEach(t => {
      console.log(`${t.date} | ${t.note} | P&L: ${t.profitAndLoss} | dealId: ${t.dealId}`);
    });

  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();
