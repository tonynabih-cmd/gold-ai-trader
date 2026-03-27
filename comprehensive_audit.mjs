import './load_env.js';
import { getLogs } from './lib/logger.js';
import { computeSessionStats } from './lib/stats.js';
import { getCapitalSession } from './lib/session.js';
import { fetchWithTimeout } from './lib/fetch.js';

const USD_AED_PEG = 3.6725;

function validateIndicatorLogic(log) {
    if (!log.indicators) return true;
    const { currEMA20, currEMA50, ema20arr, ema50arr, slopePercent } = log.indicators;
    let valid = true;
    
    // EMA math array verification
    if (ema20arr && ema20arr.length > 0) {
        const lastEmA20 = ema20arr[ema20arr.length - 1];
        if (Math.abs(currEMA20 - lastEmA20) > 0.01) {
            console.error(`  [X] EMA MATH FAILED: currEMA20 (${currEMA20}) doesn't match end of array (${lastEmA20})`);
            valid = false;
        }
    }
    if (ema50arr && ema50arr.length > 0) {
        const lastEmA50 = ema50arr[ema50arr.length - 1];
        if (Math.abs(currEMA50 - lastEmA50) > 0.01) {
            console.error(`  [X] EMA MATH FAILED: currEMA50 (${currEMA50}) doesn't match end of array (${lastEmA50})`);
            valid = false;
        }
    }

    // Signal logic validation
    if (log.signalDetected === 'BUY') {
        if (currEMA20 <= currEMA50) {
            console.error(`  [X] EMA LOGIC FAILED: BUY signal but EMA20 (${currEMA20}) <= EMA50 (${currEMA50})`);
            valid = false;
        }
    } else if (log.signalDetected === 'SELL') {
        if (currEMA20 >= currEMA50) {
            console.error(`  [X] EMA LOGIC FAILED: SELL signal but EMA20 (${currEMA20}) >= EMA50 (${currEMA50})`);
            valid = false;
        }
    }
    return valid;
}

