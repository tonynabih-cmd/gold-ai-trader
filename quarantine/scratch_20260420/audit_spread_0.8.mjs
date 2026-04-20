import fs from 'fs';
import { getLogs } from '../lib/logger.js';
import { Redis } from '@upstash/redis';

// Load .env.local 
try {
  const envFile = fs.readFileSync('.env.local', 'utf8');
  const envLines = envFile.split('\n');
  envLines.forEach(line => {
    const match = line.match(/^([^#\s=]+)="?([^"\n\r]*)"?/);
    if (match) {
      process.env[match[1]] = match[2];
    }
  });
} catch (e) {}

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function runAudit() {
  const logs = await getLogs();
  const state = await redis.get('bot_state');
  
  console.log('\n--- LATEST 20 LOG ENTRIES ---');
  logs.slice(-20).forEach(l => console.log(`[${l.timeUAE}] ${l.signalDetected || 'NONE'} | ${l.reason || l.dbgRejectReason || 'No reason'} | Spread: ${l.spread}`));
  
  const filledTrades = logs.filter(l => l.tradeExecuted === true);
  console.log(`TOTAL FILLED TRADES: ${filledTrades.length}`);
  
  const recentFilled = filledTrades.slice(-20);
  console.log('\n--- LAST 20 FILLED TRADES ---');
  recentFilled.forEach(l => {
    console.log(`[${l.timeUAE}] Spread: ${l.spread} | Action: ${l.signalDetected} | dealId: ${l.dealReference || l.tradeId}`);
  });

  const highSpreadSkips = logs.filter(l => l.reason === 'SKIP: high spread' || (l.dbgRejectReason && l.dbgRejectReason.includes('high spread')));
  console.log('\n--- HIGH SPREAD SKIPS (ANY) ---');
  highSpreadSkips.slice(-10).forEach(l => {
     console.log(`[${l.timeUAE}] Spread: ${l.spread}`);
  });

  // Task 1: Count how many trades were previously spread-blocked but are now filled 
  // (i.e. filled with spread > 0.5)
  const filledPreviouslyBlocked = filledTrades.filter(l => l.spread > 0.501);
  console.log(`\n1. Trades filled with spread > 0.5: ${filledPreviouslyBlocked.length}`);

  // Task 2: Profitability of trades with spread 0.6-0.8
  let pnlTotal = 0;
  let count = 0;
  filledPreviouslyBlocked.forEach(l => {
      const outcome = (state.recentOutcomes || []).find(o => o.dealId === (l.dealReference || l.tradeId));
      if (outcome) {
          pnlTotal += outcome.pnl;
          count++;
          console.log(`   - Trade ${outcome.dealId} (Spread ${l.spread}): PnL ${outcome.pnl}`);
      }
  });
  console.log(`\n2. Net PnL of high-spread trades: ${pnlTotal.toFixed(2)} (${count} trades)`);

  // Task 3: Portfolio risk rejections for valid signals
  const portfolioRejections = logs.filter(l => (l.reason || l.dbgRejectReason || '').includes('Portfolio worst-case risk'));
  console.log(`\n3. Portfolio Risk Rejections: ${portfolioRejections.length}`);

  // Task 4: Biggest remaining blocker
  const last50Rejections = logs.filter(l => l.tradeExecuted === false).slice(-50);
  const blockerFreq = {};
  last50Rejections.forEach(l => {
      const r = l.reason || l.dbgRejectReason || 'Unknown';
      blockerFreq[r] = (blockerFreq[r] || 0) + 1;
  });
  console.log(`\n4. Top blockers (last 50):`);
  Object.entries(blockerFreq).sort((a,b) => b[1] - a[1]).forEach(([r, c]) => {
      console.log(`   - ${c}: ${r}`);
  });
}

runAudit().catch(console.error);
