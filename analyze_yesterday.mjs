import fs from 'fs';
import path from 'path';

// Manual .env.local loader
const envFile = 'c:\\Users\\Antho\\Downloads\\gold-trader\\.env.local';
const envContent = fs.readFileSync(envFile, 'utf-8');
envContent.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const [k, ...vParts] = trimmed.split('=');
    const v = vParts.join('=').trim().replace(/^['"]|['"]$/g, '');
    process.env[k] = v;
});

const { getLogs } = await import('./lib/logger.js');

async function run() {
  const logs = await getLogs();
  const logsYesterday = logs.filter(l => {
    if (!l.time) return false;
    const logDateUAE = new Date(new Date(l.time).getTime() + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return logDateUAE === '2026-03-26';
  });

  console.log(`Yesterday's logs (2026-03-26): ${logsYesterday.length}`);
  if (logsYesterday.length > 0) {
      const spreads = logsYesterday.map(l => l.spread).filter(s => typeof s === 'number');
      if (spreads.length > 0) {
          const avg = spreads.reduce((a,b) => a+b, 0) / spreads.length;
          console.log(`Avg Spread Yesterday: ${avg.toFixed(2)}`);
          const above04 = spreads.filter(s => s > 0.4).length;
          console.log(`Cycles with spread > 0.4: ${above04}/${spreads.length}`);
      }
      
      const counts = {};
      logsYesterday.forEach(l => {
          let r = l.reason || 'NO_REASON';
          if (r.startsWith('SKIP: Duplicate candle')) r = 'SKIP: Duplicate candle';
          counts[r] = (counts[r] || 0) + 1;
      });
      console.log("\nReasons Yesterday:");
      Object.entries(counts).sort((a,b) => b[1] - a[1]).forEach(([r, c]) => {
          console.log(`${c}: ${r}`);
      });
  }
}

run().catch(console.error);
