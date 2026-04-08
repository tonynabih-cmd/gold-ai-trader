import fs from 'fs';
import { Redis } from '@upstash/redis';
import { generateSignal } from '../lib/strategy.js';

// Load .env.local
try {
  const envFile = fs.readFileSync('c:/Users/Antho/Downloads/gold-trader/.env.local', 'utf8');
  const envLines = envFile.split('\n');
  envLines.forEach(line => {
    const match = line.match(/^([^#\s=]+)="?([^"\n\r]*)"?/);
    if (match) {
      process.env[match[1]] = match[2];
    }
  });
} catch (e) {}

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function runSimulation(threshold) {
  const raw = await redis.lrange('trade_logs_list', -200, -1);
  const logs = raw.map(entry => typeof entry === 'string' ? JSON.parse(entry) : entry);
  
  let trades = 0;
  let wins = 0;
  let falseSignals = 0;
  let activeTrade = null;

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    const price = log.goldPrice || log.dbgCurrE20;
    if (!price) continue;

    // Check for exit
    if (activeTrade) {
        // Simple "candle continuation" check: 
        // We look at the next candle (i+1). 
        // If it moves in the right direction, we consider it a "continuation".
        // If it hits a theoretical TP/SL.
        const nextPrice = (i + 1 < logs.length) ? (logs[i+1].goldPrice || logs[i+1].dbgCurrE20) : null;
        if (nextPrice) {
            const move = activeTrade.action === 'BUY' ? nextPrice - activeTrade.entry : activeTrade.entry - nextPrice;
            if (move > 1.0) { // arbitrary "good move"
                wins++;
                activeTrade = null;
            } else if (move < -1.0) { // arbitrary "bad move"
                falseSignals++;
                activeTrade = null;
            }
        }
    }

    if (activeTrade) continue;

    // Signal generation logic
    const indicators = {
      currEMA20: log.dbgCurrE20,
      currEMA50: log.dbgCurrE50,
      prevEMA20: log.dbgPrevE20,
      prevEMA50: log.dbgPrevE50,
      slopePercent: log.emaSlope,
      atr: log.atr,
      rsi: log.rsi,
      lastCandle: { close: price, open: price - (log.emaSlope > 0 ? 0.5 : -0.5) }, // Add some body
      ema20arr: [log.dbgPrevE20, log.dbgCurrE20],
      ema50arr: [log.dbgPrevE50, log.dbgCurrE50]
    };

    const pullbackRange = indicators.currEMA20 * (threshold / 100);
    const dist = Math.abs(price - indicators.currEMA20);

    // If it was rejected ONLY due to pullback distance
    const wasRejectedForDist = log.dbgRejectReason && log.dbgRejectReason.includes('pullback: price not close enough');
    
    if (wasRejectedForDist && dist <= pullbackRange) {
        trades++;
        activeTrade = { action: indicators.currEMA20 > indicators.currEMA50 ? 'BUY' : 'SELL', entry: price };
    }
  }

  return { trades, wins, falseSignals, rate: (wins / (wins + falseSignals || 1) * 100).toFixed(1) };
}

async function main() {
  const result25 = await runSimulation(0.25);
  const result30 = await runSimulation(0.30);
  const result35 = await runSimulation(0.35);

  console.log(`Threshold 0.25%: Trades ${result25.trades}, WinRate ${result25.rate}%, False ${result25.falseSignals}`);
  console.log(`Threshold 0.30%: Trades ${result30.trades}, WinRate ${result30.rate}%, False ${result30.falseSignals}`);
  console.log(`Threshold 0.35%: Trades ${result35.trades}, WinRate ${result35.rate}%, False ${result35.falseSignals}`);
}

main().catch(console.error);
