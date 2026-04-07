import { getLogs } from './lib/logger.js';

async function main() {
  const logs = await getLogs();
  const today = '2026-04-07';
  const todayLogs = logs.filter(l => l.time.startsWith(today));
  
  const signals = todayLogs.filter(l => l.dbgAction !== null);
  
  console.log(`Found ${signals.length} candidate signals today.`);
  
  signals.slice(-15).forEach(l => {
    console.log(`[${l.timeUAE}] ${l.dbgAction} (Signal ID: ${l.tradeId})`);
    console.log(`  - Entry Type: ${l.dbgEntryType}`);
    console.log(`  - Score: ${l.dbgScore}`);
    console.log(`  - RSI: ${l.rsi?.toFixed(2)}`);
    console.log(`  - Slope: ${l.emaSlope?.toFixed(4)}%`);
    console.log(`  - ATR: ${l.atr?.toFixed(2)}`);
    console.log(`  - Reject: ${l.dbgRejectReason || 'No reject'}`);
    console.log('  -----------------------------------');
  });
}

main().catch(console.error);
