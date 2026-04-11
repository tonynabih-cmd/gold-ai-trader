import fs from 'fs';
import { getCapitalSession } from '../lib/session.js';
import { fetchBrokerTradeStats } from '../lib/execution.js';

async function main() {
  try {
    const env = fs.readFileSync('.env.local', 'utf-8');
    env.split('\n').forEach(line => {
      const parts = line.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const val = parts.slice(1).join('=').trim().replace(/"/g, '');
        process.env[key] = val;
      }
    });

    const session = await getCapitalSession();
    const stats = await fetchBrokerTradeStats(session);

    console.log(JSON.stringify(stats, null, 2));

  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();
