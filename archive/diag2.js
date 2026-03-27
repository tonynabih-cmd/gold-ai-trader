import fs from 'fs';
import { getCapitalSession } from '../lib/session.js';
import { getMarketData } from '../lib/market_data.js';
import { loadState } from '../lib/state.js';

try {
  const env = fs.readFileSync('.env.local', 'utf-8');
  env.split('\n').forEach(line => {
    if (line.trim() && !line.startsWith('#')) {
      const idx = line.indexOf('=');
      if (idx !== -1) {
        process.env[line.substring(0, idx).trim()] = line.substring(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      }
    }
  });
} catch (e) {}

async function run() {
  const state = await loadState();
  const session = await getCapitalSession();
  const md = await getMarketData(session, state);
  
  const c1h = (md.candles1h || []);
  let sum = 0;
  console.log(`Dumping ${c1h.length} 1h candles:`);
  c1h.forEach((c, i) => {
    sum += c.close;
    console.log(`[${i}] ${new Date(c.time).toISOString()} | Close: ${c.close}`);
  });
  console.log(`Total sum: ${sum}`);
  console.log(`SMA: ${sum / c1h.length}`);
}

run().catch(console.error);
