import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  try {
    const raw = await redis.get('bot_state');
    console.log(JSON.stringify(raw, null, 2));
  } catch (err) {
    console.error('Error fetching state:', err.message);
  }
}

main();
