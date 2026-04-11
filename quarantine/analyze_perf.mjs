import fs from 'fs';
import { getCapitalSession } from './lib/session.js';
import { fetchWithTimeout } from './lib/fetch.js';

async function main() {
  try {
    const env = fs.readFileSync('.env.local', 'utf-8');
    env.split('\n').forEach(line => {
      const parts = line.split('=');
      if (parts.length >= 2) {
        process.env[parts[0].trim()] = parts.slice(1).join('=').trim().replace(/"/g, '').replace(/'/g, '');
      }
    });

    const session = await getCapitalSession();
    const { baseUrl, cst, securityToken } = session;

    // Fetch history
    const url = `${baseUrl}/api/v1/history/transactions?from=2026-03-24T00:00:00&to=2026-03-28T00:00:00`;
    const res = await fetchWithTimeout(url, {
      headers: {
        'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
        'CST': cst,
        'X-SECURITY-TOKEN': securityToken,
      },
    });

    if (!res.ok) {
      console.error('History failed:', res.status, await res.text());
      return;
    }

    const data = await res.json();
    fs.writeFileSync('capital_history.json', JSON.stringify(data.transactions || [], null, 2));
    console.log('Saved', (data.transactions || []).length, 'transactions');
  } catch (err) {
    console.error(err);
  }
}
main();
