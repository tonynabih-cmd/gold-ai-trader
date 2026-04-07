import fs from 'fs';
import { Redis } from '@upstash/redis';

// Load .env.local
const envFile = fs.readFileSync('.env.local', 'utf8');
const envLines = envFile.split('\n');
envLines.forEach(line => {
  const match = line.match(/^([^#\s=]+)="?([^"\n\r]*)"?/);
  if (match) {
    process.env[match[1]] = match[2];
  }
});

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  const raw = await redis.lrange('trade_logs_list', 0, -1);
  const logs = raw.map(entry => typeof entry === 'string' ? JSON.parse(entry) : entry);
  
  const april7Logs = logs.filter(l => l.time.startsWith('2026-04-07'));
  const goldenHourLogs = april7Logs.filter(l => {
    const date = new Date(l.time);
    const hour = date.getUTCHours();
    return (hour >= 7 && hour < 16);
  });

  console.log(`Analyzing ${goldenHourLogs.length} Golden Hour logs for April 7th:`);

  const reasonsFull = goldenHourLogs.map(l => ({
    reason: l.reason,
    dbgRejectReason: l.dbgRejectReason,
    signalDetected: l.signalDetected,
    timeUAE: l.timeUAE
  }));

  const grouped = {};
  reasonsFull.forEach(r => {
    const key = `[R:${r.reason || 'none'}] [D:${r.dbgRejectReason || 'none'}] [S:${r.signalDetected || 'none'}]`;
    grouped[key] = (grouped[key] || 0) + 1;
  });

  Object.entries(grouped)
    .sort((a,b) => b[1] - a[1])
    .forEach(([key, count]) => {
      console.log(`${count.toString().padEnd(5)} : ${key}`);
    });
    
  // Check if there was any CRITICAL failure or BROKER_STATS_UNAVAILABLE
  const criticals = april7Logs.filter(l => l.reason && l.reason.includes('FAILURE'));
  if (criticals.length > 0) {
      console.log('\nCRITICAL ERRORS FOUND on April 7th:');
      criticals.forEach(c => console.log(`[${c.timeUAE}] ${c.reason}`));
  }
}

main().catch(console.error);
