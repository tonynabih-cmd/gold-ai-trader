import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   'https://well-hawk-71664.upstash.io',
  token: 'gQAAAAAAARfwAAIncDE5Y2Y4MTg0MWZlN2E0ZTMxYjdkYjZlZGNlODgyNTJiZXAxNzE2NjQ',
});

async function main() {
  try {
    const raw = await redis.lrange('trade_logs_list', 0, -1);
    const logs = Array.isArray(raw) ? raw.map(entry => {
        try { return typeof entry === 'string' ? JSON.parse(entry) : entry; }
        catch (e) { return null; }
    }).filter(l => l !== null) : [];

    const interesting = logs.filter(l => l.timeUAE.includes('4/6/2026, 5:50:08 PM') || l.timeUAE.includes('4/6/2026, 6:01:11 PM'));
    
    console.log(JSON.stringify(interesting, null, 2));

  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();
