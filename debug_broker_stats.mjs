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
    
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('.')[0];
    const to = new Date().toISOString().split('.')[0];
    const historyUrl = `${baseUrl}/api/v1/history/transactions?from=${from}&to=${to}`;
    
    console.log(`Fetching history from ${from} to ${to}...`);
    const hRes = await fetchWithTimeout(historyUrl, {
      headers: { 'X-CAP-API-KEY': process.env.CAPITAL_API_KEY, 'CST': cst, 'X-SECURITY-TOKEN': securityToken },
    });

    if (!hRes.ok) {
        console.error(`History API error: ${hRes.status}`);
        return;
    }

    const hData = await hRes.json();
    const transactions = hData.transactions || [];
    
    const uaeNow = new Date(Date.now() + 4 * 60 * 60 * 1000);
    const todayStr = uaeNow.toISOString().slice(0, 10);
    console.log(`Current UAE Date: ${todayStr}`);

    transactions.forEach(t => {
        const tDate = new Date(t.date);
        const tDateUAE = new Date(tDate.getTime() + (4 * 60 * 60 * 1000));
        const tDayStr = tDateUAE.toISOString().slice(0, 10);
        const isToday = tDayStr === todayStr;
        
        const note = (t.note || '').toLowerCase();
        const isOpening = note.includes('open') || note.includes('accepted');
        const isClosure = note.includes('closed') || note.includes('stop') || note.includes('limit') || note.includes('liquid');

        if (t.instrumentName?.includes('GOLD')) {
            console.log(`[${t.date}] UAE:${tDayStr} | ${t.instrumentName} | ${t.note} | isToday=${isToday} | isOpening=${isOpening} | isClosure=${isClosure}`);
        }
    });

    // Check open positions too
    const posUrl = `${baseUrl}/api/v1/positions`;
    const pRes = await fetchWithTimeout(posUrl, {
      headers: { 'X-CAP-API-KEY': process.env.CAPITAL_API_KEY, 'CST': cst, 'X-SECURITY-TOKEN': securityToken },
    });
    if (pRes.ok) {
        const pData = await pRes.json();
        const livePositions = pData.positions || [];
        console.log('\n--- OPEN POSITIONS ---');
        livePositions.forEach(p => {
             const createdStr = p.position?.createdDate || p.position?.date;
             const tDateUAE = new Date(new Date(createdStr).getTime() + (4 * 60 * 60 * 1000));
             const tDayStr = tDateUAE.toISOString().slice(0, 10);
             console.log(`[${createdStr}] UAE:${tDayStr} | ${p.position?.instrumentName} | ${p.position?.direction} | size=${p.position?.size}`);
        });
    }

  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();
