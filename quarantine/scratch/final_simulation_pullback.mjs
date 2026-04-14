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
  
  const thresholds = [0.15, 0.20, 0.25, 0.30, 0.35];
  
  console.log('| Threshold | Trades | Win Rate (Cont) | False Signals | Notes |');
  console.log('|-----------|--------|-----------------|---------------|-------|');

  thresholds.forEach(th => {
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
              coolingDown = 5; // Prevent immediate re-triggering for simulation
              
              // Candle continuation check (next 3 cycles)
              let success = false;
              let failure = false;
              const action = log.dbgBuyCrossover || ema20 > log.dbgCurrE50 ? 'BUY' : 'SELL';
              
              for (let j = 1; j <= 3; j++) {
                  if (i + j >= logs.length) break;
                  const futureLog = logs[i+j];
                  const futurePrice = futureLog.goldPrice || futureLog.dbgCurrE20;
                  const move = action === 'BUY' ? futurePrice - price : price - futurePrice;
                  
                  if (move >= log.atr * 0.5) { success = true; break; }
                  if (move <= -log.atr * 0.5) { failure = true; break; }
              }
              
              if (success) wins++;
              else if (failure) falseS++;
              else {
                  // If neither, look at the very next candle color
                  const nextLog = i + 1 < logs.length ? logs[i+1] : null;
                  if (nextLog) {
                      const nextPrice = nextLog.goldPrice || nextLog.dbgCurrE20;
                      const cont = action === 'BUY' ? nextPrice > price : nextPrice < price;
                      if (cont) wins++; else falseS++;
                  }
              }
          }
      }

      const winRate = triggered > 0 ? (wins / triggered * 100).toFixed(1) : '0.0';
      const notes = th === 0.15 ? 'Current' : (th === 0.25 ? 'Recommended' : '');
      console.log(`| ${th.toFixed(2)}% | ${triggered} | ${winRate}% | ${falseS} | ${notes} |`);
  });
}

main().catch(console.error);
