import { Redis } from '@upstash/redis';
import fs from 'fs';

// Load .env.local manually
try {
  const envFile = fs.readFileSync('.env.local', 'utf-8');
  envFile.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0) {
      const value = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
      process.env[key.trim()] = value;
    }
  });
} catch (e) {
  console.error('Error loading .env.local:', e.message);
}

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  try {
    const raw = await redis.lrange('trade_logs_list', -50, -1);
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
