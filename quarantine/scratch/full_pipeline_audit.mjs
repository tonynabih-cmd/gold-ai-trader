import fs from 'fs';
import { getLogs } from '../lib/logger.js';

// Load .env.local
try {
  const envFile = fs.readFileSync('.env.local', 'utf8');
  envFile.split('\n').forEach(line => {
    const match = line.match(/^([^#\s=]+)="?([^"\n\r]*)"?/);
    if (match) process.env[match[1]] = match[2];
  });
} catch (e) {}

async function audit() {
  const logs = await getLogs();
  
  // Get ALL logs (not just today) to find the last trade
  const allLogs = logs.sort((a, b) => new Date(a.time) - new Date(b.time));
  
  // Find last executed trade ever
  const lastTrade = [...allLogs].reverse().find(l => l.tradeExecuted === true);
  if (lastTrade) {
    console.log(`\n=== LAST EXECUTED TRADE ===`);
    console.log(`  Time: ${lastTrade.timeUAE || lastTrade.time}`);
    console.log(`  Signal: ${JSON.stringify(lastTrade.signal || lastTrade.signalDetected)}`);
    const hoursAgo = (Date.now() - new Date(lastTrade.time).getTime()) / (1000 * 60 * 60);
    console.log(`  Hours ago: ${hoursAgo.toFixed(1)}`);
  } else {
    console.log(`\n⚠️  NO EXECUTED TRADES FOUND IN ALL LOGS (${allLogs.length} total)`);
  }

  // Focus on today's cycles within trading hours (7-18 UTC)
  const today = new Date().toISOString().split('T')[0];
  const todayLogs = allLogs.filter(l => l.time?.startsWith(today));
  
  // Only look at non-duplicate processing cycles
  const realCycles = todayLogs.filter(l => 
    !l.reason?.includes('Duplicate candle') &&
    !l.reason?.includes('Waiting for candle settlement')
  );

  console.log(`\n=== TODAY'S REAL CYCLES: ${realCycles.length} ===`);
  
  // Categorize EVERY rejection
  const buckets = {};
  for (const log of realCycles) {
    const reason = log.reason || (log.tradeExecuted ? 'TRADE_EXECUTED' : 'UNKNOWN');
    // Normalize reason (strip variable parts)
    let key = reason;
    key = key.replace(/\(latest: \d+, lastProcessed: \d+\)/, '(...)');
    key = key.replace(/\(slope: [^)]+\)/, '(slope: ...)');
    key = key.replace(/\(ATR [^)]+\)/, '(ATR ...)');
    key = key.replace(/\(\d+\/\d+ minimum candles needed\)/, '(candles ...)');
    key = key.replace(/\(\d+\.\d+s since close[^)]*\)/, '(timing ...)');
    
    if (!buckets[key]) buckets[key] = { count: 0, examples: [] };
    buckets[key].count++;
    if (buckets[key].examples.length < 2) {
      buckets[key].examples.push({
        time: log.timeUAE,
        dbgReject: log.dbgRejectReason || log.signalDebug?.dbgRejectReason,
        dbgPullback: log.dbgPullbackReason || log.signalDebug?.dbgPullbackReason,
      });
    }
  }

  const sorted = Object.entries(buckets).sort((a, b) => b[1].count - a[1].count);
  console.log('\n--- ALL REJECTION REASONS (sorted by frequency) ---');
  for (const [reason, data] of sorted) {
    console.log(`\n  [${data.count}x] ${reason}`);
    for (const ex of data.examples) {
      if (ex.dbgReject) console.log(`       → Strategy reject: ${ex.dbgReject}`);
      if (ex.dbgPullback) console.log(`       → Pullback detail: ${ex.dbgPullback}`);
    }
  }

  // Check for conflicting filters between strategy.js and risk.js
  console.log('\n\n=== FILTER CONFLICT CHECK ===');
  
  // Check: risk.js sideways (ATR*0.4) vs strategy.js trend establishment (ATR*0.20 relaxed)
  console.log(`\n  risk.js sideways: EMA sep < ATR * 0.4 → SKIP`);
  console.log(`  strategy.js trend (relaxed): EMA sep > ATR * 0.20 → proceed`);
  console.log(`  ⚠️  CONFLICT: Signal can pass strategy (sep > ATR*0.20) but get blocked by risk (sep < ATR*0.40)`);
  console.log(`     → Range ATR*0.20 to ATR*0.40 is a dead zone where strategy says GO but risk says NO`);

  // Check: risk.js ATR minimum (1.2) 
  console.log(`\n  risk.js min ATR: ATR < 1.2 → SKIP`);
  console.log(`  indicators.js min ATR: ATR < 1.2 → SKIP (duplicate)`);
  
  // Show current env flags
  console.log('\n\n=== ENVIRONMENT FLAGS ===');
  console.log(`  BOT_ENABLED: ${process.env.BOT_ENABLED}`);
  console.log(`  CAPITAL_ENV: ${process.env.CAPITAL_ENV}`);
  console.log(`  LIVE_TRADING_MODE: ${process.env.LIVE_TRADING_MODE}`);
  console.log(`  MAX_SPREAD: ${process.env.MAX_SPREAD || 'unset (default 0.5)'}`);
  console.log(`  FORCE_TRADE: ${process.env.FORCE_TRADE || 'unset'}`);
  console.log(`  DEBUG_STRATEGY: ${process.env.DEBUG_STRATEGY || 'unset'}`);

  // Check the logs for the RISK_BLOCKED ones specifically
  console.log('\n\n=== RISK-BLOCKED SIGNALS (signal existed but risk rejected) ===');
  const riskBlocked = realCycles.filter(l => {
    const r = l.reason || '';
    return r.startsWith('SKIP:') && 
           !r.includes('No signal') &&
           !r.includes('Duplicate candle') &&
           !r.includes('outside trading session') &&
           !r.includes('Weekend') &&
           !r.includes('Friday close') &&
           !r.includes('Weak trend') &&
           !r.includes('Market data error') &&
           !r.includes('settlement') &&
           !r.includes('BROKER');
  });
  
  for (const log of riskBlocked) {
    console.log(`  [${log.timeUAE}] ${log.reason}`);
    if (log.signalDetected && log.signalDetected !== 'NONE') {
      console.log(`    → Had signal: ${log.signalDetected}`);
    }
  }
}

audit().catch(console.error);
