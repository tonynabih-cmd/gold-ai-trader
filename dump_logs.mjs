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
const { getLogs } = await import('./lib/logger.js');

async function run() {
  const logs = await getLogs();
  console.log(`Loaded ${logs.length} logs.`);
  
  if (logs.length > 0) {
      // Find logs from today
      const uaeNow = new Date(Date.now() + 4 * 60 * 60 * 1000);
      const today = uaeNow.toISOString().slice(0, 10);
      
      const todayLogs = logs.filter(l => {
          if (!l.time) return false;
          const lt = new Date(new Date(l.time).getTime() + 4 * 60 * 60 * 1000);
          return lt.toISOString().slice(0, 10) === today;
      });
      
      console.log(`Today's logs: ${todayLogs.length}`);
      
      const executed = todayLogs.filter(l => l.tradeExecuted);
      console.log(`Today's executed in logs: ${executed.length}`);
      
      if (todayLogs.length > 0) {
          console.log("Last 2 logs from today:");
          console.log(JSON.stringify(todayLogs.slice(-2), null, 2));
      }
  }
}

run().catch(console.error);
