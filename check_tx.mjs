import { getCapitalSession } from './lib/session.js';
import { fetchWithTimeout } from './lib/fetch.js';

async function run() {
  const session = await getCapitalSession();
  const from = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().split('.')[0];
  const to = new Date().toISOString().split('.')[0];
  console.log(`Fetching from ${from} to ${to}`);
  const url = `${session.baseUrl}/api/v1/history/transactions?from=${from}&to=${to}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
      'CST': session.cst,
      'X-SECURITY-TOKEN': session.securityToken,
    },
  });
  if (!res.ok) {
    console.error('Failed to fetch', await res.text());
    return;
  }
  const data = await res.json();
  console.log('Transactions:');
  const txs = data.transactions || [];
  txs.forEach(t => {
    console.log(`- Ref: ${t.dealReference || t.dealId || t.reference}, Note: ${t.note}, PnL: ${t.profitAndLoss}, Instr: ${t.instrumentName}, Date: ${t.date}`);
  });
  console.log('Done.');
}
run();
