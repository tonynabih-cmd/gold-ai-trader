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

    const todayStartUtc = new Date('2026-04-06T00:00:00Z');
    const logsToday = logs.filter(l => new Date(l.time) >= todayStartUtc);

    console.log(`\n--- ALL LOGS TODAY (2026-04-06) ---`);
    console.log(`Total cycles today: ${logsToday.length}`);
    
    const executedToday = logsToday.filter(l => l.tradeExecuted);
    console.log(`Executed today: ${executedToday.length}`);
    executedToday.forEach(e => console.log(`  - ${e.timeUAE}: ${e.signalDetected} ${e.reason || 'TRADED'}`));

    const closuresToday = logsToday.filter(l => l.reason && l.reason.startsWith('CLOSED:'));
    console.log(`Closed today: ${closuresToday.length}`);
    closuresToday.forEach(c => console.log(`  - ${c.timeUAE}: ${c.reason}`));

    // Filter since 11 AM UAE (07:00 UTC)
    const since11AmUtc = new Date('2026-04-06T07:00:00Z');
    const logsSince11 = logsToday.filter(l => new Date(l.time) >= since11AmUtc);
    
    console.log(`\n--- SINCE 11 AM UAE ---`);
    console.log(`Cycles since 11 AM: ${logsSince11.length}`);
    const executedSince11 = logsSince11.filter(l => l.tradeExecuted);
    console.log(`Executed since 11 AM: ${executedSince11.length}`);
    const closuresSince11 = logsSince11.filter(l => l.reason && l.reason.startsWith('CLOSED:'));
    console.log(`Closed since 11 AM: ${closuresSince11.length}`);

  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();
