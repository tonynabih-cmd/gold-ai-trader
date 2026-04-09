import fs from 'fs';
import path from 'path';
import { getLogs } from './lib/logger.js';

// Load .env.local manually for terminal execution
try {
  const envFile = fs.readFileSync('.env.local', 'utf8');
  const envLines = envFile.split('\n');
  envLines.forEach(line => {
    const match = line.match(/^([^#\s=]+)="?([^"\n\r]*)"?/);
    if (match) {
      process.env[match[1]] = match[2];
    }
  });
} catch (e) {
  // Silent fail if .env.local is missing (might be using system env)
}

async function checkLogs() {
  console.log('Fetching logs...');
  const logs = await getLogs();
  const today = new Date().toISOString().split('T')[0];
  
  const todayLogs = logs.filter(log => log.time.startsWith(today));
  
  console.log(`Found ${todayLogs.length} logs for today (${today}).`);
  
  if (todayLogs.length === 0) {
    console.log('No logs found for today.');
    return;
  }
  
  // Group logs by reason to see common skip/failure reasons
  const reasons = {};
  todayLogs.forEach(log => {
      const reason = log.reason || 'SUCCESS/UNKNOWN';
      reasons[reason] = (reasons[reason] || 0) + 1;
  });
  
  console.log('\nSummary by reason:');
  Object.entries(reasons).forEach(([reason, count]) => {
      console.log(`- ${reason}: ${count}`);
  });

  console.log('\nLast 10 logs:');
  todayLogs.slice(-10).forEach(log => {
    console.log(`[${log.timeUAE}] Signal: ${log.signalDetected} | Executed: ${log.tradeExecuted} | Reason: ${log.reason}`);
    if (log.reason && log.reason.includes('No signal generated')) {
        console.log(`  -> Reject Reason: ${log.dbgRejectReason || 'None'}`);
        if (log.dbgPullbackReason) console.log(`  -> Pullback Detail: ${log.dbgPullbackReason}`);
    }
  });
}

checkLogs().catch(console.error);
