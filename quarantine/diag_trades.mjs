import fs from 'fs';
import { getCapitalSession } from './lib/session.js';
import { fetchBrokerTradeStats } from './lib/execution.js';

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
    // Wrap fetchBrokerTradeStats to capture the IDs
    // Since we can't easily modify the file and run it, let's just re-implement a minimal version here
    const { baseUrl, cst, securityToken } = session;
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('.')[0];
    const historyUrl = `${baseUrl}/api/v1/history/transactions?from=${from}`;
    
    const hRes = await fetch(historyUrl, {
      headers: { 'X-CAP-API-KEY': process.env.CAPITAL_API_KEY, 'CST': cst, 'X-SECURITY-TOKEN': securityToken },
    });
    const hData = await hRes.json();
    const goldOnly = (hData.transactions || []).filter(t => t.instrumentName?.includes('GOLD'));
    
    console.log('--- RECENT GOLD TRANSACTIONS ---');
    goldOnly.forEach(t => {
      console.log(`${t.date} | ${t.note} | dealId: ${t.dealId} | ref: ${t.dealReference}`);
    });

  } catch (err) {
    console.warn('Error during analysis:', err.message);
  }
}

main();
