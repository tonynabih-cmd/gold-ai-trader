import fs from 'fs';
import { Redis } from '@upstash/redis';

const envContent = fs.readFileSync('.env.local', 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const [key, ...valueParts] = line.split('=');
  if (key) env[key.trim()] = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
});

const redis = new Redis({ url: env.KV_REST_API_URL, token: env.KV_REST_API_TOKEN });

async function check() {
  const logs = await redis.lrange('trade_logs_list', -50, -1);
  const parsedLogs = logs.map(l => typeof l === 'string' ? JSON.parse(l) : l);
  console.log(JSON.stringify(parsedLogs, null, 2));
}

check().catch(console.error);
