import fs from 'fs';
import { Redis } from '@upstash/redis';

// Load .env.local
try {
  const envFile = fs.readFileSync('c:/Users/Antho/Downloads/gold-trader/.env.local', 'utf8');
  const envLines = envFile.split('\n');
  envLines.forEach(line => {
    const match = line.match(/^([^#\s=]+)="?([^"\n\r]*)"?/);
    if (match) {
      process.env[match[1]] = match[2];
    }
  });
} catch (e) {}

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  const raw = await redis.lrange('trade_logs_list', -200, -1);
  const logs = raw.map(entry => typeof entry === 'string' ? JSON.parse(entry) : entry);
  
  const th = 0.30;
  let triggered = 0;
  let wins = 0;
  let falseS = 0;
  let coolingDown = 0;

  for (let i = 0; i < logs.length; i++) {
      if (coolingDown > 0) { coolingDown--; continue; }
      
      const log = logs[i];
      const price = log.goldPrice || log.dbgCurrE20;
      const ema20 = log.dbgCurrE20;
      const dist = Math.abs(price - ema20);
      const limit = ema20 * (th / 100);
      
      const wasRejectedDist = (log.dbgRejectReason || '').includes('pullback: price not close enough');
      
      if (wasRejectedDist && dist <= limit) {
          triggered++;
          coolingDown = 10; // More realistic cooldown
          
          // Candle continuation check (next 5 cycles)
          const horizon = 5;
          const futureIdx = Math.min(i + horizon, logs.length - 1);
          const futurePrice = logs[futureIdx].goldPrice || logs[futureIdx].dbgCurrE20;
          
          const action = log.dbgBuyCrossover || ema20 > log.dbgCurrE50 ? 'BUY' : 'SELL';
          const success = action === 'BUY' ? futurePrice > price : futurePrice < price;
          
          if (success) wins++; else falseS++;
      }
  }

  console.log(`Results for 0.30%:`);
  console.log(`Triggered: ${triggered}`);
  console.log(`Wins (Continues after 5m): ${wins}`);
  console.log(`False Signals: ${falseS}`);
  console.log(`Win Rate: ${(wins / triggered * 100).toFixed(1)}%`);
}

main().catch(console.error);
