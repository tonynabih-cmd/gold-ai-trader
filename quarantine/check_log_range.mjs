import fs from 'fs';
const logs = JSON.parse(fs.readFileSync('./tmp/latest_logs.json', 'utf8'));
if (logs.length > 0) {
  console.log(`First log: ${logs[0].time}`);
  console.log(`Last log: ${logs[logs.length-1].time}`);
}
console.log(`Total logs: ${logs.length}`);
