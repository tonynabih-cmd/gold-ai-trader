import fs from 'fs';

// Load env before anything else
try {
  const env = fs.readFileSync('.env.local', 'utf-8');
  env.split('\n').forEach(line => {
    if (line.trim() && !line.startsWith('#')) {
      const idx = line.indexOf('=');
      if (idx !== -1) {
        const k = line.substring(0, idx).trim();
        const v = line.substring(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        process.env[k] = v;
      }
    }
  });
} catch (e) {
  console.log("Could not load .env.local:", e.message);
}

// Now import logger
const { getLogs } = await import('../lib/logger.js');

async function run() {
  const logs = await getLogs();
  const executed = logs.filter(l => l.tradeExecuted);
  console.log(`Total executed logs ever: ${executed.length}`);
  if (executed.length > 0) {
      console.log("Last executed log:");
      console.log(JSON.stringify(executed[executed.length-1], null, 2));
  }
}

run().catch(console.error);
