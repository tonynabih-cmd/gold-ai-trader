import './load_env.js';
import { getLogs } from './lib/logger.js';

async function main() {
  const logs = await getLogs();
  const trades = logs.filter(l => l.tradeExecuted || l.reason?.includes('CLOSED'));
  console.log('--- RECENT TRADE AUDIT ---');
  trades.slice(-5).forEach(l => {
    console.log(`[${l.timeUAE}] ${l.tradeId}`);
    console.log(`  Balance: ${l.balance} | Action: ${l.signalDetected}`);
    console.log(`  Entry: ${l.entryPrice} | SL: ${l.stopLoss} | TP: ${l.takeProfit}`);
    console.log(`  Reason: ${l.reason}`);
    console.log('---------------------------');
  });
}

main().catch(console.error);
