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

    const from = '2026-04-05T00:00:00';
    const hRes = await fetch(`${baseUrl}/api/v1/history/transactions?from=${from}`, {
      headers: { 'X-CAP-API-KEY': process.env.CAPITAL_API_KEY, 'CST': cst, 'X-SECURITY-TOKEN': securityToken },
    });
    const hData = await hRes.json();
    const goldTrans = (hData.transactions || []).filter(t => t.instrumentName?.includes('GOLD'));

    const uaeOffset = 4 * 60 * 60 * 1000;
    const todayStr = new Date(Date.now() + uaeOffset).toISOString().slice(0, 10);
    console.log(`Today (UAE): ${todayStr}`);

    const idData = {};
    goldTrans.forEach(t => {
      const uaeDate = new Date(new Date(t.date).getTime() + uaeOffset);
      const dayStr = uaeDate.toISOString().slice(0, 10);
      const isToday = dayStr === todayStr;
      
      const id = String(t.dealId || t.reference || '').trim();
      if (!id || id === 'undefined' || id === 'null') return;

      if (!idData[id]) idData[id] = { first: t.date, notes: [], isToday: false };
      idData[id].notes.push(`${t.date}: ${t.note}`);
      if (isToday) idData[id].isToday = true;
    });

    console.log('\n--- TRADES WITH TRANSACTIONS TODAY ---');
    Object.entries(idData).forEach(([id, data]) => {
      if (data.isToday) {
        console.log(`\nDeal ID: ${id}`);
        data.notes.forEach(n => console.log(`  - ${n}`));
      }
    });

  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();
