import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   'https://well-hawk-71664.upstash.io',
  token: 'gQAAAAAAARfwAAIncDE5Y2Y4MTg0MWZlN2E0ZTMxYjdkYjZlZGNlODgyNTJiZXAxNzE2NjQ',
});

async function main() {
  try {
    const raw = await redis.lrange('trade_logs_list', 0, -1);
    const logs = Array.isArray(raw) ? raw.map(entry => {
        try { return typeof entry === 'string' ? JSON.parse(entry) : entry; }
        catch (e) { return null; }
    }).filter(l => l !== null) : [];

    const since11AmUtc = new Date('2026-04-06T07:00:00Z');
    const logsSince11 = logs.filter(l => new Date(l.time) >= since11AmUtc);

    const rejections = {};
    const signalFailures = logsSince11.filter(l => l.signalDetected !== 'NONE' && !l.tradeExecuted);
    
    signalFailures.forEach(l => {
        const r = l.reason || l.dbgRejectReason || 'Unknown';
        rejections[r] = (rejections[r] || 0) + 1;
    });

    console.log('--- REJECTION REASONS SINCE 11 AM ---');
    Object.entries(rejections)
        .sort((a,b) => b[1] - a[1])
        .forEach(([r, c]) => console.log(`${c} | ${r}`));

    // Also look at the one loss reason more closely
    const loss = logsSince11.find(l => l.reason && l.reason.startsWith('CLOSED:'));
    if (loss) {
        console.log('\n--- DETAILED LOSS LOG ---');
        console.log(JSON.stringify(loss, null, 2));
    }

  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();
