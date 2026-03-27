import fs from 'fs';
const logs = JSON.parse(fs.readFileSync('today_logs.json', 'utf-8'));
const missedSignals = logs.filter(l => l.dbgAction !== null && l.tradeExecuted === false);
console.log(`Found ${missedSignals.length} missed signals today.`);
missedSignals.forEach(l => {
    console.log(`[${l.timeUAE}] ${l.dbgAction} ${l.dbgEntryType} | Reason: ${l.reason} | Reject: ${l.dbgRejectReason}`);
});
