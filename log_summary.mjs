import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  try {
    const raw = await redis.lrange('trade_logs_list', -100, -1);
    const logs = Array.isArray(raw) ? raw.map(entry => {
        try { return typeof entry === 'string' ? JSON.parse(entry) : entry; }
        catch (e) { return { error: 'parse error', raw: entry }; }
    }) : [];
    
    // Print summary: timeUAE and reason
    logs.forEach(l => {
        console.log(`${l.timeUAE} | ${l.reason}`);
    });
  } catch (err) {
    console.error('Error fetching logs:', err.message);
  }
}

main();
