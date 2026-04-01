import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  try {
    const raw = await redis.get('bot_state');
    if (!raw) {
      console.log('No state found to clear open trade.');
      return;
    }

    const openTrades = raw.openTrades || [];
    const lenBefore = openTrades.length;
    
    // Filter out the ghost trade that's keeping the bot stuck
    const newTrades = openTrades.filter(t => t.dealReference !== 'o_b6acb451-ab38-43da-9cdf-a8b0f7b483dd');

    const newState = {
      ...raw,
      openTrades: newTrades,
      botEnabled: true,
      stateIntegrityOk: true,
      criticalFailure: false,
      criticalFailureReason: '',
      pendingOrder: null, 
    };

    await redis.set('bot_state', newState);
    console.log(`Cleared ghost trade! Open trades went from ${lenBefore} to ${newTrades.length}.`);
    console.log('Bot fully enabled.');
  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();
