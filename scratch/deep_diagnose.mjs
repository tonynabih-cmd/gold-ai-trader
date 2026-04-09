import fs from 'fs';
import { getLogs } from '../lib/logger.js';

// Load .env.local
try {
  const envFile = fs.readFileSync('.env.local', 'utf8');
  envFile.split('\n').forEach(line => {
    const match = line.match(/^([^#\s=]+)="?([^"\n\r]*)"?/);
    if (match) process.env[match[1]] = match[2];
  });
} catch (e) {}

async function diagnose() {
  const logs = await getLogs();
  const today = new Date().toISOString().split('T')[0];
  
  // Get last 3 days of logs
  const recentLogs = logs.filter(log => {
    const d = new Date(log.time);
    const diff = (Date.now() - d.getTime()) / (1000 * 60 * 60);
    return diff < 72; // last 3 days
  });

  console.log(`\n=== DEEP DIAGNOSIS: Last 3 days (${recentLogs.length} total logs) ===\n`);

  // Filter out duplicate candle skips - we only care about REAL processing cycles
  const realCycles = recentLogs.filter(l => 
    !l.reason?.includes('Duplicate candle') &&
    !l.reason?.includes('Waiting for candle settlement')
  );

  console.log(`Real processing cycles (non-duplicate): ${realCycles.length}`);
  console.log(`Duplicate candle skips: ${recentLogs.length - realCycles.length}`);

  // Count by category
  const categories = {
    'TRADE_EXECUTED': 0,
    'NO_SIGNAL_STRATEGY': 0,
    'RISK_BLOCKED': 0,
    'MARKET_DATA_ERROR': 0,
    'SESSION_TIME': 0,
    'SIDEWAYS_MARKET': 0,
    'LOW_VOLATILITY': 0,
    'OTHER': 0,
  };

  const rejectReasons = {};
  const signalGenButBlocked = [];

  for (const log of realCycles) {
    if (log.tradeExecuted) {
      categories.TRADE_EXECUTED++;
      continue;
    }

    const reason = log.reason || '';
    
    if (reason.includes('No signal generated') || reason.includes('SKIP: No signal')) {
      categories.NO_SIGNAL_STRATEGY++;
      const dbgReason = log.dbgRejectReason || log.signalDebug?.dbgRejectReason || 'unknown';
      rejectReasons[dbgReason] = (rejectReasons[dbgReason] || 0) + 1;
    } else if (reason.includes('outside trading session') || reason.includes('Weekend') || reason.includes('Friday close')) {
      categories.SESSION_TIME++;
    } else if (reason.includes('sideways market')) {
      categories.SIDEWAYS_MARKET++;
    } else if (reason.includes('low volatility')) {
      categories.LOW_VOLATILITY++;
    } else if (reason.includes('Market data error') || reason.includes('BROKER')) {
      categories.MARKET_DATA_ERROR++;
    } else if (reason.startsWith('SKIP:') || reason.startsWith('PAUSE:') || reason.startsWith('STOP:')) {
      categories.RISK_BLOCKED++;
      // Check if a signal was actually generated but blocked by risk
      if (log.signalDetected && log.signalDetected !== 'NONE') {
        signalGenButBlocked.push({ time: log.timeUAE, signal: log.signalDetected, reason });
      }
    } else {
      categories.OTHER++;
    }
  }

  console.log('\n--- CYCLE BREAKDOWN ---');
  for (const [cat, count] of Object.entries(categories)) {
    const pct = realCycles.length > 0 ? (count / realCycles.length * 100).toFixed(1) : 0;
    console.log(`  ${cat}: ${count} (${pct}%)`);
  }

  console.log('\n--- STRATEGY REJECTION REASONS (why no signal) ---');
  const sorted = Object.entries(rejectReasons).sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sorted) {
    console.log(`  [${count}x] ${reason}`);
  }

  if (signalGenButBlocked.length > 0) {
    console.log('\n--- SIGNALS GENERATED BUT BLOCKED BY RISK ---');
    for (const s of signalGenButBlocked) {
      console.log(`  ${s.time} | ${s.signal} | Blocked: ${s.reason}`);
    }
  }

  // Check when last trade actually executed
  const executed = recentLogs.filter(l => l.tradeExecuted);
  if (executed.length > 0) {
    const last = executed[executed.length - 1];
    console.log(`\n--- LAST EXECUTED TRADE ---`);
    console.log(`  Time: ${last.timeUAE}`);
    console.log(`  Signal: ${last.signalDetected}`);
  } else {
    console.log('\n⚠️  NO TRADES EXECUTED IN THE LAST 3 DAYS');
  }

  // Check lastOrderTimestamp from most recent log's botState
  const lastLog = recentLogs[recentLogs.length - 1];
  if (lastLog) {
    const rawState = lastLog.rawBotState || lastLog;
    const lastOrder = rawState.lastOrderTimestamp || rawState.botState?.lastOrderTimestamp;
    if (lastOrder) {
      const hoursSince = (Date.now() - lastOrder) / (1000 * 60 * 60);
      console.log(`\n--- LAST ORDER TIMESTAMP ---`);
      console.log(`  Timestamp: ${new Date(lastOrder).toISOString()}`);
      console.log(`  Hours ago: ${hoursSince.toFixed(1)}`);
      console.log(`  Relaxed mode active: ${hoursSince > 48 ? 'YES' : 'NO'}`);
    }
  }

  // Show the last 5 real processing cycles with detail
  console.log('\n--- LAST 5 REAL CYCLES (with signal debug) ---');
  const last5 = realCycles.slice(-5);
  for (const log of last5) {
    console.log(`\n  [${log.timeUAE}]`);
    console.log(`    Reason: ${log.reason}`);
    console.log(`    Signal: ${log.signalDetected}`);
    
    const dbg = log.signalDebug || {};
    if (dbg.dbgRejectReason) console.log(`    Reject: ${dbg.dbgRejectReason}`);
    if (dbg.dbgPullbackReason) console.log(`    Pullback: ${dbg.dbgPullbackReason}`);
    if (dbg.dbgAction) console.log(`    Action: ${dbg.dbgAction} (${dbg.dbgEntryType})`);
    if (dbg.dbgMarketConditions) {
      const mc = dbg.dbgMarketConditions;
      console.log(`    Market: slope=${mc.emaSlope?.toFixed(4)}% | RSI=${mc.rsi?.toFixed(1)} | ATR=${mc.atr?.toFixed(2)} | spread=${mc.spread}`);
    }
    if (dbg.isRelaxedMode !== undefined) console.log(`    Relaxed: ${dbg.isRelaxedMode} (${dbg.hoursSinceLastTrade?.toFixed(1)}h)`);
    if (dbg.dbgDistToEMA20 !== undefined) console.log(`    Dist→EMA20: ${dbg.dbgDistToEMA20} | Threshold: ${dbg.dbgPullbackThreshold}`);
    if (dbg.dbgEmaSeparation !== undefined) console.log(`    EMA Sep: ${dbg.dbgEmaSeparation} | ATR*0.35: ${(dbg.dbgAtr * 0.35)?.toFixed(2)}`);
  }
}

diagnose().catch(console.error);
