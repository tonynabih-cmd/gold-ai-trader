
import { Redis } from '@upstash/redis';

// Manual env setup
process.env.KV_REST_API_URL = "https://well-hawk-71664.upstash.io";
process.env.KV_REST_API_TOKEN = "gQAAAAAAARfwAAIncDE5Y2Y4MTg0MWZlN2E0ZTMxYjdkYjZlZGNlODgyNTJiZXAxNzE2NjQ";
process.env.CAPITAL_API_KEY = "cmhsL5yOijdOmLPA";
process.env.CAPITAL_EMAIL = "tony.nabih@gmail.com";
process.env.CAPITAL_PASSWORD = "GoldBot_Live1";
process.env.CAPITAL_ENV = "live";

import { loadState } from '../lib/state.js';
import { getCapitalSession } from '../lib/session.js';
import { fetchAccountData } from '../lib/execution.js';

async function check() {
  try {
    const state = await loadState();
    console.log('--- STORED STATE ---');
    console.log(`Stored Balance: ${state.balance} AED`);
    console.log(`Last State Update: ${new Date(state.stateUpdatedAt).toLocaleString()}`);

    console.log('\n--- REAL-TIME BROKER DATA ---');
    const session = await getCapitalSession();
    const accountData = await fetchAccountData(session);
    
    if (accountData) {
      console.log(`Broker Balance: ${accountData.balance} (Currency unknown, check portal)`);
      console.log(`Broker Equity:  ${accountData.equity}`);
      console.log(`Broker Margin:  ${accountData.availableMargin}`);
      
      const diff = Math.abs(state.balance - accountData.balance);
      if (diff > 0.01) {
        console.warn(`\n[WARNING] DISCREPANCY DETECTED! Difference: ${diff.toFixed(2)}`);
      } else {
        console.log('\n[OK] State matches broker.');
      }
    } else {
      console.error('Could not fetch real-time broker data.');
    }

  } catch (err) {
    console.error('Error:', err);
  }
}

check();
