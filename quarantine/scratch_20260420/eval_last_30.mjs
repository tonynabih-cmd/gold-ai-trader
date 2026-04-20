import fs from 'fs';
import { Redis } from '@upstash/redis';

try {
  const env = fs.readFileSync('.env.local', 'utf-8');
  env.split('\n').forEach(line => {
    if (line.trim() && !line.startsWith('#')) {
      const idx = line.indexOf('=');
      if (idx !== -1) {
        const k = line.substring(0, idx).trim();
        const v = line.substring(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (k) process.env[k] = v;
      }
    }
  });
} catch (e) {}

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const redis = new Redis({ url: KV_URL, token: KV_TOKEN });

async function analyze() {
  const botState = await redis.get('bot_state') || {};
  let recent = botState.recentOutcomes || [];
  
  console.log(`Total trades in bot state: ${recent.length}`);
  
  // Take the last 30 trades
  if (recent.length > 30) {
    recent = recent.slice(recent.length - 30);
  }

  let wins = 0;
  let losses = 0;
  let totalWinAmount = 0;
  let totalLossAmount = 0;

  const loseReasons = {};

  console.log('--- Last 30 Trades ---');
  recent.forEach((t, i) => {
    const pnl = parseFloat(t.pnl) || 0;
    const isWin = pnl > 0;
    if (isWin) {
      wins++;
      totalWinAmount += pnl;
    } else {
      losses++;
      totalLossAmount += Math.abs(pnl);
      let r = t.closeReason || 'Unknown/SL';
      loseReasons[r] = (loseReasons[r] || 0) + 1;
    }
    console.log(`${i+1}: ${t.dealId || t.ref} | PnL: ${pnl.toFixed(2)} | CloseReason: ${t.closeReason || 'N/A'}`);
  });

  const winRate = (wins / recent.length) * 100;
  const avgWin = wins > 0 ? totalWinAmount / wins : 0;
  const avgLoss = losses > 0 ? totalLossAmount / losses : 0;
  const expectancy = (winRate/100 * avgWin) - ((1 - winRate/100) * avgLoss);

  console.log('\n--- Metrics ---');
  console.log(`Win Rate: ${winRate.toFixed(2)}%`);
  console.log(`Avg Winner: ${avgWin.toFixed(2)}`);
  console.log(`Avg Loser: ${avgLoss.toFixed(2)}`);
  console.log(`Expectancy per trade: ${expectancy.toFixed(2)}`);

  console.log('\n--- Lose Reasons ---');
  console.log(loseReasons);
}

analyze().catch(console.error);
