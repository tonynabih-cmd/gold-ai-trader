import './load_env.js';
import { getCapitalSession } from '../lib/session.js';
import { fetchWithTimeout } from '../lib/fetch.js';

async function checkHistory() {
  const session = await getCapitalSession();
  const { baseUrl, cst, securityToken } = session;

  const from = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().split('.')[0];
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
    console.error('Failed to fetch history:', res.status);
    return;
  }

  const data = await res.json();
  const transactions = data.transactions || [];
  
  // Filter for BUY trades (Longs)
  const trades = transactions;
  
  console.log(`Found ${trades.length} Gold trades in last 48h:`);
  if (trades.length > 0) console.log('First trade keys:', Object.keys(trades[0]));
  trades.forEach(t => {
    console.log(`- ${t.date} | ${t.reference || t.dealId || 'N/A'} | ${t.instrumentName} | Type: ${t.type} | P&L: ${t.profitAndLoss}`);
  });
}

checkHistory().catch(console.error);
