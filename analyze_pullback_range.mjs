import fs from 'fs';
import { Redis } from '@upstash/redis';

// Load .env.local for credentials
try {
  const envFile = fs.readFileSync('./.env.local', 'utf8');
  const envLines = envFile.split('\n');
  envLines.forEach(line => {
    const match = line.match(/^([^#\s=]+)="?([^"\n\r]*)"?/);
    if (match) {
      process.env[match[1]] = match[2];
    }
  });
} catch (e) {
    console.error('Error loading .env.local:', e.message);
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  const raw = await redis.lrange('trade_logs_list', -200, -1);
  const logs = raw.map(entry => typeof entry === 'string' ? JSON.parse(entry) : entry);

  const candidateSetups = [];
  
  logs.forEach(log => {
      const reason = log.dbgRejectReason || '';
      if (reason.startsWith('pullback: price not close enough to EMA20')) {
          const emaSep = log.dbgEmaSeparation || 0;
          const atr = log.atr || 0;
          const slope = Math.abs(log.emaSlope || 0);
          
          const trendValid = emaSep > atr * 0.35;
          const momentumValid = slope >= 0.05;
          
          if (trendValid && momentumValid) {
              candidateSetups.push({
                  time: new Date(log.time).getTime(),
                  price: log.goldPrice,
                  ema20: log.ema20 || log.dbgCurrE20,
                  distance: log.dbgDistToEMA20,
                  pct: log.dbgDistToEMA20 / (log.ema20 || log.dbgCurrE20)
              });
          }
      }
  });

  // Group into unique setups (consecutive or near-simultaneous cycles for the same move)
  const uniqueOpportunities = [];
  if (candidateSetups.length > 0) {
      let currentGroup = [candidateSetups[0]];
      for (let i = 1; i < candidateSetups.length; i++) {
          const diff = candidateSetups[i].time - candidateSetups[i-1].time;
          // If within 5 minutes, consider it the same setup
          if (diff < 5 * 60 * 1000) {
              currentGroup.push(candidateSetups[i]);
          } else {
              uniqueOpportunities.push(currentGroup);
              currentGroup = [candidateSetups[i]];
          }
      }
      uniqueOpportunities.push(currentGroup);
  }

  // For each unique setup, find the MINIMUM distance (the closest it got to EMA20)
  // This is the "best" percentage that would have triggered it.
  const minPcts = uniqueOpportunities.map(group => {
      const best = group.reduce((prev, curr) => (curr.pct < prev.pct ? curr : prev));
      return best.pct;
  }).sort((a,b) => a - b);

  console.log(`Found ${uniqueOpportunities.length} unique trade opportunities that were blocked by pullback distance.\n`);

  // We want 10-20 trades in 200 cycles.
  // Let's see how many trades we currently get.
  const alreadyExecuted = logs.filter(l => l.tradeExecuted).length;
  console.log(`Currently executed trades in sample: ${alreadyExecuted}`);
  
  const targetNewTrades = 15 - alreadyExecuted; // Aiming for 15 total trades
  console.log(`Targeting approx ${targetNewTrades} additional trades from the blocked setups...\n`);

  if (minPcts.length === 0) {
      console.log('No blocked setups found to analyze.');
      return;
  }

  // Calculate the threshold that would include 'targetNewTrades' setups
  const index = Math.min(minPcts.length - 1, Math.max(0, targetNewTrades - 1));
  const optimalPct = minPcts[index];
  
  console.log('--- PERCENTAGE DISTRIBUTION (MINIMUM PCT PER SETUP) ---');
  minPcts.forEach((p, i) => {
      console.log(`Setup ${(i+1).toString().padStart(2)}: ${(p * 100).toFixed(3)}%`);
  });

  console.log('\n--- DATA-DRIVEN ANALYSIS ---');
  console.log(`Optimal Threshold Found:   ${(optimalPct * 100).toFixed(3)}%`);
  
  const currentLevel = 0.0020; // 0.20%
  const currentCount = minPcts.filter(p => p <= currentLevel).length;
  const optimalCount = minPcts.filter(p => p <= optimalPct).length;

  console.log(`\nComparison with 0.20%:`);
  console.log(`- 0.20% allows ${currentCount} out of ${uniqueOpportunities.length} blocked setups.`);
  console.log(`- ${(optimalPct * 100).toFixed(3)}% allows ${optimalCount} out of ${uniqueOpportunities.length} blocked setups.`);
  
  console.log(`\nRecommendation: Set pullback percentage to ${(optimalPct * 100).toFixed(2)}%`);
  console.log(`This would yield approx ${alreadyExecuted + optimalCount} total signals per 200 cycles.`);
}

main().catch(console.error);
