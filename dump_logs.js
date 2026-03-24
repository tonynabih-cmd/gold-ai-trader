import fs from 'fs';
import { Redis } from '@upstash/redis';

// Simple .env.local loader
try {
  const env = fs.readFileSync('.env.local', 'utf-8');
  env.split('\n').forEach(line => {
    if (line.trim() && !line.startsWith('#')) {
      const idx = line.indexOf('=');
      if (idx !== -1) {
        const k = line.substring(0, idx).trim();
        const v = line.substring(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        process.env[k] = v;
      }
    }
  });
} catch (e) {
  console.log("Could not load .env.local:", e.message);
}

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function run() {
  console.log("Fetching logs from Redis...");
  const raw = await redis.lrange('trade_logs_list', -50, -1);
  const logs = raw.map(entry => {
    if (typeof entry === 'string') {
      try { return JSON.parse(entry); } catch { return entry; }
    }
    return entry;
  });
  
  fs.writeFileSync('logs_dump.json', JSON.stringify(logs, null, 2));
  console.log("Logs dumped to logs_dump.json");
}

run().catch(console.error);
