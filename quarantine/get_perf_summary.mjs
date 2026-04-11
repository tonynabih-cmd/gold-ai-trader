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

    // Filter logs since 2026-04-06 11:00:00 UAE
    // Current local time is 2026-04-06 19:44:30
    // 11:00:00 UAE is 07:00:00 UTC
    const startTimeUtc = new Date('2026-04-06T07:00:00Z');
    
    const relevantLogs = logs.filter(l => new Date(l.time) >= startTimeUtc);

    const executed = relevantLogs.filter(l => l.tradeExecuted);
    const closures = relevantLogs.filter(l => l.reason && l.reason.startsWith('CLOSED:'));

    let totalPnl = 0;
    let wins = 0;
    let losses = 0;
    const reasons = [];

    closures.forEach(c => {
      const pnlMatch = c.reason.match(/Realized P&L: \$(-?\d+\.\d+)/);
      if (pnlMatch) {
        const pnl = parseFloat(pnlMatch[1]);
        totalPnl += pnl;
        if (pnl > 0.01) wins++;
        else if (pnl < -0.01) losses++;
        
        reasons.push({
          time: c.timeUAE,
          pnl,
          reason: c.reason
        });
      }
    });

    const totalTrades = executed.length;
    const winRate = (wins + losses > 0) ? (wins / (wins + losses)) * 100 : 0;

    console.log('--- PERFORMANCE SUMMARY SINCE 11 AM ---');
    console.log(`Total Trades Executed: ${totalTrades}`);
    console.log(`Trades Closed: ${closures.length}`);
    console.log(`Wins: ${wins}`);
    console.log(`Losses: ${losses}`);
    console.log(`Win Rate: ${winRate.toFixed(1)}%`);
    console.log(`Net Profit: $${totalPnl.toFixed(2)}`);
    console.log('\n--- Trade Reasons ---');
    reasons.forEach(r => {
      console.log(`${r.time} | P&L: $${r.pnl.toFixed(2)} | ${r.reason}`);
    });
    
    // Also look at rejection reasons if needed, but the user asked for wins/losses reasons.
    // Usually "reasons for wins/losses" means why they hit TP or SL or why they were closed.

  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();
