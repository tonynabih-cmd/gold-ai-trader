import fs from 'fs';
import { Redis } from '@upstash/redis';

function loadEnv() {
  try {
    const env = fs.readFileSync('.env.local', 'utf8');
    env.split('\n').forEach(line => {
      const match = line.match(/^([^#\s=]+)="?([^"\n\r]*)"?/);
      if (match) process.env[match[1]] = match[2];
    });
  } catch (e) {}
}

async function run() {
  loadEnv();
  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN
  });

  const session = await redis.get('capital_session_cache');
  console.log('Session:', JSON.stringify(session, null, 2));

  const baseUrl = session.baseUrl || 'https://api-capital.backend-capital.com';
  
  const r = await fetch(baseUrl + '/api/v1/markets/GOLD', {
    headers: {
      'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
      'CST': session.cst,
      'X-SECURITY-TOKEN': session.securityToken
    }
  });
  
  const data = await r.json();
  console.log('Market Info:', JSON.stringify(data, null, 2));
}

run().catch(console.error);
