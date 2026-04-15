import fs from 'fs';
import { Redis } from '@upstash/redis';

try {
  const env = fs.readFileSync('.env.local', 'utf-8');
  env.split('\n').forEach(line => {
    if (line.trim() && !line.startsWith('#')) {
      const idx = line.indexOf('=');
      if (idx !== -1) {
        const k = line.substring(0, idx).trim();
        const v = line.substring(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (k) process.env[k] = v;
      }
    }
  });
} catch (e) {}

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const redis = new Redis({ url: KV_URL, token: KV_TOKEN });

async function analyze() {
  const rawLogs = await redis.lrange('trade_logs_list', 0, 1000);
  const logs = rawLogs.map(l => typeof l === 'string' ? JSON.parse(l) : l);

  const losingDeals = [
    '8f7bb92d', '8f550315', '8f536b34', '8f530772', '8f2e2f9d',
    '8f228a1c', '8efe4637', '8ef4a157', '8ef51cac', '8ef2d62c',
    '8ef350c1', '8ef0254f'
  ];

  console.log(`Searching ${logs.length} logs for losing deals...`);
  
  const reasons = {};

  losingDeals.forEach(dealSuffix => {
    // Find logs that mention this deal
    const dealLogs = logs.filter(l => l.dealId?.endsWith(dealSuffix) || (l.message || l.reason || '').includes(dealSuffix));
    
    // Look for closing actions
    const closeLog = dealLogs.find(l => l.action === 'CLOSE_TRADE' || l.action === 'STOPPING_OUT' || l.reason?.includes('SL hit') || l.status === 'CLOSED');
    
    if (closeLog) {
      console.log(`Deal ${dealSuffix}: ${closeLog.closeType || closeLog.reason || closeLog.action || 'Unknown Close'}`);
      const r = closeLog.closeType || closeLog.reason || 'SL hit (implied)';
      reasons[r] = (reasons[r] || 0) + 1;
    } else {
      console.log(`Deal ${dealSuffix}: No close log found`);
      reasons['No close log (Likely Broker SL hit)'] = (reasons['No close log (Likely Broker SL hit)'] || 0) + 1;
    }
  });

  console.log('\n--- Reasons ---');
  console.log(reasons);
}

analyze().catch(console.error);
