import { Redis } from '@upstash/redis';
import fs from 'fs';

const envContent = fs.readFileSync('.env.local', 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const [key, ...valueParts] = line.split('=');
  const value = valueParts.join('=');
  if (key && value) env[key.trim()] = value.trim().replace(/^["']|["']$/g, '');
});

const redis = new Redis({
  url: env.KV_REST_API_URL,
  token: env.KV_REST_API_TOKEN,
});

async function analyzeLogs() {
  const logs = await redis.lrange('trade_logs_list', -1000, -1);
  const dbgRejections = {};

  for (const logStr of logs) {
    const log = typeof logStr === 'string' ? JSON.parse(logStr) : logStr;
    const dbgReason = (log.dbgRejectReason || 'NONE').trim();
    dbgRejections[dbgReason] = (dbgRejections[dbgReason] || 0) + 1;
  }

  console.log('\n--- STRATEGY DEBUG REJECTIONS (dbgRejectReason) ---');
  Object.entries(dbgRejections).sort((a,b) => b[1]-a[1]).forEach(([r,c]) => console.log(`${c.toString().padEnd(5)} | ${r}`));
}
analyzeLogs().catch(console.error);
