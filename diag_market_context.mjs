
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  const raw = await redis.lrange('trade_logs_list', 0, -1);
  const logs = raw.map(entry => typeof entry === 'string' ? JSON.parse(entry) : entry);
  const lastLog = logs[logs.length - 1];

  console.log('--- RECENT MARKET CONTEXT ---');
  console.log(`Time (UAE):    ${lastLog.timeUAE}`);
  console.log(`Gold Price:    $${lastLog.goldPrice?.toFixed(2)}`);
  console.log(`EMA20 (5m):    $${lastLog.ema20?.toFixed(2)}`);
  console.log(`EMA50 (5m):    $${lastLog.ema50?.toFixed(2)}`);
  console.log(`EMA Separation: $${lastLog.dbgEmaSeparation?.toFixed(2)}`);
  console.log(`ATR (5m):      $${lastLog.atr?.toFixed(2)}`);
  console.log(`RSI (5m):      ${lastLog.rsi?.toFixed(1)}`);
  console.log(`Trend (1h):    ${lastLog.trend1h}`);
  console.log(`Spread:        $${lastLog.spread?.toFixed(2)}`);
  
  if (lastLog.dbgRejectReason) {
      console.log(`\nLast Strategy Decision:`);
      console.log(`Action:        ${lastLog.dbgAction || 'NONE'}`);
      console.log(`Reject Reason: ${lastLog.dbgRejectReason}`);
      if (lastLog.dbgPullbackReason) console.log(`Pullback Detail: ${lastLog.dbgPullbackReason}`);
  }
}

main().catch(console.error);
