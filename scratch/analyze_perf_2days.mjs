import fs from 'fs';
import { getCapitalSession } from '../lib/session.js';

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

    // Last 2 days
    const from = '2026-04-09T00:00:00';
    const url = `${baseUrl}/api/v1/history/transactions?from=${from}`;

    const res = await fetch(url, {
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
    
    console.log(`--- GOLD TRANSACTIONS SINCE ${from} ---`);
    let wins = 0;
    let losses = 0;
    let profit = 0;

    goldOnly.forEach(t => {
      console.log(JSON.stringify(t));
    });

    console.log(`\n--- SUMMARY ---`);
    console.log(`Wins: ${wins}, Losses: ${losses}`);
    console.log(`Win Rate: ${wins + losses > 0 ? (wins/(wins+losses)*100).toFixed(2) : 0}%`);
    console.log(`Total P&L: $${profit.toFixed(2)}`);

  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();
