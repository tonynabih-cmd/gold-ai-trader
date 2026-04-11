import { getLogs } from './lib/logger.js';
import fs from 'fs';

async function main() {
  console.log('Fetching logs from Redis...');
  const logs = await getLogs();
  console.log(`Fetched ${logs.length} logs.`);
  fs.writeFileSync('./tmp/latest_logs.json', JSON.stringify(logs, null, 2));
  console.log('Saved to ./tmp/latest_logs.json');
}

main().catch(console.error);
