import { getCapitalSession } from './lib/session.js';
import { fetchBrokerTradeStats } from './lib/execution.js';

async function main() {
  try {
    const session = await getCapitalSession();
    const stats = await fetchBrokerTradeStats(session);
    console.log('--- BROKER STATS ---');
    console.log(JSON.stringify(stats, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();
