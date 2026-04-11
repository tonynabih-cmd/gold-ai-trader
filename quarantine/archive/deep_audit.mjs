import './load_env.js';
import { getLogs } from '../lib/logger.js';
import { getCapitalSession } from '../lib/session.js';
import { fetchWithTimeout } from '../lib/fetch.js';

const USD_AED_PEG = 3.6725;

async function runAudit() {
    console.log('\n==================================================');
    console.log('         TRADING BOT EXECUTION VALIDATION          ');
    console.log('==================================================\n');

    const session = await getCapitalSession();
    const logs = await getLogs();
    const executedLogs = logs.filter(l => l.tradeExecuted);
    
    console.log(`Found ${executedLogs.length} historical executions in logs.`);
    
    // Look back 48h for broker transactions
    const fromDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const url = `${session.baseUrl}/api/v1/history/transactions?from=${fromDate.toISOString().split('.')[0]}`;
    const res = await fetchWithTimeout(url, {
        headers: {
            'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
            'CST': session.cst,
            'X-SECURITY-TOKEN': session.securityToken,
        },
    });

    if (!res.ok) {
        console.error('Failed to fetch broker transactions.');
        return;
    }

    const data = await res.json();
    const transactions = data.transactions || [];
    
    console.log('\n--- PHASE 1: EXECUTION VALIDATION (ENTRY & P&L) ---');
    
    // Match logs to broker transactions
    for (const log of executedLogs) {
        const dealRef = log.dealReference;
        // The dealReference in logs can be o_... or just the ID
        const normalizedRef = dealRef.startsWith('o_') ? dealRef.substring(2) : dealRef;
        
        // Find corresponding transaction (closed)
        const tx = transactions.find(t => 
            (t.reference === normalizedRef || t.dealId === normalizedRef || t.dealId?.includes(normalizedRef)) && 
            t.note?.includes('closed')
        );

        if (tx) {
            console.log(`\nTrade: ${log.tradeId}`);
            console.log(`- Bot Expected Entry: ${log.entryPrice}`);
            console.log(`- Bot Expected Size:  ${log.size}`);
            console.log(`- Broker Realized PnL: ${tx.size} (Size field often used for PnL in AED)`);
            
            // Slippage check would require opening price, let's see if we can find it
            const openTx = transactions.find(t => 
                (t.reference === normalizedRef || t.dealId === normalizedRef || t.dealId?.includes(normalizedRef)) && 
                !t.note?.includes('closed')
            );
            
            if (openTx) {
                // If opening transaction had a price field, we'd compare it.
                // But transactions usually don't. We'd have to look at activity logs.
            }
        }
    }

    console.log('\n--- PHASE 2: BEHAVIOR VALIDATION ---');
    // Check for duplicates
    const refs = executedLogs.map(l => l.dealReference);
    const uniqueRefs = new Set(refs);
    if (refs.length !== uniqueRefs.size) {
        console.error(`❌ DUPLICATE TRADES DETECTED! (${refs.length} logs for ${uniqueRefs.size} unique refs)`);
    } else {
        console.log(`✅ No duplicate trades found in logs (${refs.length} total).`);
    }

    // Check for missing signals (signal but no execution)
    const signalsNotExecuted = logs.filter(l => (l.signalDetected === 'BUY' || l.signalDetected === 'SELL') && !l.tradeExecuted);
    console.log(`- Decision Rejections: ${signalsNotExecuted.length}`);
    signalsNotExecuted.forEach(l => {
        console.log(`  - ${l.time}: ${l.signalDetected} Rejected: ${l.reason}`);
    });

    console.log('\n--- PHASE 3: RISK SYSTEM VALIDATION ---');
    // Check last dailyLoss and dailyTrades
    const lastLog = logs[logs.length-1];
    console.log(`- Last known state: Balance: ${lastLog.balance}, DailyTrades: ${lastLog.dailyTrades}, DailyLoss: ${lastLog.dailyLoss}`);
    
    console.log('\n--- PHASE 5: PRELIMINARY VERDICT ---');
    // Based on what we found
    console.log('Reviewing evidence...');
}

runAudit().catch(console.error);
