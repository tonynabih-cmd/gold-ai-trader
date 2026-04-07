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
  console.log('--- AUDITING APRIL 7th GOLDEN HOUR ---');
  
  const raw = await redis.lrange('trade_logs_list', 0, -1);
  const logs = raw.map(entry => typeof entry === 'string' ? JSON.parse(entry) : entry);
  
  const april7Logs = logs.filter(l => l.time.startsWith('2026-04-07'));
  
  // Golden Hour: 07:00 to 16:05 UTC
  const goldenHourLogs = april7Logs.filter(l => {
    const date = new Date(l.time);
    const hour = date.getUTCHours();
    const min = date.getUTCMinutes();
    return (hour >= 7 && hour < 16) || (hour === 16 && min <= 5);
  });

  console.log(`Found ${goldenHourLogs.length} logs during April 7th Golden Hour.`);

  const reasonCounts = {};
  goldenHourLogs.forEach(l => {
    const r = l.reason || l.dbgRejectReason || 'UNKNOWN';
    reasonCounts[r] = (reasonCounts[r] || 0) + 1;
  });

  console.log('\n--- Reason Breakdown ---');
  Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([reason, count]) => {
      console.log(`${count.toString().padEnd(4)} : ${reason}`);
    });

  const executed = goldenHourLogs.filter(l => l.tradeExecuted);
  console.log(`\nExecuted trades during Golden Hour: ${executed.length}`);

  if (executed.length === 0 && goldenHourLogs.length > 0) {
    console.log('\nLooking for specific signal generation failures:');
    const signals = goldenHourLogs.filter(l => l.signalDetected && l.signalDetected !== 'NONE');
    console.log(`Total potential signals detected: ${signals.length}`);
    
    if (signals.length > 0) {
      console.log('\nSample Signals rejection reasons:');
      signals.slice(0, 10).forEach(s => {
        console.log(`[${s.timeUAE}] Signal: ${s.signalDetected} | Reason: ${s.reason}`);
      });
    }
  }

  // Check last known indicators during golden hour
  if (goldenHourLogs.length > 0) {
    const lastGH = goldenHourLogs[goldenHourLogs.length - 1];
    console.log(`\nLast GH Indicators: EMA20: ${lastGH.ema20}, EMA50: ${lastGH.ema50}, Trend: ${lastGH.trend1h}, RSI: ${lastGH.rsi}`);
  }
}

main().catch(console.error);
