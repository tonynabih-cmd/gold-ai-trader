import fs from 'fs';
const logs = JSON.parse(fs.readFileSync('today_logs.json', 'utf-8'));
const counts = {};
logs.forEach(l => {
    let r = l.reason || 'NO_REASON';
    if (r.startsWith('SKIP: Duplicate candle')) {
        r = 'SKIP: Duplicate candle';
    }
    counts[r] = (counts[r] || 0) + 1;
});

const sorted = Object.entries(counts).sort((a,b) => b[1] - a[1]);
sorted.forEach(([r, c]) => {
    console.log(`${c.toString().padStart(3)}: ${r}`);
});
