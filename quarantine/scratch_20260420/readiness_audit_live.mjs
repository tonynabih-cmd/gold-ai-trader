import { Redis } from '@upstash/redis';
import fs from 'fs';

// Load .env.local 
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

async function runAudit() {
  console.log('--- STARTING LIVE READINESS AUDIT ---');
  
  const rawLogs = await redis.lrange('trade_logs_list', 0, -1);
  const logs = rawLogs.map(l => typeof l === 'string' ? JSON.parse(l) : l);
  
  if (logs.length === 0) {
    console.error('No logs found in Redis!');
    return;
  }

  const latestLog = logs[logs.length - 1];
  const today = new Date().toISOString().split('T')[0];
  const todayLogs = logs.filter(l => l.time.startsWith(today));

  console.log(`Analyzing ${logs.length} total logs (${todayLogs.length} from today)...`);

  const results = {
    execution: { ok: true, issues: [] },
    strategy: { ok: true, issues: [] },
    timing: { ok: true, issues: [] },
    risk: { ok: true, issues: [] },
    health: { ok: true, issues: [] },
  };

  // 1. Execution Readiness
  const executionFailures = logs.filter(l => l.signalDetected !== 'NONE' && l.reason === 'APPROVED' && !l.tradeExecuted);
  if (executionFailures.length > 0) {
    results.execution.ok = false;
    results.execution.issues.push(`${executionFailures.length} trades failed to execute despite being APPROVED.`);
    executionFailures.slice(-3).forEach(f => {
      results.execution.issues.push(`  - Fail at ${f.time}: ${JSON.stringify(f.brokerResponse || f.reason)}`);
    });
  }

  const brokerRejections = logs.filter(l => l.brokerResponse && l.brokerResponse.errorCode);
  if (brokerRejections.length > 0) {
      results.execution.ok = false;
      results.execution.issues.push(`${brokerRejections.length} broker rejections found.`);
      brokerRejections.slice(-3).forEach(r => {
          results.execution.issues.push(`  - Broker Error: ${r.brokerResponse.errorCode} (${r.brokerResponse.errorKey})`);
      });
  }

  // 2. Strategy Behavior
  const signals = logs.filter(l => l.signalDetected !== 'NONE');
  const rejections = logs.filter(l => l.dbgRejectReason && l.dbgRejectReason !== 'null');
  const rejectCounts = {};
  rejections.forEach(r => {
    rejectCounts[r.dbgRejectReason] = (rejectCounts[r.dbgRejectReason] || 0) + 1;
  });

  const topRejections = Object.entries(rejectCounts).sort((a,b) => b[1] - a[1]);
  if (signals.length === 0 && todayLogs.length > 50) {
     results.strategy.ok = false;
     results.strategy.issues.push('No signals detected today despite high activity. Strategy might be too strict.');
  }

  // 3. Data Timing
  const staleCandles = logs.filter(l => l.reason && l.reason.includes('stale'));
  if (staleCandles.length > 0) {
    results.timing.ok = false;
    results.timing.issues.push(`${staleCandles.length} instances of stale candles detected.`);
  }

  // Check candle lag
  const laggyLogs = logs.filter(l => {
      if (!l.time || !l.lastCandleTime) return false;
      const logT = new Date(l.time).getTime();
      const candleT = new Date(l.lastCandleTime).getTime();
      return (logT - candleT) > 300000; // 5 mins
  });
  if (laggyLogs.length > 5) {
      results.timing.ok = false;
      results.timing.issues.push(`High candle lag (>5m) detected in ${laggyLogs.length} cycles.`);
  }

  // 4. Risk Management
  const highSpreadSkips = logs.filter(l => l.reason === 'SKIP: high spread').length;
  const avgSpread = logs.reduce((sum, l) => sum + (l.spread || 0), 0) / logs.length;
  
  if (highSpreadSkips > logs.length * 0.5) {
      results.risk.issues.push(`Warning: Spread filter blocking ${((highSpreadSkips/logs.length)*100).toFixed(1)}% of cycles. Avg spread: ${avgSpread.toFixed(2)}`);
  }

  // 5. System Health
  const integrityFailures = logs.filter(l => l.integrityOk === false || l.criticalFailure === true);
  if (integrityFailures.length > 0) {
    results.health.ok = false;
    results.health.issues.push('Integrity failures or Critical failures detected in logs.');
  }

  const brokerStateUnavailable = logs.filter(l => l.reason && l.reason.includes('BROKER_STATE_UNAVAILABLE')).length;
  if (brokerStateUnavailable > 5) {
      results.health.ok = false;
      results.health.issues.push(`Stability Issue: BROKER_STATE_UNAVAILABLE occurred ${brokerStateUnavailable} times.`);
  }

  // Output formatting
  console.log('\n--- AUDIT RESULTS ---');
  Object.entries(results).forEach(([cat, res]) => {
    console.log(`${res.ok ? '✅' : '❌'} ${cat.toUpperCase()}: ${res.ok ? 'Pass' : 'Failed'}`);
    res.issues.forEach(issue => console.log(`   - ${issue}`));
  });

  console.log('\n--- TOP STRATEGY REJECTIONS ---');
  topRejections.slice(0, 5).forEach(([reason, count]) => {
     console.log(`${count.toString().padEnd(5)} | ${reason}`);
  });

  console.log('\n--- TOP SKIP REASONS (Global) ---');
  const skipCounts = {};
  logs.forEach(l => {
      const r = l.reason || 'None';
      skipCounts[r] = (skipCounts[r] || 0) + 1;
  });
  Object.entries(skipCounts).sort((a,b) => b[1] - a[1]).slice(0, 10).forEach(([r, c]) => {
      console.log(`${c.toString().padEnd(5)} | ${r}`);
  });

  const latestTrades = logs.filter(l => l.tradeExecuted).slice(-5);
  console.log('\n--- RECENT TRADES ---');
  if (latestTrades.length === 0) console.log('No recent trades executed.');
  latestTrades.forEach(t => {
      console.log(`${t.time} | ${t.entryType} ${t.signalDetected} @ ${t.entryPrice} | Result: ${t.dealReference || 'N/A'}`);
  });

  console.log('\n--- FINAL VERDICT ---');
  const allOk = Object.values(results).every(r => r.ok);
  if (allOk) {
    console.log('READY FOR LIVE TRADING');
  } else {
    console.log('NOT READY - SEE BLOCKERS ABOVE');
  }
}

runAudit().catch(console.error);
