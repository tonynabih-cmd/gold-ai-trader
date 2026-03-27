import './load_env.js';
import { getCapitalSession } from '../lib/session.js';
import { fetchBrokerTradeStats } from '../lib/execution.js';

async function verifySync() {
  console.log('Verifying Broker Stats Sync...');
  const session = await getCapitalSession();
  const stats = await fetchBrokerTradeStats(session);
  
  if (stats) {
    console.log('--- Broker Sync Results ---');
    console.log(`Total Trades (48h): ${stats.totalTrades}`);
    console.log(`Today's Trades:      ${stats.todayTrades}`);
    console.log(`Total P&L:           $${stats.totalPnl.toFixed(2)}`);
    console.log(`Synced At:           ${stats.syncedAt}`);
    
    if (stats.totalTrades === 10) {
      console.log('✅ Matches Capital.com (10 trades).');
    } else {
      console.log(`❌ Discrepancy! Broker says ${stats.totalTrades}, expected 10.`);
    }
  } else {
    console.error('Failed to fetch broker stats.');
  }
}

verifySync().catch(console.error);
