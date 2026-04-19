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

async function dumpState() {
  const state = await redis.get('bot_state');
  console.log(JSON.stringify(state, null, 2));
  
  if (state?.lastProcessedCandle) {
      console.log('\nlastProcessedCandle:', state.lastProcessedCandle);
      console.log('ISO:', new Date(Number(state.lastProcessedCandle)).toISOString());
      console.log('Local (UAE Estimate):', new Date(Number(state.lastProcessedCandle) + 4*3600000).toISOString());
  }
}

dumpState().catch(console.error);
