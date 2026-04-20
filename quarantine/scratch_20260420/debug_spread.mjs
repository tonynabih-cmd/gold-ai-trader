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

async function runAudit() {
  const logs = await getLogs();
  
  const highSpreadSkips = logs.filter(l => l.reason === 'SKIP: high spread' || (l.dbgRejectReason && l.dbgRejectReason.includes('high spread')));
  
  console.log('--- HIGH SPREAD SKIPS ANALYSIS ---');
  highSpreadSkips.slice(-10).forEach(l => {
    console.log(`[${l.timeUAE}] Spread: ${l.spread}, MAX_SPREAD (likely): ${l.dbgRejectReason || '0.5'}`);
  });
  
  const allRecentSignals = logs.filter(l => l.signalDetected === 'BUY' || l.signalDetected === 'SELL').slice(-20);
  console.log('\n--- ALL RECENT SIGNALS ---');
  allRecentSignals.forEach(l => {
    console.log(`[${l.timeUAE}] ${l.signalDetected} | spread: ${l.spread} | executed: ${l.tradeExecuted} | reason: ${l.reason || l.dbgRejectReason}`);
  });
}

runAudit().catch(console.error);
