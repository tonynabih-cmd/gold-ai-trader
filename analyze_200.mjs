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
  
  console.log(`Analyzing latest ${logs.length} cycles...`);
  console.log('--------------------------------------------------------------------------------');
  console.log('TIME (UAE)           | SIGNAL | EXEC? | REJECT REASON');
  console.log('--------------------------------------------------------------------------------');

  const rejections = {};
  let validSignals = 0;
  let total = logs.length;

  const perCycle = [];
  logs.forEach(log => {
      let signal = log.signalDetected !== 'NONE' ? log.signalDetected : '—';
      let exec = log.tradeExecuted ? 'YES' : 'NO';
      let rejectReason = log.dbgRejectReason || log.reason || 'No setup';
      
      if (log.tradeExecuted) {
          validSignals++;
      } else if (log.signalDetected !== 'NONE') {
          rejectReason = `RISK: ${log.reason || 'Unknown risk block'}`;
      }
      perCycle.push({ time: log.timeUAE || log.time, signal, exec, rejectReason });

      let category = 'Unknown';
      if (rejectReason.includes('pullback')) category = 'pullback';
      else if (rejectReason.includes('trend')) category = 'trend';
      else if (rejectReason.includes('momentum')) category = 'momentum';
      else if (rejectReason.includes('RSI')) category = 'RSI Filter';
      else if (rejectReason.includes('slope')) category = 'EMA Slope';
      else if (rejectReason.includes('score')) category = 'Score filter';
      else if (rejectReason.includes('crossover')) category = 'crossover wait/side';
      else if (rejectReason.includes('Outside Golden Hour')) category = 'Time window';
      else if (rejectReason.includes('Duplicate candle')) category = 'Duplicate candle';
      else if (rejectReason.includes('No setup')) category = 'No setup found';
      else if (rejectReason.includes('RISK')) category = 'Risk management';
      
      rejections[category] = (rejections[category] || 0) + 1;
  });

  // Print only a summary of unique reasons to avoid terminal clutter
  const reasonCounts = {};
  logs.forEach(l => {
      const r = l.dbgRejectReason || l.reason || 'No setup';
      reasonCounts[r] = (reasonCounts[r] || 0) + 1;
  });

  console.log('--------------------------------------------------------------------------------');
  console.log(`Total Cycles Analyzed: ${total}`);
  console.log(`Number of Valid Signals (Executed): ${validSignals}`);
  
  const sortedCategories = Object.entries(rejections).sort((a, b) => b[1] - a[1]);
  if (sortedCategories.length > 0) {
      const [topCat, count] = sortedCategories[0];
      const pct = (count / total * 100).toFixed(1);
      console.log(`Most Common Failing Category: ${topCat} (${pct}% of cycles)`);
  }

  console.log('\n--- DETAILED REJECTION REASONS ---');
  Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([reason, count]) => {
      console.log(`${count.toString().padStart(4)} | ${reason}`);
    });
}

main().catch(console.error);
