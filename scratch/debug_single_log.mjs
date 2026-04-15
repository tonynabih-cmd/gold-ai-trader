import fs from 'fs';
import { getLogs } from '../lib/logger.js';

try {
  const envFile = fs.readFileSync('.env.local', 'utf8');
  envFile.split('\n').forEach(line => {
    const match = line.match(/^([^#\s=]+)="?([^"\n\r]*)"?/);
    if (match) process.env[match[1]] = match[2];
  });
} catch (e) {}

async function run() {
  const logs = await getLogs();
  const l = logs.find(log => log.timeUAE === '4/15/2026, 10:25:05 PM');
  console.log(JSON.stringify(l, null, 2));
}

run().catch(console.error);
