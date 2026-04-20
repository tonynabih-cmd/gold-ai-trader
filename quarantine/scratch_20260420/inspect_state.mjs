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

async function inspect() {
  console.log('--- SECTION 1: Current State ---');
  
  const botState = await redis.get('bot_state');
  if (!botState) {
    console.log('bot_state not found in Redis!');
  } else {
    console.log('lastProcessedCandle:', botState.lastProcessedCandle);
    console.log('botEnabled:', botState.botEnabled);
    console.log('stateVersion:', botState.stateVersion);
    console.log('criticalFailure:', botState.criticalFailure);
    console.log('criticalFailureReason:', botState.criticalFailureReason);
  }

  const keys = await redis.keys('lock:candle:*');
  console.log('Active candle locks:', keys);
  
  for (const key of keys) {
    const value = await redis.get(key);
    const ttl = await redis.ttl(key);
    console.log(`- ${key}: owner=${value}, TTL=${ttl}s`);
  }

  console.log('--------------------------------');
}

inspect().catch(console.error);
