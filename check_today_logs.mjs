import { getLogs } from './lib/logger.js';
// Remove dotenv since we use node --env-file

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
    if (log.signalDetected !== 'NONE' && !log.tradeExecuted) {
        console.log(`  -> Debug Reject Reason: ${log.dbgRejectReason || 'None'}`);
        console.log(`  -> Pullback Reason: ${log.dbgPullbackReason || 'None'}`);
    }
  });
}

checkLogs().catch(console.error);
