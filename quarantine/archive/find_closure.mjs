import './load_env.js';
import { getLogs } from '../lib/logger.js';

async function main() {
  const logs = await getLogs();
  const closures = logs.filter(l => l.signal && l.signal.entryType === 'closure');
  console.log(`Found ${closures.length} closure logs.`);
  if (closures.length > 0) {
    const last = closures[closures.length - 1];
    console.log('--- LAST CLOSURE LOG ---');
    console.log(JSON.stringify(last, null, 2));
  } else {
    // If no closure entryType, maybe it's in the 'reason' field or 'result' field
    const alternative = logs.filter(l => l.reason && l.reason.includes('CLOSED'));
    console.log(`Found ${alternative.length} alternative closure logs.`);
    if (alternative.length > 0) {
      console.log('--- LAST ALTERNATIVE CLOSURE LOG ---');
      console.log(JSON.stringify(alternative[alternative.length - 1], null, 2));
    }
  }
}

main().catch(console.error);
