import fs from 'fs';
const { getLogs } = await import('../lib/logger.js');

// Simple .env.local loader
try {
  const envRaw = fs.readFileSync('.env.local', 'utf-8');
  envRaw.split('\n').forEach(line => {
    if (line.trim() && !line.startsWith('#')) {
      const idx = line.indexOf('=');
      if (idx !== -1) {
        process.env[line.substring(0, idx).trim()] = line.substring(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      }
    }
  });
} catch (e) {}

async function run() {
  const logs = await getLogs();
  const executed = logs.filter(l => l.tradeExecuted);
  console.log(`Total executed trades in history: ${executed.length}`);
  if (executed.length > 0) {
      console.log("Last trade details:");
      console.log(JSON.stringify(executed[executed.length - 1], null, 2));
  }
}

run().catch(console.error);
