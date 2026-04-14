import fs from 'fs';
import { Redis } from '@upstash/redis';

// Load .env.local
try {
  const envFile = fs.readFileSync('.env.local', 'utf8');
  const envLines = envFile.split('\n');
  envLines.forEach(line => {
    const match = line.match(/^([^#\s=]+)="?([^"\n\r]*)"?/);
    if (match) {
      process.env[match[1]] = match[2];
    }
  });
} catch (e) {
  console.error('Failed to load .env.local');
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  const s = await redis.get('bot_state');
  if (!s) {
    console.log('No state found');
    return;
  }
  const lastTs = parseInt(s.lastOrderTimestamp) || 0;
  console.log(JSON.stringify({
    lastOrderTimestamp: lastTs,
    lastOrderTimestampUAE: new Date(lastTs).toLocaleString('en-US', {timeZone: 'Asia/Dubai'}),
    isRelaxedMode: (Date.now() - lastTs) > (48 * 60 * 60 * 1000)
  }, null, 2));
}

main().catch(console.error);
