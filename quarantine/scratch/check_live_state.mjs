
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function run() {
    const state = await redis.get('bot_state');
    console.log("Current Bot State:");
    console.log(JSON.stringify(state, null, 2));
}

run().catch(console.error);
