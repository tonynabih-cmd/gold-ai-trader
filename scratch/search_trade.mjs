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
  const search = '8f7bb92d';
  const found = logs.filter(l => JSON.stringify(l).includes(search));
  console.log(JSON.stringify(found, null, 2));
}

run().catch(console.error);
