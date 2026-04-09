import { getLogs } from './lib/logger.js';

async function checkGoldenHourLogs() {
  console.log('Fetching logs...');
  const logs = await getLogs();
  const today = new Date().toISOString().split('T')[0];
  
  // Filter for today AND after 07:00:00 UTC (11:00 AM UAE)
  const goldenHourLogs = logs.filter(log => {
      if (!log.time.startsWith(today)) return false;
      const timePart = log.time.split('T')[1];
      return timePart >= '07:00:00';
  });
  
  console.log(`Found ${goldenHourLogs.length} logs during Golden Hour today.`);
  
  if (goldenHourLogs.length === 0) {
    console.log('No logs found during Golden Hour yet.');
    return;
  }
  
  const reasons = {};
  goldenHourLogs.forEach(log => {
      const reason = log.reason || 'SUCCESS/UNKNOWN';
      reasons[reason] = (reasons[reason] || 0) + 1;
  });
  
  console.log('\nSummary for Golden Hour:');
  Object.entries(reasons).forEach(([reason, count]) => {
      console.log(`- ${reason}: ${count}`);
  });

  console.log('\nLast 15 Golden Hour logs:');
  goldenHourLogs.slice(-15).forEach(log => {
    console.log(`[${log.timeUAE}] Signal: ${log.signalDetected} | Executed: ${log.tradeExecuted} | Reason: ${log.reason}`);
    if (log.signalDetected !== 'NONE' && !log.tradeExecuted) {
        console.log(`  -> Signal Action: ${log.signalDetected} | Type: ${log.entryType} | Score: ${log.score}`);
        console.log(`  -> Debug Reject Reason: ${log.dbgRejectReason || 'None'}`);
        console.log(`  -> Pullback Reason: ${log.dbgPullbackReason || 'None'}`);
    }
  });
}

checkGoldenHourLogs().catch(console.error);
