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

  console.log(`Analyzing total ${todayLogs.length} logs for ${today}...\n`);

  const rejectReasons = {};
  todayLogs.forEach(l => {
    const r = l.dbgRejectReason || l.reason || 'None (Setup Found?)';
    rejectReasons[r] = (rejectReasons[r] || 0) + 1;
  });

  console.log('--- REJECTION REASON FREQUENCY ---');
  Object.entries(rejectReasons).sort((a,b) => b[1] - a[1]).forEach(([r, c]) => {
    console.log(`${c.toString().padEnd(5)} | ${r}`);
  });
  
  // Also check session filter from session.js perspective
  const sessionSkips = todayLogs.filter(l => l.reason === 'SKIP: outside trading session').length;
  console.log(`\nSession Skips (Total): ${sessionSkips}`);
  
  // Check typical indicators today
  const avgATR = todayLogs.reduce((sum, l) => sum + (l.atr || 0), 0) / todayLogs.length;
  const avgSlope = todayLogs.reduce((sum, l) => sum + Math.abs(l.emaSlope || 0), 0) / todayLogs.length;
  console.log(`\nMarket Context Today:`);
  console.log(`Avg ATR: ${avgATR.toFixed(2)}`);
  console.log(`Avg Abs Slope: ${avgSlope.toFixed(4)}%`);
}

analyze().catch(console.error);
