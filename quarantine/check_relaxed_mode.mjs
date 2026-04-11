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
  const state = await redis.get('bot_state');
  if (!state) {
      console.error('No bot state found');
      return;
  }

  const lastTradeTs = state.lastOrderTimestamp || 0;
  const now = Date.now();
  const diffMs = now - lastTradeTs;
  const diffHours = diffMs / (1000 * 60 * 60);
  const isRelaxed = diffHours > 48;

  console.log('--- RELAXED MODE VERIFICATION ---');
  console.log(`Last Trade Time:   ${new Date(lastTradeTs).toISOString()}`);
  console.log(`Current Time:      ${new Date(now).toISOString()}`);
  console.log(`Time Since Trade:  ${diffHours.toFixed(1)} hours`);
  console.log(`Relaxed Mode:      ${isRelaxed ? 'ACTIVE ✅' : 'INACTIVE ❌'}`);
  
  // Strategy Values (assuming gold price of 24OO for example)
  const mockPrice = 2400;
  const mockAtr = 5;
  const isEuropean = true; // Most cycles analyzed were in EU session

  const normalSlope = isEuropean ? 0.08 : 0.10;
  const relaxedSlope = isEuropean ? 0.05 : 0.07;
  
  const normalDist = mockPrice * 0.0015;
  const relaxedDist = mockPrice * 0.0020;
  
  const normalMom = mockAtr * 0.06;
  const relaxedMom = mockAtr * 0.04;

  console.log('\n--- THRESHOLD COMPARISON (Example @ $2400 Price, 5 ATR) ---');
  console.log('Parameter          | Normal Value  | Relaxed Value | CURRENTLY ACTIVE');
  console.log('-------------------|---------------|---------------|------------------');
  console.log(`Slope Threshold   | ${normalSlope.toFixed(2)}%        | ${relaxedSlope.toFixed(2)}%        | ${isRelaxed ? relaxedSlope.toFixed(2) : normalSlope.toFixed(2)}%`);
  console.log(`Pullback Distance | $${normalDist.toFixed(2)}        | $${relaxedDist.toFixed(2)}        | $${isRelaxed ? relaxedDist.toFixed(2) : normalDist.toFixed(2)}`);
  console.log(`Momentum (ATR)    | ${normalMom.toFixed(2)}          | ${relaxedMom.toFixed(2)}          | ${isRelaxed ? relaxedMom.toFixed(2) : normalMom.toFixed(2)}`);

  console.log('\n--- ACTUAL REJECTION DATA FROM LATEST LOGS ---');
  const raw = await redis.lrange('trade_logs_list', -5, -1);
  const logs = raw.map(entry => typeof entry === 'string' ? JSON.parse(entry) : entry);
  
  logs.forEach(log => {
      const match = (log.dbgRejectReason || '').match(/threshold ([\d\.]+)/);
      if (match) {
          console.log(`Log (${log.timeUAE.split(',')[1].trim()}): Threshold observed in rejection: ${match[1]}`);
      }
  });
}

main().catch(console.error);
