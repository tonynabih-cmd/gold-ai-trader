import fs from 'fs';
import { getCapitalSession } from './lib/session.js';
import { fetchWithTimeout } from './lib/fetch.js';

// Simple .env.local loader
try {
  const env = fs.readFileSync('.env.local', 'utf-8');
  env.split('\n').forEach(line => {
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
  console.log("Authenticating with Capital.com...");
  const session = await getCapitalSession();
  
  const from = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().split('.')[0];
  const url = `${session.baseUrl}/api/v1/history/activity?from=${from}`;

  console.log(`Fetching activity from ${from}...`);
  const res = await fetchWithTimeout(url, {
    headers: {
      'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
      'CST':              session.cst,
      'X-SECURITY-TOKEN': session.securityToken,
    },
  });

  if (!res.ok) {
    console.error(`Error: ${res.status}`);
    return;
  }

  const data = await res.json();
  const activities = data.activities || [];
  
  console.log(`Found ${activities.length} activities.`);
  
  if (activities.length > 0) {
      console.log("Sample activity:", JSON.stringify(activities[0], null, 2));
      fs.writeFileSync('activity_dump.json', JSON.stringify(activities, null, 2));
  }
}

run().catch(console.error);
