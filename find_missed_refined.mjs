import fs from 'fs';
const logs = JSON.parse(fs.readFileSync('today_logs.json', 'utf-8'));
const todayInWindow = logs.filter(l => {
    if (!l.time) return false;
    const hourUTC = new Date(l.time).getUTCHours();
    return hourUTC >= 7 && hourUTC < 16;
});

const missedInWindow = todayInWindow.filter(l => l.dbgAction !== null && l.tradeExecuted === false);
console.log(`Found ${missedInWindow.length} missed signals during Golden Hour.`);

missedInWindow.forEach(l => {
    console.log(`[${l.timeUAE}] ${l.dbgAction} ${l.dbgEntryType} | SkipReason: ${l.reason} | SignalReject: ${l.dbgRejectReason || 'none'}`);
});
if (missedInWindow.length > 0) {
    const counts = {};
    missedInWindow.forEach(l => {
        const sr = l.dbgRejectReason || 'none';
        counts[sr] = (counts[sr] || 0) + 1;
    });
    console.log("\nRejection Breakdown:");
    Object.entries(counts).sort((a,b) => b[1] - a[1]).forEach(([sr, c]) => {
        console.log(`${c}: ${sr}`);
    });
}
