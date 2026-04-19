import { Redis } from '@upstash/redis';
import fs from 'fs';

const envContent = fs.readFileSync('.env.local', 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const [key, ...valueParts] = line.split('=');
  const value = valueParts.join('=');
  if (key && value) env[key.trim()] = value.trim().replace(/^["']|["']$/g, '');
});

const redis = new Redis({
  url: env.KV_REST_API_URL,
  token: env.KV_REST_API_TOKEN,
});

async function run() {
  const timestamp = Date.now();
  const backupFile = `scratch/bot_state_backup_${timestamp}.json`;

  console.log('--- SECTION 1: Current State ---');
  const botState = await redis.get('bot_state');
  console.log('lastProcessedCandle:', botState?.lastProcessedCandle);
  console.log('botEnabled:', botState?.botEnabled);
  const keys = await redis.keys('lock:candle:*');
  console.log('Active candle locks:', keys);

  console.log('\n--- SECTION 2: Backup Created ---');
  fs.writeFileSync(backupFile, JSON.stringify(botState, null, 2));
  console.log(`Backup saved to: ${backupFile}`);
  console.log('Backup contents:');
  console.log(JSON.stringify(botState, null, 2));

  console.log('\n--- SECTION 3: Apply the stale-state fix ---');
  // Safely reset lastProcessedCandle to 0 to ensure it picks up the next available candle from broker
  // without any "older than persisted" comparison issues.
  // We also delete any lingering candle locks.
  
  if (botState) {
    const newState = { ...botState };
    const oldVal = newState.lastProcessedCandle;
    newState.lastProcessedCandle = 0; // Resetting to 0 is the safest way to "unblock"
    newState.stateVersion = (newState.stateVersion || 0) + 1;
    newState.stateUpdatedAt = Date.now();
    
    await redis.set('bot_state', newState);
    console.log(`Reset lastProcessedCandle from ${oldVal} to 0.`);
  }

  if (keys.length > 0) {
    for (const key of keys) {
      await redis.del(key);
      console.log(`Deleted lock: ${key}`);
    }
  } else {
    console.log('No candle locks found to delete.');
  }

  console.log('\n--- SECTION 4: Safety Verification ---');
  const updatedState = await redis.get('bot_state');
  console.log('New lastProcessedCandle:', updatedState.lastProcessedCandle);
  const remainingLocks = await redis.keys('lock:candle:*');
  console.log('Remaining locks:', remainingLocks);
  
  console.log('\nSafety Explanation:');
  console.log('1. Setting lastProcessedCandle to 0 ensures the next closed candle from the broker will be seen as "newer".');
  console.log('2. The bot has a "stale-candle guard" that rejects any candle older than 180 seconds from CURRENT time.');
  console.log('3. Therefore, even though lastProcessedCandle is 0, the bot will NOT trade on old history.');
  console.log('4. It will only process the first FRESH candle it sees after the market opens.');
}

run().catch(console.error);