async function runAudit() {
    console.log('\n==================================================');
    console.log('         COMPREHENSIVE BOT AUDIT & VERIFICATION    ');
    console.log('==================================================\n');

    console.log('1. Loading raw logs from persistence...');
    const logs = await getLogs();
    if (!logs || logs.length === 0) {
        console.log('No logs found for audit.');
        return;
    }
    console.log(`-> Loaded ${logs.length} total logs.\n`);

    console.log('2. Recalculating Session Statistics (Local Engine)...');
    const localStats = computeSessionStats(logs);
    
    console.log('--- LOCAL ENGINE INTERMEDIATE TOTALS ---');
    console.log(`Total Decisions: ${localStats.totalDecisions}`);
    console.log(` - Executed:    ${localStats.executed}`);
    console.log(` - Skipped:     ${localStats.skipped}`);
    console.log(` - Rejected:    ${localStats.rejected}`);
    console.log(` - Buys:        ${localStats.buys}`);
    console.log(` - Sells:       ${localStats.sells}`);
    console.log(` - Holds:       ${localStats.skipped} (Mapped as skipped)`);
    console.log(`Total Closures:  ${localStats.closures}`);
    console.log(`Closed Trades:   ${localStats.closedTrades}`);
    console.log(`Win Rate:        ${localStats.winRate ?? 'N/A'}%`);
    console.log(`Best Trade PnL:  ${localStats.bestTrade ?? 'N/A'}`);
    console.log(`Worst Trade PnL: ${localStats.worstTrade ?? 'N/A'}`);
    console.log('');

    console.log('3. Validating EMA and Indicators in Executed Trades...');
    const executedLogs = logs.filter(l => l.tradeExecuted);
    let indicatorsPassed = 0;
    executedLogs.forEach(log => {
        const isValid = validateIndicatorLogic(log);
        if (isValid) indicatorsPassed++;
    });
    console.log(`-> Indicator Validation: ${indicatorsPassed}/${executedLogs.length} trades passed internal math verification.\n`);

    console.log('4. Cross-Checking against Capital.com (Live Broker Snapshot)...');
    let brokerWins = 0;
    let brokerLosses = 0;
    let brokerTotalTrades = 0;
    let brokerBestTrade = null;
    let brokerWorstTrade = null;
    let brokerTotalPnl = 0;

    try {
        const session = await getCapitalSession();
        // Set fromDate to start of current UAE day
        const fromDate = new Date();
        fromDate.setHours(fromDate.getHours() + 4); // convert to UAE
        fromDate.setHours(0,0,0,0); // start of day UAE
        fromDate.setHours(fromDate.getHours() - 4); // back to UTC
        
        const url = `${session.baseUrl}/api/v1/history/transactions?from=${fromDate.toISOString().split('.')[0]}&to=${new Date().toISOString().split('.')[0]}`;
        const res = await fetchWithTimeout(url, {
            headers: {
                'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
                'CST': session.cst,
                'X-SECURITY-TOKEN': session.securityToken,
            },
        });

        if (res.ok) {
            const data = await res.json();
            const txs = data.transactions || [];
            
            // Only consider executed trades with real P&L in the current day
            const trades = txs.filter(t => t.profitAndLoss !== undefined && t.profitAndLoss !== null && t.profitAndLoss !== 0);
            brokerTotalTrades = trades.length;
            
            const pnls = trades.map(t => {
                // Return numerical P&L (assumed to be account currency)
                return parseFloat(t.profitAndLoss);
            });
            
            if (pnls.length > 0) {
                brokerBestTrade = Math.max(...pnls);
                brokerWorstTrade = Math.min(...pnls);
                brokerTotalPnl = pnls.reduce((a, b) => a + b, 0);
                brokerWins = pnls.filter(p => p > 0.001).length;
                brokerLosses = pnls.filter(p => p < -0.001).length;
            }
            
            console.log('--- BROKER SNAPSHOT STATS ---');
            console.log(`Closed Trades:   ${brokerTotalTrades}`);
            console.log(`Wins:            ${brokerWins}`);
            console.log(`Losses:          ${brokerLosses}`);
            console.log(`Best Trade:      ${brokerBestTrade ?? 'N/A'}`);
            console.log(`Worst Trade:     ${brokerWorstTrade ?? 'N/A'}`);
            console.log(`Total PNL:       ${brokerTotalPnl.toFixed(2)}`);

            console.log('\n--- METRIC COMPARISONS (Local vs Broker) ---');
            
            // Because broker gives 0s for some transaction fees, we strictly match actual trades.
            // If the local calculation exactly equals the broker, they match.
            const closedMatch = (localStats.closedTrades || 0) === brokerTotalTrades;
            const winsMatch = (localStats.wins || 0) === brokerWins;
            const lossesMatch = (localStats.losses || 0) === brokerLosses;
            const bestMatch = (localStats.bestTrade || 0).toFixed(2) === (brokerBestTrade || 0).toFixed(2);
            const worstMatch = (localStats.worstTrade || 0).toFixed(2) === (brokerWorstTrade || 0).toFixed(2);

            console.log(`Closed Trades Match: ${closedMatch ? '✅' : '❌'} (Local: ${localStats.closedTrades || 0}, Broker: ${brokerTotalTrades})`);
            console.log(`Wins Match:          ${winsMatch ? '✅' : '❌'} (Local: ${localStats.wins || 0}, Broker: ${brokerWins})`);
            console.log(`Losses Match:        ${lossesMatch ? '✅' : '❌'} (Local: ${localStats.losses || 0}, Broker: ${brokerLosses})`);
            console.log(`Best Trade Match:    ${bestMatch ? '✅' : '❌'} (Local: ${localStats.bestTrade ?? 'N/A'}, Broker: ${brokerBestTrade ?? 'N/A'})`);
            console.log(`Worst Trade Match:   ${worstMatch ? '✅' : '❌'} (Local: ${localStats.worstTrade ?? 'N/A'}, Broker: ${brokerWorstTrade ?? 'N/A'})`);

        } else {
            console.log('-> FAILED to fetch from Capital.com (Network/Auth Error). Snapshot compare skipped. HTTP Status:', res.status);
        }

    } catch(err) {
        console.error('-> ERROR cross-checking Capital.com:', err.message);
    }
    
    console.log('\n==================================================');
    console.log('               AUDIT COMPLETE                      ');
    console.log('==================================================\n');
}

runAudit().catch(console.error);
