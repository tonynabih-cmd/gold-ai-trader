import fs from 'fs';
import { getCapitalSession } from '../lib/session.js';
import { getMarketData } from '../lib/market_data.js';
import { loadState } from '../lib/state.js';

// Simple .env.local loader
try {
  const env = fs.readFileSync('.env.local', 'utf-8');
  env.split('\n').forEach(line => {
    if (line.trim() && !line.startsWith('#')) {
      const idx = line.indexOf('=');
      if (idx !== -1) {
        const k = line.substring(0, idx).trim();
        const v = line.substring(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        process.env[k] = v;
      }
    }
  });
} catch (e) {
  console.log("Could not load .env.local:", e.message);
}

async function run() {
  console.log("=========================================");
  console.log("4. UPSTASH SIGNAL QUEUE");
  console.log("=========================================");
  const state = await loadState();
  console.log("recentTradeIds:", state.recentTradeIds);
  console.log("openTrades length:", state.openTrades?.length);
  console.log("dailyTrades:", state.dailyTrades);
  
  console.log("\nAuthenticating with Capital.com...");
  const session = await getCapitalSession();
  
  console.log("\n=========================================");
  console.log("2. WARMUP BUFFER (5m Candles)");
  console.log("=========================================");
  const md = await getMarketData(session, state);
  
  if (md.candles5m) {
    console.log(`5m Candles loaded: ${md.candles5m.length}/100`);
    console.log(`Latest 5m candle time: ${new Date(md.candles5m[md.candles5m.length-1].time).toISOString()}`);
  } else if (md.skip) {
    console.log("Skipped loading candles:", md.reason);
  }

  const c1h = md.candles1h;
  if (!c1h) {
    console.log("\nNo 1h candles returned.");
    return;
  }

  console.log("\n=========================================");
  console.log("3. 1h CANDLE DATA & 1. TREND CALCULATION");
  console.log("=========================================");
  console.log(`Total 1h candles: ${c1h.length}`);
  console.log(`Oldest 1h candle: ${new Date(c1h[0].time).toISOString()}`);
  console.log("Last 5 1h candles:");
  c1h.slice(-5).forEach(c => {
    console.log(`  Time: ${new Date(c.time).toISOString()} | O:${c.open.toFixed(2)} H:${c.high.toFixed(2)} L:${c.low.toFixed(2)} C:${c.close.toFixed(2)}`);
  });

  function emaArray(data, period) {
    if (data.length < period) return [];
    const k   = 2 / (period + 1);
    let val   = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const out = new Array(period - 1).fill(null);
    out.push(val);
    for (let i = period; i < data.length; i++) {
      val = data[i] * k + val * (1 - k);
      out.push(val);
    }
    return out;
  }

  const closes1h = c1h.map(c => c.close);
  const ema1h50 = emaArray(closes1h, 50);
  const emaHistory = ema1h50.slice(-3);

  console.log("\n--- Math Breakdown ---");
  console.log("Last 3 1h EMA50 Values:", emaHistory.map(v => v.toFixed(4)));
  
  if (emaHistory[2] > emaHistory[0]) {
    console.log(`\nCONCLUSION: ${emaHistory[2].toFixed(4)} > ${emaHistory[0].toFixed(4)} => trend1h is UP`);
  } else {
    console.log(`\nCONCLUSION: ${emaHistory[2].toFixed(4)} <= ${emaHistory[0].toFixed(4)} => trend1h is DOWN`);
  }
}

run().catch(console.error);
