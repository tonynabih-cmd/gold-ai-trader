import fs from 'fs';
import { getLogs } from '../lib/logger.js';

// Load .env.local 
try {
  const envFile = fs.readFileSync('.env.local', 'utf8');
  const envLines = envFile.split('\n');
  envLines.forEach(line => {
    const match = line.match(/^([^#\s=]+)="?([^"\n\r]*)"?/);
    if (match) {
      process.env[match[1]] = match[2];
    }
  });
} catch (e) {}

async function run() {
  const logs = await getLogs();
  const counts = {};
  
  logs.forEach(l => {
    // Only count unique trade executions. 
    // l.tradeExecuted is true when an order is successfully sent.
    if (l.tradeExecuted === true) {
      const date = l.time.split('T')[0];
      // Use signal ID to avoid double-counting sync logs or retries
      const tradeKey = l.tradeId;
      if (!counts[date]) counts[date] = new Set();
      counts[date].add(tradeKey);
    }
  });
  
  console.log('Daily Unique Trade Counts:');
  Object.keys(counts).sort().forEach(date => {
    console.log(`${date}: ${counts[date].size} trades`);
  });
}

run().catch(console.error);
