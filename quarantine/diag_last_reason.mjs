import { getLogs } from './lib/logger.js';

async function main() {
  const logs = await getLogs();
  const today = new Date().toISOString().split('T')[0];
  const todayLogs = logs.filter(l => l.time.startsWith(today));
  
  console.log(`--- LATEST 10 LOGS FOR ${today} ---`);
  const latest = todayLogs.slice(-10).reverse();
  
  if (latest.length === 0) {
    console.log('No logs found for today.');
    return;
  }

  latest.forEach(l => {
    const time = l.timeUAE || l.time;
    const signal = l.signalDetected || 'NONE';
    const reason = l.reason || 'N/A';
    const reject = l.dbgRejectReason || 'N/A';
    const score = l.dbgScore !== null ? l.dbgScore : 'N/A';
    const price = l.goldPrice || 'N/A';
    
    console.log(`[${time}] Price: ${price} | Signal: ${signal} | Score: ${score}`);
    console.log(`      Reason: ${reason}`);
    if (reject !== 'N/A') {
      console.log(`      Reject Reason: ${reject}`);
    }
    console.log('-----------------------------------');
  });
}

main().catch(console.error);
