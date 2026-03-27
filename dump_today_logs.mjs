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
  const uaeTime = new Date(Date.now() + 4 * 60 * 60 * 1000);
  const todayStr = uaeTime.toISOString().slice(0, 10);
  
  const todayLogs = logs.filter(l => {
    if (!l.time) return false;
    const logDateUAE = new Date(new Date(l.time).getTime() + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return logDateUAE === todayStr;
  });

  fs.writeFileSync('today_logs.json', JSON.stringify(todayLogs, null, 2));
  console.log(`Dumped ${todayLogs.length} logs for today.`);
}

run().catch(console.error);
