import { Redis } from '@upstash/redis';
import fs from 'fs';
import path from 'path';

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

async function fix() {
  console.log('--- RECONCILING BOT STATE ---');
  try {
    const currentState = await redis.get('bot_state');
    if (!currentState) {
      console.log('❌ No saved state found in Redis.');
      return;
    }

    console.log(`Current lastProcessedCandle: ${currentState.lastProcessedCandle}`);
    console.log(`Current Time (UTC):           ${new Date().toISOString()}`);
    console.log(`Candle Time (UTC):            ${new Date(currentState.lastProcessedCandle).toISOString()}`);

    if (currentState.lastProcessedCandle > Date.now()) {
      console.log('⚠️  DETECTION: lastProcessedCandle is in the future. Resetting to 0...');
      currentState.lastProcessedCandle = 0;
      currentState.previousProcessedCandle = 0;
      
      await redis.set('bot_state', currentState);
      console.log('✅ FIXED: Bot state has been reset. The next cron trigger will process fresh data correctly.');
    } else {
      console.log('✅ ANALYSIS: Bot state is NOT in the future. No action needed.');
    }
    
  } catch (err) {
    console.error('❌ Error fixing state:', err.message);
  }
}

fix().catch(console.error);
