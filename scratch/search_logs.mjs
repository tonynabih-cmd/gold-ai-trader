import fs from 'fs';
import { fetchWithTimeout } from '../lib/fetch.js';

const e = fs.readFileSync('.env.local','utf-8');
e.split('\n').forEach(l => {
  const p = l.split('=');
  if (p.length >= 2) {
    const key = p[0].trim();
    const val = p.slice(1).join('=').trim().replace(/"/g,'').replace(/'/g,'');
    if (key) process.env[key] = val;
  }
});

const dealIds = [
  '00601567-0001-54c4-0000-00008f5124e2',
  '00601567-0001-54c4-0000-00008f530772',
  '00601567-0001-54c4-0000-00008f536b34',
  '00601567-0001-54c4-0000-00008f550315',
];

async function main() {
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  
  const r = await fetchWithTimeout(kvUrl + '/lrange/trade_logs_list/0/-1', {
    headers: { Authorization: 'Bearer ' + kvToken },
  });
  const b = await r.json();
  const logs = (b.result || []).map(x => typeof x === 'string' ? JSON.parse(x) : x);
  
  console.log('Total logs:', logs.length);
  
  // Check for any executed trade log
  const execLogs = logs.filter(l => l.tradeExecuted === true);
  console.log('Executed trade logs:', execLogs.length);
  
  // Search for dealIds
  for (const did of dealIds) {
    const mentions = logs.filter(l =>
      (l.dealReference && l.dealReference === did) ||
      (l.reason && typeof l.reason === 'string' && l.reason.includes(did)) ||
      (l.tradeId && typeof l.tradeId === 'string' && l.tradeId.includes(did))
    );
    console.log('\ndealId: ' + did + ' -> ' + mentions.length + ' mentions');
    mentions.forEach(m => {
      console.log('  time=' + m.time + ' executed=' + m.tradeExecuted +
        ' entry=' + m.entryPrice + ' sl=' + m.stopLoss +
        ' reason=' + (m.reason || '').substring(0, 120));
    });
  }

  // Check what unique log types exist
  const reasonPrefixes = {};
  for (const l of logs) {
    if (l.reason && typeof l.reason === 'string') {
      const prefix = l.reason.substring(0, 30);
      reasonPrefixes[prefix] = (reasonPrefixes[prefix] || 0) + 1;
    }
  }
  console.log('\n--- Log reason distribution (top 20) ---');
  const sorted = Object.entries(reasonPrefixes).sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [prefix, count] of sorted) {
    console.log('  ' + count + 'x  ' + prefix);
  }
  
  // Check if any log has dealReference at all
  const withRef = logs.filter(l => l.dealReference && l.dealReference !== 'NO_SIGNAL');
  console.log('\nLogs with dealReference:', withRef.length);
  withRef.forEach(l => {
    console.log('  ref=' + l.dealReference + ' exec=' + l.tradeExecuted + ' entry=' + l.entryPrice);
  });
}

main().catch(err => console.error(err.message));
