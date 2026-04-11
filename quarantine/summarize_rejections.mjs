import { getLogs } from './lib/logger.js';

async function summary() {
  const logs = await getLogs();
  const today = '2026-04-07';
  const todayLogs = logs.filter(log => log.time.startsWith(today));
  
  const reasons = {};
  todayLogs.forEach(log => {
      const reason = log.reason || 'SUCCESS/UNKNOWN';
      reasons[reason] = (reasons[reason] || 0) + 1;
  });
  
  console.log(`Today's summary (${today}):`);
  Object.entries(reasons).forEach(([reason, count]) => {
      console.log(`- ${reason}: ${count}`);
  });
  
  console.log('\nTop 5 rejection reasons for signals:');
  const rejections = {};
  todayLogs.filter(l => l.signalDetected !== 'NONE').forEach(l => {
      const r = l.dbgRejectReason || 'No reject reason';
      rejections[r] = (rejections[r] || 0) + 1;
  });
  Object.entries(rejections).sort((a,b) => b[1] - a[1]).slice(0, 5).forEach(([r, c]) => {
      console.log(`- ${r}: ${c}`);
  });
}

summary().catch(console.error);
