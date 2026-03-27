import fs from 'fs';
import { getCapitalSession } from './lib/session.js';
import { fetchAccountData } from './lib/execution.js';

// Simple .env.local loader
try {
  const envContent = fs.readFileSync('.env.local', 'utf-8');
  envContent.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const [k, ...vParts] = trimmed.split('=');
    const v = vParts.join('=').trim().replace(/^['"]|['"]$/g, '');
    process.env[k] = v;
  });
} catch (e) {
  console.log("Could not load .env.local:", e.message);
}

async function testLiveConnection() {
  console.log('\n--- LIVE CONNECTION TEST ---');
  console.log(`Environment: ${process.env.CAPITAL_ENV}`);
  
  try {
    const session = await getCapitalSession();
    console.log('✅ Auth Successful!');
    console.log(`- Base URL: ${session.baseUrl}`);
    
    const account = await fetchAccountData(session);
    if (account) {
      console.log('✅ Account Data Fetched!');
      console.log(`- Real Balance: AED ${account.balance.toFixed(2)}`);
      console.log(`- Available Margin: AED ${account.availableMargin.toFixed(2)}`);
    } else {
      console.log('❌ Failed to fetch account data.');
    }
  } catch (err) {
    console.error('❌ Connection Failed:', err.message);
  }
  console.log('----------------------------\n');
}

testLiveConnection().catch(console.error);
