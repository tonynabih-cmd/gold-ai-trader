import './load_env.js';
import { getLogs } from './lib/logger.js';

async function main() {
  console.log('Fetching absolute latest logs from Upstash...');
  const logs = await getLogs();
  const last20 = logs.slice(-20);
  console.log('--- LATEST 20 LOGS ---');
  console.log(JSON.stringify(last20, null, 2));
  console.log('--- END OF LOGS ---');
}

main().catch(console.error);
