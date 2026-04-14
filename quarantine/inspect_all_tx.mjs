import fs from 'fs';
import { getCapitalSession } from './lib/session.js';
import { fetchWithTimeout } from './lib/fetch.js';

async function main() {
  try {
    const envFile = fs.readFileSync('.env.local', 'utf-8');
    envFile.split('\n').forEach(line => {
      const parts = line.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const val = parts.slice(1).join('=').trim().replace(/"/g, '').replace(/'/g, '');
        if (key) process.env[key] = val;
      }
    });

    const session = await getCapitalSession();
    const { baseUrl, cst, securityToken } = session;
    
    // Exact time range of interest (12:00 to 18:00 UTC)
    const from = "2026-04-06T12:00:00";
    const to = "2026-04-06T19:00:00";
    const historyUrl = `${baseUrl}/api/v1/history/transactions?from=${from}&to=${to}`;
    
    console.log(`Fetching history from ${from} to ${to}...`);
    const hRes = await fetchWithTimeout(historyUrl, {
      headers: { 'X-CAP-API-KEY': process.env.CAPITAL_API_KEY, 'CST': cst, 'X-SECURITY-TOKEN': securityToken },
    });

    if (!hRes.ok) {
        const body = await hRes.text();
        console.error(`History API error ${hRes.status}: ${body}`);
        return;
    }

    const hData = await hRes.json();
    const transactions = hData.transactions || [];
    
    console.log(`\n--- ALL TRANSACTIONS (${transactions.length} found) ---`);
    transactions.forEach(t => {
        console.log(`[${t.date}] ${t.instrumentName} | ${t.note} | P&L: ${t.profitAndLoss} | DealId: ${t.dealId}`);
    });

  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();
