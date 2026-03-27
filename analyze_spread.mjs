import fs from 'fs';
const logs = JSON.parse(fs.readFileSync('today_logs.json', 'utf-8'));
const spreads = logs.map(l => l.spread).filter(s => typeof s === 'number');
const min = Math.min(...spreads);
const max = Math.max(...spreads);
const avg = spreads.reduce((a,b) => a+b, 0) / spreads.length;

console.log(`Spread Stats Today: Min: ${min.toFixed(2)}, Max: ${max.toFixed(2)}, Avg: ${avg.toFixed(2)}`);
const above04 = spreads.filter(s => s > 0.4).length;
console.log(`Cycles with spread > 0.4: ${above04}/${spreads.length} (${(above04/spreads.length*100).toFixed(1)}%)`);
