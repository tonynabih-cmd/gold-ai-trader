import fs from 'fs';
const logs = JSON.parse(fs.readFileSync('./archive/logs_dump.json', 'utf8'));
const executed = logs.filter(l => l.tradeExecuted);
console.log(`Executed in archive: ${executed.length}`);
if (executed.length > 0) {
    console.log(JSON.stringify(executed[0], null, 2));
}
