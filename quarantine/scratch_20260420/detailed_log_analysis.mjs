import fs from 'fs';
import { getLogs } from '../lib/logger.js';

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

async function analyze() {
  const logs = await getLogs();
  const today = new Date().toISOString().split('T')[0];
  const todayLogs = logs.filter(log => log.time.startsWith(today));

  console.log(`Analyzing ${todayLogs.length} logs for ${today}...\n`);

  const signals = todayLogs.filter(log => log.signalDetected !== 'NONE');
  
  if (signals.length === 0) {
    console.log('No BUY/SELL signals were even detected today.');
    
    // Analyze why no signals were detected by looking at the reject reasons for "No signal generated"
    const skipLogs = todayLogs.filter(log => log.reason === 'SKIP: No signal generated this cycle');
    const rejectReasons = {};
    skipLogs.forEach(l => {
      const r = l.dbgRejectReason || 'Unknown';
      rejectReasons[r] = (rejectReasons[r] || 0) + 1;
    });
    
    console.log('Reasons for no signal generation:');
    Object.entries(rejectReasons).sort((a,b) => b[1] - a[1]).forEach(([r, c]) => {
      console.log(`- ${r}: ${c} occurrences`);
    });
  } else {
    console.log(`Found ${signals.length} BUY/SELL signals that were NOT executed:\n`);
    
    signals.forEach((s, i) => {
      console.log(`${i+1}. [${s.timeUAE}] ${s.signalDetected} @ ${s.goldPrice || '??'}`);
      console.log(`   Reason: ${s.reason}`);
      if (s.dbgRejectReason) console.log(`   Internal Reject Reason: ${s.dbgRejectReason}`);
      console.log(`   Indicators: EMA20: ${s.ema20}, EMA50: ${s.ema50}, Slope: ${s.emaSlope}%`);
      console.log(`   Trade Specs: SL: ${s.stopLoss}, TP: ${s.takeProfit}, Dist: ${(Math.abs(s.entryPrice - s.stopLoss)).toFixed(2)}`);
      console.log('---');
    });
    
    const outcomeSummary = {};
    signals.forEach(s => {
      outcomeSummary[s.reason] = (outcomeSummary[s.reason] || 0) + 1;
    });
    
    console.log('\nFinal Signal Outcome Summary:');
    Object.entries(outcomeSummary).forEach(([reason, count]) => {
      console.log(`- ${reason}: ${count}`);
    });
  }
}

analyze().catch(console.error);
