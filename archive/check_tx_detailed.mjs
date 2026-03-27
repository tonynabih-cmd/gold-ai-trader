import fs from 'fs';
import './load_env.js';
const { getCapitalSession } = await import('../lib/session.js');
const { fetchWithTimeout } = await import('../lib/fetch.js');

async function checkHistory() {
  const session = await getCapitalSession();
  const { baseUrl, cst, securityToken } = session;

  const from = '2026-03-26T00:00:00';
  const to = '2026-03-27T23:59:59';
  
  const url = `${baseUrl}/api/v1/history/transactions?from=${from}&to=${to}`;
  
  const res = await fetchWithTimeout(url, {
    headers: {
      'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
      'CST': cst,
      'X-SECURITY-TOKEN': securityToken,
    },
  });

  const data = await res.json();
  const tx = data.transactions || [];
  console.log(`Found ${tx.length} transactions in the last 48h:`);
  tx.forEach(t => {
      console.log(`[${t.date}] ${t.instrumentName} | Type: ${t.transactionType} | P&L: ${t.profitAndLoss}`);
  });
}

checkHistory().catch(console.error);
