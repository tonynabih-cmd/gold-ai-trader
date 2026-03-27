import fs from 'fs';
import { Redis } from '@upstash/redis';

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

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const DEFAULT_STATE = {
  lastProcessedCandle:     0,
  previousProcessedCandle: 0,
  openTrades:              [],
  dailyLoss:               0,
  dailyTrades:             0,
  totalDrawdown:           0,
  peakBalance:             0,
  balance:                 0,
  availableMargin:         0,
  startOfDayBalance:       0,
  lastTradingDay:          '',
  lastHeartbeat:           0,
  botEnabled:              true,
  recentTradeIds:          [],
  lastOrderTimestamp:      0,
  strategyVersion:         'v1.1',
};

async function resetState() {
  console.log('RESETTING BOT STATE FOR LIVE TRADING...');
  try {
    const currentState = await redis.get('bot_state');
    console.log('Current State (Demo):', JSON.stringify(currentState, null, 2));
    
    await redis.set('bot_state', DEFAULT_STATE);
    console.log('✅ Bot State Reset to Defaults!');
    
    // Also clear audit history if needed
    // await redis.del('last_audit');
    
  } catch (err) {
    console.error('❌ Reset Failed:', err.message);
  }
}

resetState().catch(console.error);
