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
  const logs = await redis.lrange('trade_logs_list', -500, -1);
  const reasonCounts = {};
  for (const logStr of logs) {
    const log = typeof logStr === 'string' ? JSON.parse(logStr) : logStr;
    const reason = (log.reason || log.dbgRejectReason || 'UNKNOWN').trim();
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }
  console.log('\n--- TOP BLOCKERS (Last 500 records) ---');
  Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([reason, count]) => {
      console.log(`${count.toString().padEnd(7)} | ${reason}`);
    });
}
analyzeLogs().catch(console.error);
