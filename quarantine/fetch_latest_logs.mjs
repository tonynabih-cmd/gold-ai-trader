import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  try {
    const raw = await redis.lrange('trade_logs_list', -20, -1);
    const logs = Array.isArray(raw) ? raw.map(entry => {
        if (typeof entry === 'string') return JSON.parse(entry);
        return entry;
    }) : [];
    console.log(JSON.stringify(logs, null, 2));
  } catch (err) {
    console.error('Error fetching logs:', err.message);
  }
}

main();
