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

  let output = `Analyzing ${goldenHourLogs.length} Golden Hour logs for April 7th:\n\n`;

  const grouped = {};
  goldenHourLogs.forEach(l => {
    const key = `[R:${l.reason || 'none'}] [D:${l.dbgRejectReason || 'none'}] [S:${l.signalDetected || 'none'}]`;
    grouped[key] = (grouped[key] || 0) + 1;
  });

  Object.entries(grouped)
    .sort((a,b) => b[1] - a[1])
    .forEach(([key, count]) => {
      output += `${count.toString().padEnd(5)} : ${key}\n`;
    });
    
  fs.writeFileSync('audit_results.txt', output);
  console.log('Results written to audit_results.txt');
}

main().catch(console.error);
