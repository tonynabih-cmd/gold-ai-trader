import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  try {
    const raw = await redis.lrange('trade_logs_list', -1, -1);
    const entry = raw[0];
    const log = typeof entry === 'string' ? JSON.parse(entry) : entry;
    console.log(JSON.stringify(log, null, 2));
  } catch (err) {
    console.error('Error fetching logs:', err.message);
  }
}

main();
