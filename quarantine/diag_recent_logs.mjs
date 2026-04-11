
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  const dateStr = new Date().toISOString().slice(0, 10);
  const key = `logs:${dateStr}`;
  
  const rawLogs = await redis.lrange(key, 0, 19);
  const logs = rawLogs.map(l => typeof l === 'string' ? JSON.parse(l) : l);

  console.log(`--- LAST 20 LOGS FOR ${dateStr} ---`);
  logs.forEach(l => {
    const time = new Date(l.timestamp).toLocaleTimeString();
    const reason = l.reason || 'SUCCESS';
    const score = l.signal?.score || l.signalDebug?.dbgScore || 'N/A';
    const signalAction = l.signal?.action || l.signalDebug?.dbgAction || 'NONE';
    const rejectReason = l.signalDebug?.dbgRejectReason || 'N/A';

    console.log(`[${time}] Signal: ${signalAction} | Score: ${score} | Status: ${reason}`);
    if (signalAction !== 'NONE' && reason.includes('No signal')) {
        console.log(`      └─ Strategy Reject: ${rejectReason}`);
    }
  });
}

main().catch(console.error);
