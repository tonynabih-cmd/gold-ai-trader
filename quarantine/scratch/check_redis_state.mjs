import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   'https://well-hawk-71664.upstash.io',
  token: 'gQAAAAAAARfwAAIncDE5Y2Y4MTg0MWZlN2E0ZTMxYjdkYjZlZGNlODgyNTJiZXAxNzE2NjQ',
});

async function main() {
  const state = await redis.get('bot_state');
  if (!state) {
    console.log('No state found');
    return;
  }
  
  console.log('--- RECENT OUTCOMES ---');
  console.log(JSON.stringify(state.recentOutcomes?.slice(-10), null, 2));
  
  console.log('\n--- OPEN TRADES ---');
  console.log(JSON.stringify(state.openTrades, null, 2));
  
  console.log('\n--- BALANCE ---');
  console.log('Balance:', state.balance);
  console.log('Equity:', state.equity);
}

main().catch(console.error);
