import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  try {
    const raw = await redis.lrange('trade_logs_list', 0, -1);
    const logs = Array.isArray(raw) ? raw.map(entry => {
        try { return typeof entry === 'string' ? JSON.parse(entry) : entry; }
        catch (e) { return { error: 'parse error', raw: entry }; }
    }) : [];
    
    console.log('--- DETAILED PERFORMANCE AUDIT ---');
    
    const stats = {
        totalCycles: logs.length,
        executed: 0,
        skipped: 0,
        signals: { BUY: 0, SELL: 0, NONE: 0 },
        wins: 0,
        losses: 0,
        breakeven: 0,
        totalPnl: 0,
        maxDrawdown: 0,
        riskRewardSum: 0,
        closedTrades: []
    };

    // Find closed trades from logs
    const closures = logs.filter(l => l.reason && l.reason.startsWith('CLOSED:'));
    
    closures.forEach(c => {
        const pnlMatch = c.reason.match(/Realized P&L: \$(-?\d+\.\d+)/);
        if (pnlMatch) {
            const pnl = parseFloat(pnlMatch[1]);
            stats.totalPnl += pnl;
            if (pnl > 0.01) stats.wins++;
            else if (pnl < -0.01) stats.losses++;
            else stats.breakeven++;
            
            stats.closedTrades.push({
                time: c.timeUAE,
                pnl,
                reason: c.reason
            });
        }
    });

    const executions = logs.filter(l => l.tradeExecuted);
    stats.executed = executions.length;
    
    executions.forEach(e => {
        stats.signals[e.signalDetected]++;
    });

    console.log(`\nCycles Audited: ${stats.totalCycles}`);
    console.log(`Trades Executed: ${stats.executed}`);
    console.log(`Trades Closed: ${stats.closedTrades.length}`);
    console.log(`Wins: ${stats.wins}`);
    console.log(`Losses: ${stats.losses}`);
    console.log(`Break-even: ${stats.breakeven}`);
    console.log(`Total Realized P&L: $${stats.totalPnl.toFixed(2)}`);
    
    if (stats.wins + stats.losses > 0) {
        const winRate = (stats.wins / (stats.wins + stats.losses)) * 100;
        console.log(`Win Rate: ${winRate.toFixed(1)}%`);
    }

    console.log('\n--- Trade History ---');
    stats.closedTrades.forEach(t => {
        console.log(`${t.time} | P&L: $${t.pnl < 0 ? '' : ' '}${t.pnl.toFixed(2)} | ${t.reason.substring(0, 50)}...`);
    });

    console.log('\n--- Strategy Rule Audit ---');
    const signalFailures = logs.filter(l => l.signalDetected !== 'NONE' && !l.tradeExecuted);
    console.log(`Signals filtered by risk/logic: ${signalFailures.length}`);
    
    const rejections = {};
    signalFailures.forEach(l => {
        const r = l.reason || l.dbgRejectReason || 'Unknown';
        rejections[r] = (rejections[r] || 0) + 1;
    });

    console.log('\nTop Rejection Reasons for Signals:');
    Object.entries(rejections)
        .sort((a,b) => b[1] - a[1])
        .slice(0, 10)
        .forEach(([r, c]) => console.log(`${c.toString().padStart(3)} | ${r}`));

    console.log('\n--- AUDIT END ---');

  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();
