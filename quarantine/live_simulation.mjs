import { Redis } from '@upstash/redis';
import fs from 'fs';
import { generateSignal } from './lib/strategy.js';

const redis = new Redis({
  url:   'https://well-hawk-71664.upstash.io',
  token: 'gQAAAAAAARfwAAIncDE5Y2Y4MTg0MWZlN2E0ZTMxYjdkYjZlZGNlODgyNTJiZXAxNzE2NjQ',
});

const TRAILING_ATR_MULT = 1.5;
const BE_ATR_THRESHOLD = 1.0;
const TP_ATR_MULT = 2.25;
const SL_ATR_MULT = 1.5;

async function runSimulation() {
  console.log('--- STARTING LIVE-SIMULATION (v1.3 Logic Replay) ---');
  
  const rawLogs = await redis.lrange('trade_logs_list', 0, -1);
  const logs = rawLogs.map(l => typeof l === 'string' ? JSON.parse(l) : l);
  // Sort logs by time ascending for chronological simulation
  const sortedLogs = logs.sort((a,b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  
  const simulation = {
    executed_trades: [],
    missed_trades: [],
    risk_summary: {
      avg_risk_pct: 0,
      max_drawdown: 0,
      total_trades: 0,
      wins: 0,
      losses: 0,
    },
    strategy_flaws: [],
    final_pnl: 0
  };

  let activeTrade = null;
  let balance = 1000; // base for drawdown calculation
  let peakBalance = 1000;
  let maxDD = 0;

  for (let i = 0; i < sortedLogs.length; i++) {
    const log = sortedLogs[i];
    if (!log.ema20) continue;

    // ── 1. Check if active trade exit ────────────────────────────────────────
    if (activeTrade) {
      const price = log.goldPrice;
      const profit = (activeTrade.action === 'BUY' ? price - activeTrade.entry : activeTrade.entry - price);
      const profitAtr = profit / activeTrade.atr;

      // Update trailing stop
      if (profitAtr >= BE_ATR_THRESHOLD) {
          const newTrail = activeTrade.action === 'BUY' 
            ? price - (activeTrade.atr * TRAILING_ATR_MULT)
            : price + (activeTrade.atr * TRAILING_ATR_MULT);
          
          if (activeTrade.action === 'BUY' && newTrail > activeTrade.stopLoss) {
              activeTrade.stopLoss = newTrail;
              activeTrade.trailingUpdates++;
          } else if (activeTrade.action === 'SELL' && newTrail < activeTrade.stopLoss) {
              activeTrade.stopLoss = newTrail;
              activeTrade.trailingUpdates++;
          }
      }

      // Check exit
      let exited = false;
      let exitReason = '';
      let realizedPnl = 0;

      if (activeTrade.action === 'BUY') {
          if (price >= activeTrade.takeProfit) { exited = true; exitReason = 'TP'; realizedPnl = activeTrade.takeProfit - activeTrade.entry; }
          else if (price <= activeTrade.stopLoss) { exited = true; exitReason = 'SL/TRAIL'; realizedPnl = activeTrade.stopLoss - activeTrade.entry; }
      } else {
          if (price <= activeTrade.takeProfit) { exited = true; exitReason = 'TP'; realizedPnl = activeTrade.entry - activeTrade.takeProfit; }
          else if (price >= activeTrade.stopLoss) { exited = true; exitReason = 'SL/TRAIL'; realizedPnl = activeTrade.entry - activeTrade.stopLoss; }
      }

      if (exited) {
          const tradeResult = realizedPnl * 1.0; // P&L per oz
          simulation.final_pnl += tradeResult;
          balance += tradeResult * 10; // simulate 10oz size
          if (balance > peakBalance) peakBalance = balance;
          const currentDD = (peakBalance - balance) / peakBalance * 100;
          if (currentDD > maxDD) maxDD = currentDD;

          simulation.executed_trades.push({
              ...activeTrade,
              exitTime: log.time,
              exitPrice: price,
              exitReason,
              realizedPnl: tradeResult.toFixed(2)
          });
          if (realizedPnl > 0) simulation.risk_summary.wins++; else simulation.risk_summary.losses++;
          activeTrade = null;
      }
      continue; // Don't entry while trade is active
    }

    // ── 2. Re-simulate Signal Generation with v1.3 Logic ─────────────────────
    const indicators = {
      currEMA20: log.ema20, currEMA50: log.ema50,
      prevEMA20: log.dbgPrevE20 || log.ema20, prevEMA50: log.dbgPrevE50 || log.ema50,
      slopePercent: log.emaSlope, atr: log.atr,
      atrAverage: log.atrAverage, rsi: log.rsi,
      resistance: log.resistance, support: log.support,
      trend1h: log.trend1h, lastCandle: { close: log.goldPrice, open: log.goldPrice, time: log.time },
      ema20arr: [log.dbgPrevE20, log.ema20].filter(Boolean), 
      ema50arr: [log.dbgPrevE50, log.ema50].filter(Boolean),
    };

    // Need minimal candle data for momentum simulation
    // Since we don't have 1m candles in historic logs, we assume momentum is OK if it was 
    // already okay OR if we are re-simulating a signal that was blocked by RSI/Score only.
    const mockCandles1m = [{ close: 10, open: 5, high: 12, low: 4 }, { close: 10, open: 5, high: 12, low: 4 }, { close: 11, open: 5, high: 12, low: 4 }]; 
    
    const { signal, debug } = generateSignal(indicators, mockCandles1m);

    if (signal) {
       // Check if this was a missed trade (old log said NONE)
       if (log.signalDetected === 'NONE') {
           simulation.missed_trades.push({
               time: log.time,
               action: signal.action,
               reason: log.dbgRejectReason || log.reason,
               potentialCapture: 'SUCCESS_IN_SIM'
           });
       }

       activeTrade = {
           time: log.time,
           action: signal.action,
           entry: signal.entryPrice,
           stopLoss: signal.stopLoss,
           takeProfit: signal.takeProfit,
           atr: signal.atr,
           trailingUpdates: 0
       };
       simulation.risk_summary.total_trades++;
    } else if (log.signalDetected !== 'NONE') {
        // Unexpected rejection in simulation that was accepted in reality?
        // (Unlikely since v1.3 is more relaxed)
    }
  }

  simulation.risk_summary.max_drawdown = maxDD.toFixed(2) + '%';
  simulation.risk_summary.win_rate = ((simulation.risk_summary.wins / (simulation.risk_summary.total_trades || 1)) * 100).toFixed(1) + '%';
  
  console.log(JSON.stringify(simulation, null, 2));
  fs.writeFileSync('simulation_results.json', JSON.stringify(simulation, null, 2));
}

runSimulation().catch(console.error);
