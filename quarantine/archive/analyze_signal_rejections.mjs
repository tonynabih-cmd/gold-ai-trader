import fs from 'fs';
const logs = JSON.parse(fs.readFileSync('today_logs.json', 'utf-8'));
const signalRejections = {};

logs.forEach(l => {
    if (l.reason === 'SKIP: No signal generated this cycle') {
        const sr = l.dbgRejectReason || 'No reject reason found';
        signalRejections[sr] = (signalRejections[sr] || 0) + 1;
    }
});

const sorted = Object.entries(signalRejections).sort((a,b) => b[1] - a[1]);
sorted.forEach(([sr, c]) => {
    console.log(`${c.toString().padStart(3)}: ${sr}`);
});
