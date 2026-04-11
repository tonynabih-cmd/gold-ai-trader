import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  try {
    const raw = await redis.lrange('trade_logs_list', -100, -1);
    const logs = Array.isArray(raw) ? raw.map(entry => {
        try { return typeof entry === 'string' ? JSON.parse(entry) : entry; }
        catch (e) { return { error: 'parse error', raw: entry }; }
    }) : [];
    
    console.log('--- LOG AUDIT START ---');
    console.log(`Total logs fetched: ${logs.length}`);
    
    const stats = {
        executed: 0,
        skipped: 0,
        signals: { BUY: 0, SELL: 0, NONE: 0 },
        entryTypes: { crossover: 0, pullback: 0, momentum: 0, null: 0 },
        reasons: {}
    };

    logs.forEach(l => {
        if (l.tradeExecuted) stats.executed++;
        else stats.skipped++;

        stats.signals[l.signalDetected || 'NONE']++;
        const et = l.entryType || (l.signalDebug && l.signalDebug.dbgEntryType) || 'null';
        stats.entryTypes[et] = (stats.entryTypes[et] || 0) + 1;

        const reason = l.reason || l.dbgRejectReason || 'No reason';
        // Simplify reason for grouping
        let simpleReason = reason.split('(')[0].trim();
        if (simpleReason.startsWith('SKIP: Waiting for candle settlement')) simpleReason = 'SKIP: Waiting for candle settlement';
        
        stats.reasons[simpleReason] = (stats.reasons[simpleReason] || 0) + 1;
    });

    console.log('\n--- Summary Stats ---');
    console.log(`Executed: ${stats.executed}`);
    console.log(`Skipped: ${stats.skipped}`);
    console.log('Signals:', stats.signals);
    console.log('Entry Types:', stats.entryTypes);
    
    console.log('\n--- Top Skip Reasons ---');
    Object.entries(stats.reasons)
        .sort((a, b) => b[1] - a[1])
        .forEach(([reason, count]) => {
            console.log(`${count.toString().padStart(3)} | ${reason}`);
        });

    console.log('\n--- Detailed Executed Trades ---');
    logs.filter(l => l.tradeExecuted).forEach(l => {
        console.log(`${l.timeUAE} | ${l.signalDetected} | ${l.entryType} | Price: ${l.entryPrice} | Score: ${l.score}`);
    });

    console.log('\n--- Final Log Details (Last 5) ---');
    logs.slice(-5).forEach(l => {
        console.log(`${l.timeUAE} | Signal: ${l.signalDetected} | Exec: ${l.tradeExecuted} | Reason: ${l.reason || l.dbgRejectReason}`);
        if (l.dbgRejectReason) console.log(`  Debug: ${l.dbgRejectReason}`);
    });

    console.log('\n--- LOG AUDIT END ---');

  } catch (err) {
    console.error('Error fetching logs:', err.message);
  }
}

main();
