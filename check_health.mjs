import { getLogs } from './lib/logger.js';

async function checkErrors() {
  const logs = await getLogs();
  const today = '2026-04-07';
  const todayLogs = logs.filter(log => log.time.startsWith(today));
  
  const criticalErrors = todayLogs.filter(log => 
      log.reason && (
          log.reason.includes('ERROR') || 
          log.reason.includes('CRITICAL') || 
          log.reason.includes('FAILED') ||
          log.reason.includes('STOP') ||
          log.reason.includes('HALTED')
      )
  );

  console.log(`Analyzing ${todayLogs.length} logs from today...`);
  console.log(`Found ${criticalErrors.length} critical error logs.`);

  if (criticalErrors.length > 0) {
      console.log('\n--- Critical Errors ---');
      criticalErrors.forEach(e => {
          console.log(`[${e.timeUAE}] Reason: ${e.reason}`);
      });
  } else {
      console.log('\n✅ No critical errors found today. The bot is healthy.');
  }

  // Also check if indicators change, proving they are dynamic
  const uniqueRSIs = new Set(todayLogs.map(l => l.rsi).filter(v => v !== null));
  console.log(`\nMarket Data Stats:`);
  console.log(`- Unique RSI values recorded: ${uniqueRSIs.size}`);
  console.log(`- Last recorded Price: ${todayLogs[todayLogs.length-1].goldPrice}`);
}

checkErrors().catch(console.error);
