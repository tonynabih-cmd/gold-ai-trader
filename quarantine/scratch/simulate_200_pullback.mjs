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

// SIMULATION PARAMETERS
const PULLBACK_THRESHOLD_PERCENT = 0.25; // UPDATED THRESHOLD
const LOOKAHEAD_CANDLES = 10; // Number of candles to look ahead for "win" confirmation
const TP_MULT = 2.25;
const SL_MULT = 1.5;

async function main() {
  const raw = await redis.lrange('trade_logs_list', -200, -1);
  const logs = raw.map(entry => typeof entry === 'string' ? JSON.parse(entry) : entry);
  
  console.log(`Simulating with Pullback Threshold: ${PULLBACK_THRESHOLD_PERCENT}% (${logs.length} cycles)`);
  
  let totalTrades = 0;
  let wins = 0;
  let falseSignals = 0;
  let activeTrade = null;

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    const goldPrice = log.goldPrice || log.dbgCurrE20;
    if (!goldPrice) continue;

    // Manage active trade
    if (activeTrade) {
        const pnl = (activeTrade.action === 'BUY' ? goldPrice - activeTrade.entry : activeTrade.entry - goldPrice);
        if (activeTrade.action === 'BUY') {
            if (goldPrice >= activeTrade.tp) {
                wins++;
                activeTrade = null;
            } else if (goldPrice <= activeTrade.sl) {
                falseSignals++;
                activeTrade = null;
            }
        } else {
            if (goldPrice <= activeTrade.tp) {
                wins++;
                activeTrade = null;
            } else if (goldPrice >= activeTrade.sl) {
                falseSignals++;
                activeTrade = null;
            }
        }
    }

    if (activeTrade) continue; // Only one trade at a time for simulation simplicity

    // Indicators for generateSignal
    const indicators = {
      currEMA20: log.dbgCurrE20 || log.ema20,
      currEMA50: log.dbgCurrE50 || log.ema50,
      prevEMA20: log.dbgPrevE20,
      prevEMA50: log.dbgPrevE50,
      slopePercent: log.emaSlope || log.slopePercent,
      atr: log.atr,
      atrAverage: log.atrAverage,
      rsi: log.rsi,
      resistance: log.resistance,
      support: log.support,
      trend1h: log.trend1h,
      lastCandle: { close: goldPrice, open: goldPrice, time: new Date(log.time).getTime() },
      ema20arr: [log.dbgPrevE20, log.dbgCurrE20].filter(v => v != null),
      ema50arr: [log.dbgPrevE50, log.dbgCurrE50].filter(v => v != null),
      lastOrderTimestamp: 0 // Mocking to avoid relaxed mode if not needed
    };

    // Override pullDistMult in strategy logic (we'll do this by mocking the function OR just passing a mock context if possible)
    // Since we can't easily override the constant inside the imported module without modifying it, 
    // let's check if we can just "wrap" the logic or if I should just use the 0.25% value in a custom generateSignal implementation in this script.
    
    // Actually, I'll just copy the logic needed for the pullback check here to be precise.
    const pullbackDistanceThreshold = indicators.currEMA20 * (PULLBACK_THRESHOLD_PERCENT / 100);
    const distanceToEMA20 = Math.abs(goldPrice - indicators.currEMA20);
    const touchedEMA20 = distanceToEMA20 < pullbackDistanceThreshold;

    // Use the real generateSignal to check all OTHER conditions (trend, RSI, momentum, etc.)
    // But we need to "fool" it into accepting the distance.
    // We can do this by setting log.atr to a very high value so atr*0.15 is > distance? No, that messes up other things.
    // The best way is to check the dbgRejectReason.
    
    const { signal, debug } = generateSignal(indicators, [ { close: goldPrice, open: goldPrice } ]); // Mock 1m candles
    
    let simulatedSignal = signal;
    if (!signal && debug.dbgRejectReason && debug.dbgRejectReason.includes('pullback: price not close enough')) {
        // This was a rejection ONLY because of distance. 
        // Let's check if it passes OUR threshold.
        if (touchedEMA20) {
            // Re-run other checks manually? 
            // Actually, we can just say "if it hit everything else, it's a trade".
            // To be sure "everything else" hit, let's look at the dbgRejectReason.
            // If the reason is ONLY the distance, then it would have passed.
            simulatedSignal = {
                action: debug.dbgBuyCrossover || indicators.currEMA20 > indicators.currEMA50 ? 'BUY' : 'SELL',
                entryPrice: goldPrice,
                stopLoss: goldPrice - (SL_MULT * indicators.atr),
                takeProfit: goldPrice + (TP_MULT * indicators.atr),
                atr: indicators.atr
            };
            if (simulatedSignal.action === 'SELL') {
                simulatedSignal.stopLoss = goldPrice + (SL_MULT * indicators.atr);
                simulatedSignal.takeProfit = goldPrice - (TP_MULT * indicators.atr);
            }
        }
    }

    if (simulatedSignal) {
        totalTrades++;
        activeTrade = {
            action: simulatedSignal.action,
            entry: simulatedSignal.entryPrice,
            sl: simulatedSignal.stopLoss,
            tp: simulatedSignal.takeProfit,
            atr: simulatedSignal.atr
        };
    }
  }

  const winRate = totalTrades > 0 ? (wins / totalTrades * 100).toFixed(1) : 0;
  
  console.log('\n--- SIMULATION RESULTS ---');
  console.log(`Number of trades triggered: ${totalTrades}`);
  console.log(`Win rate (TP hit): ${winRate}%`);
  console.log(`False signals (SL hit): ${falseSignals}`);
  console.log(`Still open: ${activeTrade ? 1 : 0}`);
}

main().catch(console.error);
