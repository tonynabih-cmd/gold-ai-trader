import fs from 'fs';
import { getCapitalSession } from '../lib/session.js';
import { fetchWithTimeout } from '../lib/fetch.js';

// Simple .env.local loader
try {
  const envText = fs.readFileSync('.env.local', 'utf-8');
  envText.split('\n').forEach(line => {
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

async function run() {
  const session = await getCapitalSession();
  const url = `${session.baseUrl}/api/v1/markets?searchTerm=GOLD`;

  const res = await fetchWithTimeout(url, {
    headers: {
      'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
      'CST':              session.cst,
      'X-SECURITY-TOKEN': session.securityToken,
    },
  });

  const data = await res.json();
  console.log(JSON.stringify(data.markets.map(m => ({
    epic: m.epic,
    instrumentName: m.instrumentName,
    scalingFactor: m.scalingFactor
  })), null, 2));
}

run().catch(console.error);
