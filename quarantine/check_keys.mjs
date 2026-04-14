
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  const keys = await redis.keys('logs:*');
  console.log('Available log keys:', keys);
}

main().catch(console.error);
