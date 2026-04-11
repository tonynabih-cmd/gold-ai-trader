import './load_env.js';
import { getLogs } from '../lib/logger.js';

async function main() {
  const logs = await getLogs();
  const executed = logs.filter(l => l.tradeExecuted || l.reason?.includes('CLOSED'));
  console.log(`Auditing ${executed.length} trade-related events...`);
  executed.slice(-10).forEach(l => {
    console.log(`[${l.timeUAE}] Type: ${l.signal?.entryType || 'closure'} | Id: ${l.tradeId} | Ball: ${l.balance} | Reason: ${l.reason}`);
  });
}

main().catch(console.error);
