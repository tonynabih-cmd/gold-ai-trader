import { getLogs } from './lib/logger.js';

async function analyze() {
  const logs = await getLogs();
  const today = '2026-04-07';
  const goldenHourLogs = logs.filter(log => {
      if (!log.time.startsWith(today)) return false;
      const timePart = log.time.split('T')[1];
      return timePart >= '07:00:00';
  });
  
  // Filter for logs that have indicators (not SKIPS due to data fetch)
  const dataLogs = goldenHourLogs.filter(l => l.ema20 !== null);
  
  if (dataLogs.length === 0) {
    console.log('No market data logs found for today.');
    return;
  }
  
  console.log(`Analyzing ${dataLogs.length} market snapshots from today's Golden Hour...`);
  
  // Get unique candles by checking when indicators change
  const uniqueCandles = [];
  let lastEMA20 = null;
  dataLogs.forEach(l => {
      if (l.ema20 !== lastEMA20) {
          uniqueCandles.push(l);
          lastEMA20 = l.ema20;
      }
  });

  console.log(`Found ${uniqueCandles.length} unique 5m candles processed so far.`);
  
  uniqueCandles.forEach(l => {
      const emaSep = Math.abs(l.ema20 - l.ema50);
      const trend = l.ema20 > l.ema50 ? 'UP' : 'DOWN';
      const slope = l.emaSlope || 0;
      const rsi = l.rsi || 0;
      const atr = l.atr || 0;
      const price = l.goldPrice || 0;
      
      console.log(`[${l.timeUAE}] Price: ${price.toFixed(2)} | Trend: ${trend} | Sep: ${emaSep.toFixed(2)} | Slope: ${slope.toFixed(4)}% | RSI: ${rsi.toFixed(1)} | ATR: ${atr.toFixed(2)}`);
      
      if (l.signalDetected === 'NONE') {
          console.log(`  -> No Signal. Reject Reason: ${l.reason || l.dbgRejectReason || 'None'}`);
      } else {
          console.log(`  -> SIGNAL: ${l.signalDetected} | Executed: ${l.tradeExecuted} | Reason: ${l.reason}`);
      }
  });
}

analyze().catch(console.error);
