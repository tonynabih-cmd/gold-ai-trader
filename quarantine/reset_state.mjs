import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  try {
    const raw = await redis.get('bot_state');
    if (!raw) {
      console.log('No state found to reset.');
      return;
    }

    console.log('Current state:', JSON.stringify(raw, null, 2));

    const newState = {
      ...raw,
      botEnabled: true,
      stateIntegrityOk: true,
      criticalFailure: false,
      criticalFailureReason: '',
      pendingOrder: null, // Clear the failed pending order
    };

    await redis.set('bot_state', newState);
    console.log('State reset successfully! Bot is now enabled and integrity cleared.');
  } catch (err) {
    console.error('Error resetting state:', err.message);
  }
}

main();
