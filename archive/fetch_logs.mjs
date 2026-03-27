import { getLogs } from '../lib/logger.js';
import fs from 'fs';

async function main() {
  const logs = await getLogs();
  const last15 = logs.slice(-15);
  fs.writeFileSync('./trade_logs_latest_15.md', 
    '# Last 15 Trade Logs from Upstash KV\n\n```json\n' + JSON.stringify(last15, null, 2) + '\n```\n'
  );
  console.log('Successfully wrote logs to artifact.');
}

main().catch(console.error);
