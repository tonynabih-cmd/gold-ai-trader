import fs from 'fs';
import { Redis } from '@upstash/redis';

async function main() {
  try {
    const envFile = fs.readFileSync('.env.local', 'utf-8');
    envFile.split('\n').forEach(line => {
      const parts = line.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const val = parts.slice(1).join('=').trim().replace(/"/g, '').replace(/'/g, '');
        if (key) process.env[key] = val;
      }
    });

    const redis = new Redis({
      url:   process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });

    console.log('--- FINDING EXECUTED TRADES TODAY ---');
    const raw = await redis.lrange('trade_logs_list', -500, -1); 
    const logs = Array.isArray(raw) ? raw.map(entry => {
        if (typeof entry === 'string') {
            try { return JSON.parse(entry); } catch (e) { return null; }
        }
        return entry;
    }).filter(l => l !== null) : [];

    const executed = logs.filter(l => l.tradeExecuted);
    executed.forEach(l => {
        console.log(`[EXEC] ${new Date(l.time).toISOString()} | Signal: ${l.signalDetected} (${l.entryType}) | ID: ${l.tradeId}`);
    });

    console.log('\n--- SCANNING FOR RESET DETAILS ---');
    let lastVal = null;
    logs.forEach(log => {
      if (lastVal === 2 && log.dailyTrades === 0) {
          console.log(`[RESET DETECTED] @ ${new Date(log.time).toISOString()}`);
          console.log(`  Reason: ${log.reason}`);
          console.log(`  State: dailyTrades=${log.dailyTrades}, dailyLoss=${log.dailyLoss}`);
      }
      lastVal = log.dailyTrades;
    });

  } catch (err) {
    console.error('Error main:', err.message);
  }
}

main();
