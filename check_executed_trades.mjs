import fs from 'fs';
const logs = JSON.parse(fs.readFileSync('./tmp/latest_logs.json', 'utf8'));
const executed = logs.filter(l => l.tradeExecuted);
console.log(`Executed: ${executed.length}`);
if (executed.length > 0) {
    console.log(JSON.stringify(executed[0], null, 2));
}
