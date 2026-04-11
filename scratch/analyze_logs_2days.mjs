import { Redis } from '@upstash/redis';
import fs from 'fs';

async function main() {
  const env = fs.readFileSync('.env.local', 'utf-8');
  env.split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const val = parts.slice(1).join('=').trim().replace(/"/g, '');
      if (key) process.env[key] = val;
    }
  });

  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  const rawLogs = await redis.lrange('trade_logs_list', -5000, -1);
  const logs = rawLogs.map(l => typeof l === 'string' ? JSON.parse(l) : l).filter(l => l);

  console.log(`Loaded ${logs.length} logs.`);
  
  const byDate = {
      '2026-04-09': { count: 0, actions: {}, reasons: {} },
      '2026-04-10': { count: 0, actions: {}, reasons: {} },
      '2026-04-11': { count: 0, actions: {}, reasons: {} },
  };

  logs.forEach(log => {
      const d = new Date(log.time);
      const dateStr = d.toISOString().split('T')[0];
      if (byDate[dateStr]) {
          byDate[dateStr].count++;
          
          const dbgReject = log.dbgRejectReason || 'None';
          byDate[dateStr].reasons[dbgReject] = (byDate[dateStr].reasons[dbgReject] || 0) + 1;
          
          if (log.reason && log.reason.includes('EXECUTED')) {
              byDate[dateStr].actions['EXECUTED'] = (byDate[dateStr].actions['EXECUTED'] || 0) + 1;
          } else if (log.reason && log.reason.includes('SKIP')) {
              let shortSkip = log.reason.split(':')[0] + ':' + (log.reason.split(':')[1] || '').substring(0, 30);
              byDate[dateStr].actions[shortSkip] = (byDate[dateStr].actions[shortSkip] || 0) + 1;
          }
      }
  });

  for (const [date, stats] of Object.entries(byDate)) {
      console.log(`\n--- ${date} ---`);
      console.log(`Total Logs: ${stats.count}`);
      console.log(`Actions:`, stats.actions);
      console.log(`Top 5 Debug Reject Reasons:`);
      const sorted = Object.entries(stats.reasons).sort((a,b) => b[1] - a[1]).slice(0, 5);
      sorted.forEach(s => console.log(`  ${s[0]}: ${s[1]}`));
  }
}

main().catch(console.error);
