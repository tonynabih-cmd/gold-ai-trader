
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  console.log('Fetching logs from trade_logs_list...');
  const raw = await redis.lrange('trade_logs_list', 0, -1);
  const logs = raw.map(entry => typeof entry === 'string' ? JSON.parse(entry) : entry);
  
  const today = new Date().toISOString().slice(0, 10);
  const todayLogs = logs.filter(log => log.time.startsWith(today));
  
  console.log(`Found ${todayLogs.length} logs for today (${today}).`);
  
  const candidateSignals = todayLogs.filter(log => log.signalDetected !== 'NONE');
  
  if (candidateSignals.length === 0) {
    console.log('No BUY/SELL signals detected by the strategy today.');
    
    // Look at why strategy might be rejecting everything
    const lastLogs = todayLogs.slice(-5);
    console.log('\nLast 5 status checks (checking for near misses):');
    lastLogs.forEach(l => {
        console.log(`[${l.timeUAE}] EMA Sep: ${l.dbgEmaSeparation?.toFixed(2)} | Dist to EMA20: ${l.dbgDistToEMA20?.toFixed(2)} | Reject: ${l.dbgRejectReason || 'No Reason'}`);
    });
    return;
  }
  
  console.log(`\n--- ${candidateSignals.length} RECENT SIGNALS ---`);
  candidateSignals.slice(-10).forEach(log => {
    console.log(`[${log.timeUAE}] Action: ${log.signalDetected} | Executed: ${log.tradeExecuted}`);
    console.log(`      └─ Risk Reason: ${log.reason || 'APPROVED'}`);
    if (!log.tradeExecuted) {
        console.log(`      └─ Strategy Rejection Detail: ${log.dbgRejectReason || 'N/A'}`);
        if (log.dbgPullbackReason) console.log(`      └─ Pullback Info: ${log.dbgPullbackReason}`);
        console.log(`      └─ Score: ${log.dbgScore || 'N/A'}`);
    }
  });
}

main().catch(console.error);
