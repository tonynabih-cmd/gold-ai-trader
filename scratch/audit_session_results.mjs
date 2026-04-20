import fs from 'fs';

const logPath = 'c:/Users/Antho/Downloads/gold-trader/scratch/live_session_logs_v2.json';
const PATCH_TIME = new Date('2026-04-20T16:05:19Z').getTime();

function analyze() {
  try {
    const raw = fs.readFileSync(logPath, 'utf8');
    const allLogs = JSON.parse(raw);
    
    // Sort chronologically just in case
    allLogs.sort((a,b) => new Date(a.time).getTime() - new Date(b.time).getTime());

    const preFixLogs = allLogs.filter(l => new Date(l.time).getTime() < PATCH_TIME);
    const postFixLogs = allLogs.filter(l => new Date(l.time).getTime() >= PATCH_TIME);

    console.log(`Summary:`);
    console.log(`- Pre-fix logs: ${preFixLogs.length}`);
    console.log(`- Post-fix logs: ${postFixLogs.length}`);

    if (postFixLogs.length === 0) {
      console.log('!!! NO LOGS FOUND AFTER PATCH TIME !!!');
      // I'll analyze the last 50 logs anyway to see the behavior
      console.log('Analyzing the last 50 logs for behavior...');
      analyzeSubset(allLogs.slice(-50));
      return;
    }

    analyzeSubset(postFixLogs, 'POST-FIX');
    
    console.log('\n--- COMPARISON (STALE SKIPS) ---');
    const preStale = preFixLogs.filter(l => l.reason && l.reason.includes('Candle too stale')).length;
    const postStale = postFixLogs.filter(l => l.reason && l.reason.includes('Candle too stale')).length;
    console.log(`Pre-fix stale skips: ${preStale} (${preFixLogs.length > 0 ? (preStale/preFixLogs.length*100).toFixed(1) : 0}%)`);
    console.log(`Post-fix stale skips: ${postStale} (${postFixLogs.length > 0 ? (postStale/postFixLogs.length*100).toFixed(1) : 0}%)`);

  } catch (err) {
    console.error('Error:', err);
  }
}

function analyzeSubset(logs, label = 'SUBSET') {
  console.log(`\n--- ${label} ANALYSIS ---`);
  
  const reasons = {};
  const candleAttempts = {};
  const executions = [];

  logs.forEach(log => {
    const reason = log.reason || 'SUCCESS';
    reasons[reason] = (reasons[reason] || 0) + 1;

    if (log.tradeId && log.tradeId !== 'NO_SIGNAL') {
      const candleTime = log.tradeId.split('_')[0];
      if (!candleAttempts[candleTime]) candleAttempts[candleTime] = [];
      candleAttempts[candleTime].push(log);
    }
    if (log.tradeExecuted) executions.push(log);
  });

  console.log('\nStop Reasons:');
  Object.entries(reasons).sort((a,b) => b[1] - a[1]).forEach(([reason, count]) => {
    console.log(`${count.toString().padStart(4)}: ${reason}`);
  });

  console.log('\nRetry Analysis:');
  let retriesFound = 0;
  Object.entries(candleAttempts).forEach(([time, attempts]) => {
    if (attempts.length > 1) {
      retriesFound++;
      console.log(`Candle ${time} at ${new Date(parseInt(time)).toISOString()}:`);
      attempts.forEach((a, i) => {
        console.log(`  Attempt ${i+1} (${a.time}): ${a.reason || 'SUCCESS'}`);
      });
    }
  });
  if (retriesFound === 0) console.log('No multi-attempt candles found.');

  console.log('\nDuplicate check:');
  const ids = new Set();
  const dups = executions.filter(e => {
    const id = e.dealReference || e.tradeId;
    if (ids.has(id)) return true;
    ids.add(id);
    return false;
  });
  console.log(dups.length === 0 ? 'No duplicates.' : `${dups.length} duplicates found!`);
}

analyze();
