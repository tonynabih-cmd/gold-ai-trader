import fs from 'fs';
import { getCapitalSession } from './lib/session.js';

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

    // Fetch all position history from start of yesterday
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const from = yesterday.toISOString().split('.')[0];
    
    // Transactions
    const hRes = await fetch(`${baseUrl}/api/v1/history/transactions?from=${from}`, {
      headers: { 'X-CAP-API-KEY': process.env.CAPITAL_API_KEY, 'CST': cst, 'X-SECURITY-TOKEN': securityToken },
    });
    const hData = await hRes.json();
    const goldTrans = (hData.transactions || []).filter(t => t.instrumentName?.includes('GOLD'));

    // Open Positions
    const pRes = await fetch(`${baseUrl}/api/v1/positions`, {
      headers: { 'X-CAP-API-KEY': process.env.CAPITAL_API_KEY, 'CST': cst, 'X-SECURITY-TOKEN': securityToken },
    });
    const pData = await pRes.json();
    const openGold = (pData.positions || []).filter(p => 
      (p.market?.epic && p.market.epic.includes('GOLD')) || 
      (p.position?.instrumentName && p.position.instrumentName.includes('GOLD'))
    );

    const uaeOffset = 4 * 60 * 60 * 1000;
    const todayStr = new Date(Date.now() + uaeOffset).toISOString().slice(0, 10);

    const seenIds = new Set();
    console.log('--- ANALYSIS OF TODAY (UAE) ---');
    console.log(`Today string (UAE): ${todayStr}`);

    goldTrans.forEach(t => {
      const uaeDate = new Date(new Date(t.date).getTime() + uaeOffset);
      const isToday = uaeDate.toISOString().slice(0, 10) === todayStr;
      if (isToday) {
        seenIds.add(t.dealId);
        console.log(`[HIST] ID=${t.dealId} | Date=${t.date} | ${t.note} | P&L=${t.profitAndLoss}`);
      }
    });

    openGold.forEach(p => {
      const createdStr = p.position?.createdDate || p.position?.date;
      const uaeDate = new Date(new Date(createdStr).getTime() + uaeOffset);
      const isToday = uaeDate.toISOString().slice(0, 10) === todayStr;
      if (isToday) {
        seenIds.add(p.position.dealId);
        console.log(`[OPEN] ID=${p.position.dealId} | Created=${createdStr} | ${p.position.direction}`);
      }
    });

    console.log(`\nFinal today trades count (distinct deal IDs found): ${seenIds.size}`);

  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();
