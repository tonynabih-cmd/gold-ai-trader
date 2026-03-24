import './load_env.js';
import { getLogs } from './lib/logger.js';

async function main() {
  console.log('Fetching last 50 logs for deep audit...');
  const logs = await getLogs();
  const last50 = logs.slice(-50);
  last50.forEach(l => {
    if (l.signalDetected !== 'NONE' || l.tradeExecuted || l.reason?.includes('CLOSED')) {
      console.log(`[${l.timeUAE}] ${l.signalDetected} | Executed: ${l.tradeExecuted} | Reason: ${l.reason} | Balance: ${l.balance} | P&L: ${l.result?.realizedPnl || 'N/A'}`);
    }
  });
}

main().catch(console.error);
