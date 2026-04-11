import fs from 'fs';
import { getCapitalSession } from '../lib/session.js';
import { fetchWithTimeout } from '../lib/fetch.js'; // FIXED PATH

// Simple .env.local loader
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
  const session = await getCapitalSession();
  const { baseUrl, cst, securityToken } = session;

  console.log("Fetching market details for GOLD...");
  const res = await fetchWithTimeout(
    `${baseUrl}/api/v1/markets/GOLD`,
    {
      headers: {
        'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
        'CST':              cst,
        'X-SECURITY-TOKEN': securityToken,
      },
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`Failed to fetch market details (HTTP ${res.status}): ${body}`);
    return;
  }

  const data = await res.json();
  fs.writeFileSync('market_dump.json', JSON.stringify(data, null, 2));
  console.log("Market data dumped to market_dump.json");
  
  if (data.snapshot) {
    console.log("Snapshot fields:", Object.keys(data.snapshot));
    console.log("Bid:", data.snapshot.bid);
    console.log("Offer (Ask):", data.snapshot.offer);
    console.log("Calculated Spread:", (data.snapshot.offer - data.snapshot.bid).toFixed(4));
  } else {
    console.log("No snapshot found in response!");
  }
}

run().catch(console.error);
