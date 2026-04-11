import fs from 'fs';
const logs = JSON.parse(fs.readFileSync('today_logs.json', 'utf-8'));
const logs525 = logs.filter(l => l.timeUAE && l.timeUAE.includes('5:25:05 PM'));
console.log(JSON.stringify(logs525, null, 2));
