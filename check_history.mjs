import fs from 'fs';
import { getCapitalSession } from './lib/session.js';
import { fetchWithTimeout } from './lib/fetch.js';

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
    
    // Capital.com URL for history
    const url = `${session.url}/history/transactions`;
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0); // Start of today

    const resp = await fetchWithTimeout(`${url}?from=${start.toISOString()}`, {
      method: 'GET',
      headers: {
        'CST': session.cst,
        'X-SECURITY-TOKEN': session.token,
      }
    });

    if (!resp.ok) {
      throw new Error(`History fetch failed: ${resp.status}`);
    }

    const data = await resp.json();
    console.log('--- TRANSACTION HISTORY (TODAY) ---');
    console.log(JSON.stringify(data, null, 2));

  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();
