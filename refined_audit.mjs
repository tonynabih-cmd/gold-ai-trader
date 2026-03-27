import fs from 'fs';

const USD_AED_PEG = 3.6725;

function runAudit() {
    let allLogs = [];
    if (fs.existsSync('logs_dump.json')) allLogs = allLogs.concat(JSON.parse(fs.readFileSync('logs_dump.json', 'utf8')));
    if (fs.existsSync('today_logs.json')) allLogs = allLogs.concat(JSON.parse(fs.readFileSync('today_logs.json', 'utf8')));

    allLogs.sort((a, b) => new Date(a.time) - new Date(b.time));
    const uniqueLogs = [];
    const seenTimes = new Set();
    for (const log of allLogs) {
        if (!seenTimes.has(log.time)) {
            uniqueLogs.push(log);
            seenTimes.add(log.time);
        }
    }

    const issues = [];
    
    uniqueLogs.forEach(log => {
        const date = new Date(log.time);
        const hour = date.getUTCHours();
        const day = date.getUTCDay();

        // 1. Session Check (Executed trades only)
        if (log.tradeExecuted) {
            const isFridayClose = (day === 5 && hour >= 16);
            if (hour < 7 || hour >= 16 || isFridayClose || day === 0 || day === 6) {
                issues.push(`[CRITICAL] Session Violation: Trade at ${log.timeUAE} (Hour ${hour} UTC, Day ${day})`);
            }
        }

        // 2. Strategy Logic Check (Executed trades only)
        if (log.tradeExecuted) {
            if (log.signalDetected === 'BUY') {
                if (log.ema20 <= log.ema50) {
                    issues.push(`[CRITICAL] Strategy Violation: BUY at ${log.timeUAE} but EMA20 (${log.ema20}) <= EMA50 (${log.ema50})`);
                }
            }
            if (log.signalDetected === 'SELL') {
                if (log.ema20 >= log.ema50) {
                    issues.push(`[CRITICAL] Strategy Violation: SELL at ${log.timeUAE} but EMA20 (${log.ema20}) >= EMA50 (${log.ema50})`);
                }
            }
        }

        // 3. Spread Check (Executed trades only)
        // Note: We don't know the limit at the time, but let's assume 0.50 was the max ever allowed.
        if (log.tradeExecuted && log.spread > 0.51) {
             issues.push(`[HIGH] Spread Violation: Trade at ${log.timeUAE} with spread ${log.spread}`);
        }

        // 4. Position Sizing
        if (log.tradeExecuted && log.size && log.entryPrice && log.stopLoss && log.balance) {
             const stopDist = Math.abs(log.entryPrice - log.stopLoss);
             const riskUSD = log.size * stopDist;
             const balanceUSD = log.balance / USD_AED_PEG;
             const riskPct = riskUSD / balanceUSD;
             if (riskPct > 0.021) {
                 issues.push(`[HIGH] Risk Violation: Trade at ${log.timeUAE} risks ${(riskPct*100).toFixed(2)}% (Max 2%)`);
             }
        }

        // 5. Silent Failures (Signals that didn't execute and don't have a reason)
        if (log.signalDetected !== 'NONE' && !log.tradeExecuted && (!log.reason || log.reason === 'null')) {
            // Signal detected but no action and no reason
            issues.push(`[MEDIUM] Silent Failure: Signal ${log.signalDetected} at ${log.timeUAE} has no execution and no reason`);
        }
    });

    console.log(`Audit complete. Found ${issues.length} issues.`);
    issues.forEach(iss => console.log(iss));
}

runAudit();
