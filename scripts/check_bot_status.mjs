import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  try {
    const raw = await redis.lrange('trade_logs_list', -100, -1);
    if (!Array.isArray(raw)) {
      console.log('No logs found.');
      return;
    }
    
    const logs = raw.map(entry => {
      if (typeof entry === 'string') {
        try { return JSON.parse(entry); } catch { return entry; }
      }
      return entry; 
    }).filter(log => !log.reason?.includes('Duplicate candle'));

    console.log(`--- RECENT RELEVANT LOGS (Excluding Duplicates, Found ${logs.length}) ---`);
    logs.slice(-10).forEach((log, i) => {
      console.log(`[${log.timeUAE}]`);
      console.log(`  Signal Detected: ${log.signalDetected}`);
      console.log(`  Executed:        ${log.tradeExecuted}`);
      console.log(`  Reason/Reject:   ${log.reason || log.dbgRejectReason || 'Success'}`);
      if (log.dbgScore !== undefined && log.dbgScore !== null) {
          console.log(`  Score:           ${log.dbgScore} (Required: 2)`);
          console.log(`  EMA Slope:       ${log.emaSlope?.toFixed(4)}%`);
          console.log(`  RSI:             ${log.rsi?.toFixed(1)}`);
          console.log(`  ATR:             ${log.atr?.toFixed(2)}`);
          console.log(`  1m Momentum:     ${log.dbg1mMomentumNet?.toFixed(4)}`);
      }
      if (log.dbgPullbackReason) {
          console.log(`  Pullback Info:   ${log.dbgPullbackReason}`);
      }
      console.log('-------------------------------------------');
    });

    // Also check state
    const stateRaw = await redis.get('bot_state');
    console.log('\n--- CURRENT BOT STATE ---');
    console.log(JSON.stringify(stateRaw, null, 2));

  } catch (err) {
    console.error('Error fetching logs:', err.message);
  }
}

main();
