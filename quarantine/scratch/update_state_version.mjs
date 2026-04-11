
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function run() {
    const state = await redis.get('bot_state');
    if (state) {
        state.strategyVersion = 'v1.4';
        await redis.set('bot_state', state);
        console.log("Successfully updated strategyVersion to v1.4 in Redis.");
    } else {
        console.log("No state found to update.");
    }
}

run().catch(console.error);
