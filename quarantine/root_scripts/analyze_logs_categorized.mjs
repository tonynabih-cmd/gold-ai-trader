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
  const strategyReasons = {};
  const riskReasons = {};
  const systemSkips = {};

  for (const logStr of logs) {
    const log = typeof logStr === 'string' ? JSON.parse(logStr) : logStr;
    const reason = (log.reason || log.dbgRejectReason || 'UNKNOWN').trim();
    
    if (reason.includes('Stale market data') || reason.includes('Duplicate candle') || reason.includes('settlement')) {
      systemSkips[reason] = (systemSkips[reason] || 0) + 1;
    } else if (reason.startsWith('SKIP: high spread') || reason.startsWith('SKIP: Max 2 positions') || reason.startsWith('STOP: daily loss') || reason.includes('Insufficient margin')) {
      riskReasons[reason] = (riskReasons[reason] || 0) + 1;
    } else {
      strategyReasons[reason] = (strategyReasons[reason] || 0) + 1;
    }
  }

  console.log('\n--- STRATEGY BLOCKERS (Actual Rejections) ---');
  Object.entries(strategyReasons).sort((a,b) => b[1]-a[1]).forEach(([r,c]) => console.log(`${c.toString().padEnd(5)} | ${r}`));

  console.log('\n--- RISK BLOCKERS ---');
  Object.entries(riskReasons).sort((a,b) => b[1]-a[1]).forEach(([r,c]) => console.log(`${c.toString().padEnd(5)} | ${r}`));

  const totalStrategy = Object.values(strategyReasons).reduce((a,b)=>a+b, 0);
  const totalSystem = Object.values(systemSkips).reduce((a,b)=>a+b, 0);
  console.log(`\nTotals: Strategy=${totalStrategy}, System=${totalSystem}`);
}
analyzeLogs().catch(console.error);
