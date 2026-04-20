import { getMarketData } from './lib/market_data.js';
import dotenv from 'dotenv';
dotenv.config({path: '.env.local'});
const session = {
  baseUrl: process.env.CAPITAL_BASE_URL || 'https://demo-api-capital.backend.capital.com',
  cst: process.env.TEST_CST || '1',
  securityToken: process.env.TEST_SEC_TOKEN || '1'
};
console.log('Session', session.baseUrl);
// Actually we can just fetch one candle directly to see
import { fetchWithTimeout } from './lib/fetch.js';
async function run() {
  // Let's do a public or unauthenticated one if possible? Capital.com requires auth.
  // Instead, let's use the quarantine script to authenticate.
}
run();
