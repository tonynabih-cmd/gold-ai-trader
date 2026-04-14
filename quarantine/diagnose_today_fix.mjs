import fs from 'fs';
import path from 'path';
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
  console.log('--- DIAGNOSING RECENT TRADING ACTIVITY ---');
  
  const raw = await redis.lrange('trade_logs_list', 0, -1);
  const logs = raw.map(entry => typeof entry === 'string' ? JSON.parse(entry) : entry);
  
  // Get latest 50 logs regardless of "day" to see if anything is happening
  const latestLogs = logs.slice(-50).reverse();
  
  if (latestLogs.length === 0) {
    console.log('No logs found in Redis.');
    return;
  }

  console.log(`Found ${logs.length} total logs. Checking latest activity:\n`);

  latestLogs.forEach((l, index) => {
    // Only show the first 10, then summarize others
    if (index < 10) {
      console.log(`[${l.timeUAE || l.time}] Price: ${l.goldPrice || 'N/A'} | Signal: ${l.signalDetected || 'NONE'} | Score: ${l.dbgScore ?? 'N/A'}`);
      console.log(`      Reason: ${l.reason || 'N/A'}`);
      if (l.dbgRejectReason && l.dbgRejectReason !== 'N/A') {
          console.log(`      Reject Reason: ${l.dbgRejectReason}`);
      }
      if (l.dbgPullbackReason) {
          console.log(`      Pullback Reason: ${l.dbgPullbackReason}`);
      }
      console.log('-----------------------------------');
    }
  });

  // Check for any successful trades today (UAE or UTC)
  const todayUTC = new Date().toISOString().split('T')[0];
  const executedToday = logs.filter(l => l.tradeExecuted && l.time.startsWith(todayUTC));
  console.log(`\nExecuted trades today (UTC ${todayUTC}): ${executedToday.length}`);

  // Check unique RSI values in last 100 logs
  const recent100 = logs.slice(-100);
  const uniqueRSIs = new Set(recent100.map(l => l.rsi).filter(v => v !== null));
  console.log(`Unique RSI values in last 100 logs: ${uniqueRSIs.size}`);
  
  if (uniqueRSIs.size === 1) {
    console.log('⚠️ ALERT: RSI values seem stagnant. Indicators might not be updating correctly.');
  } else if (uniqueRSIs.size === 0) {
    console.log('⚠️ ALERT: No RSI values found in recent logs.');
  }

  // Check spread
  const lastLog = latestLogs[0];
  console.log(`Current (Last) Spread: $${lastLog.spread?.toFixed(2) || 'N/A'}`);
  if (lastLog.spread > 0.5) {
     console.log('⚠️ ALERT: High spread ($' + lastLog.spread.toFixed(2) + ') might be blocking trades (MAX_SPREAD is ' + (process.env.MAX_SPREAD || 'not set') + ').');
  }

  // Check if bot is disabled
  console.log(`BOT_ENABLED (Env): ${process.env.BOT_ENABLED}`);
  
  // Check trend
  console.log(`Trend (1h): ${lastLog.trend1h}`);
}

main().catch(console.error);
