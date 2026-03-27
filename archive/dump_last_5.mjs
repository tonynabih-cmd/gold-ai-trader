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

const { getLogs } = await import('../lib/logger.js');

async function run() {
  const logs = await getLogs();
  console.log(JSON.stringify(logs.slice(-5), null, 2));
}

run().catch(console.error);
