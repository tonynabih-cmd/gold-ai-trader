import fs from 'fs';
import path from 'path';

// Manual .env.local loader (ensure this runs before any Upstash Redis imports)
const envFile = 'c:\\Users\\Antho\\Downloads\\gold-trader\\.env.local';
const envContent = fs.readFileSync(envFile, 'utf-8');
envContent.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const [k, ...vParts] = trimmed.split('=');
    const v = vParts.join('=').trim().replace(/^['"]|['"]$/g, '');
    process.env[k] = v;
});

// Now that env vars are set, import the logger
const { getLogs } = await import('./lib/logger.js');

async function run() {
  console.log("Fetching logs from Upstash...");
  const logs = await getLogs();
  
  // Current local time for the user (UAE offset: +4)
  const userTimeNow = new Date(Date.now() + 4 * 60 * 60 * 1000);
  const todayStr = userTimeNow.toISOString().slice(0, 10);
  
  console.log(`Analyzing ${logs.length} total logs...`);
  
  const todayLogs = logs.filter(l => {
    if (!l.time) return false;
    // Log time is UTC, convert to UAE date for comparison
    const logDateUAE = new Date(new Date(l.time).getTime() + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return logDateUAE === todayStr;
  });

  console.log(`Found ${todayLogs.length} logs for today (${todayStr}).`);
  
  if (todayLogs.length === 0) {
      console.log("No logs found for today in the fetched list.");
      return;
  }

  const generalReasons = {};
  const signalRejections = {};

  todayLogs.forEach(l => {
    const r = l.reason || 'SUCCESS_OR_NO_SIGNAL';
    generalReasons[r] = (generalReasons[r] || 0) + 1;
    
    // Check signalDebug if reason is SKIP or NO_SIGNAL
    if (l.dbgRejectReason) {
        signalRejections[l.dbgRejectReason] = (signalRejections[l.dbgRejectReason] || 0) + 1;
    }
  });

  console.log("\n--- General Log Reasons ---");
  Object.entries(generalReasons).sort((a,b) => b[1] - a[1]).forEach(([r, c]) => {
    console.log(`${c}: ${r}`);
  });

  console.log("\n--- Specific Signal Rejections (dbgRejectReason) ---");
  Object.entries(signalRejections).sort((a,b) => b[1] - a[1]).forEach(([r, c]) => {
    console.log(`${c}: ${r}`);
  });
  
  if (todayLogs.length > 0) {
      console.log("\n--- Latest Log Details ---");
      const latest = todayLogs[todayLogs.length - 1];
      console.log(JSON.stringify(latest, null, 2));
  }
}

run().catch(err => {
    console.error("ANALYSIS FAILED:", err);
});
