import './load_env.js';
import { getLogs } from './lib/logger.js';

const USD_AED_PEG = 3.6725;

async function runAudit() {
  console.log('Fetching logs for comprehensive audit...');
  const logs = await getLogs();
  if (!logs || logs.length === 0) {
    console.log('No logs found.');
    return;
  }

  const trades = new Map();
  const violations = [];
  const stats = {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    totalProfit: 0,
    totalLoss: 0,
    maxDrawdown: 0,
    maxDailyLoss: 0,
  };

  // Group logs by trade session (dealReference)
  logs.forEach(log => {
    const ref = log.dealReference || log.tradeId;
    if (ref && ref !== 'NO_SIGNAL') {
      if (!trades.has(ref)) trades.set(ref, []);
      trades.get(ref).push(log);
    }
  });

  console.log(`Analyzing ${trades.size} individual trade sessions...`);

  // Track daily P&L and other stats
  const dailyPnl = new Map(); // Date string -> P&L
  let peakBalance = 0;
  let concurrentTrades = 0;

  // Process logs chronologically to check sequence and risk rules
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    const balance = parseFloat(log.balance) || 0;
    if (balance > peakBalance) peakBalance = balance;

    // Check Drawdown Accuracy
    if (peakBalance > 0) {
      const calculatedDrawdown = parseFloat(((peakBalance - balance) / peakBalance * 100).toFixed(2));
      const reportedDrawdown = parseFloat(log.totalDrawdown) || 0;
      if (Math.abs(calculatedDrawdown - reportedDrawdown) > 0.05 && balance < peakBalance) {
        violations.push({
          type: 'DRAWDOWN_MISMATCH',
          time: log.timeUAE,
          message: `Calculated: ${calculatedDrawdown}%, Reported: ${reportedDrawdown}%`
        });
      }
      if (calculatedDrawdown > stats.maxDrawdown) stats.maxDrawdown = calculatedDrawdown;
    }

    // Check Position Limits
    if (log.tradeExecuted) {
      const openPositions = parseInt(log.openPositions) || 0;
      if (openPositions > 2) {
        violations.push({
          type: 'POSITION_LIMIT_EXCEEDED',
          time: log.timeUAE,
          message: `Open trades: ${openPositions} (Limit: 2)`
        });
      }
    }

    // Check Duplicate Signal IDs
    if (log.tradeExecuted && i > 0) {
        const prevLogs = logs.slice(Math.max(0, i - 10), i);
        if (prevLogs.some(pl => pl.tradeId === log.tradeId && pl.tradeExecuted)) {
            violations.push({
                type: 'DUPLICATE_SIGNAL_ID',
                time: log.timeUAE,
                message: `Signal ID ${log.tradeId} executed multiple times.`
            });
        }
    }

    // Check Risk per Trade (Rule 15/Rule 19 logic)
    if (log.tradeExecuted && log.entryPrice && log.stopLoss && log.balance) {
      const stopDistance = Math.abs(log.entryPrice - log.stopLoss);
      const riskRatio = (stopDistance * (parseFloat(log.size) || 0) * USD_AED_PEG) / balance;
      if (riskRatio > 0.021) { // 2% + small buffer for rounding
        violations.push({
          type: 'EXCESSIVE_RISK',
          time: log.timeUAE,
          message: `Risk: ${(riskRatio * 100).toFixed(2)}% of balance (Limit: 2%)`
        });
      }
    }
  }

  // Analyze individual trades for math correctness
  trades.forEach((sessionLogs, ref) => {
    const entry = sessionLogs.find(l => l.tradeExecuted);
    const closure = sessionLogs.find(l => l.reason?.includes('CLOSED') || l.reason?.includes('HIT'));
    
    if (entry && closure) {
      stats.totalTrades++;
      const direction = entry.signalDetected; // BUY or SELL
      const entryPrice = parseFloat(entry.entryPrice);
      const exitPrice = parseFloat(closure.goldPrice) || parseFloat(closure.indicators?.lastCandle?.close);
      const size = parseFloat(entry.size);
      
      if (!entryPrice || !exitPrice || !size) return;

      // TRADE MATH
      let pnlUSD = 0;
      if (direction === 'BUY') {
        pnlUSD = (exitPrice - entryPrice) * size;
      } else {
        pnlUSD = (entryPrice - exitPrice) * size;
      }
      
      const pnlAED = parseFloat((pnlUSD * USD_AED_PEG).toFixed(2));
      const reportedPnl = parseFloat(closure.result?.realizedPnl) || 0;

      if (reportedPnl !== 0 && Math.abs(pnlAED - reportedPnl) > 0.5) {
        violations.push({
          type: 'PNL_MATH_ERROR',
          tradeId: ref,
          message: `Calculated P&L: ${pnlAED} AED, Reported P&L: ${reportedPnl} AED`
        });
      }

      if (pnlAED > 0) {
        stats.wins++;
        stats.totalProfit += pnlAED;
      } else {
        stats.losses++;
        stats.totalLoss += Math.abs(pnlAED);
      }

      // Risk-Reward Ratio
      const stopDistance = Math.abs(entryPrice - parseFloat(entry.stopLoss));
      const targetDistance = Math.abs(parseFloat(entry.takeProfit) - entryPrice);
      const rr = targetDistance / stopDistance;
      const actualRR = Math.abs(exitPrice - entryPrice) / stopDistance;
      
      // If the trade was closed early not by SL/TP, actual RR might differ from planned RR.
      // But we can still flag if planned RR is suspicious (e.g. < 1)
      if (rr < 1) {
          violations.push({
              type: 'LOW_RR_RATIO',
              tradeId: ref,
              message: `Planned R:R: ${rr.toFixed(2)}`
          });
      }
    }
  });

  const winRate = stats.totalTrades > 0 ? (stats.wins / stats.totalTrades * 100).toFixed(2) : 0;
  const profitFactor = stats.totalLoss > 0 ? (stats.totalProfit / stats.totalLoss).toFixed(2) : 'Infinity';

  console.log('\n--- AUDIT SUMMARY ---');
  console.log(`Total Trades: ${stats.totalTrades}`);
  console.log(`Win Rate:     ${winRate}%`);
  console.log(`Profit Factor: ${profitFactor}`);
  console.log(`Max Drawdown:  ${stats.maxDrawdown}%`);
  console.log(`Total Profit:  AED ${stats.totalProfit.toFixed(2)}`);
  console.log(`Total Loss:    AED ${stats.totalLoss.toFixed(2)}`);
  
  if (violations.length > 0) {
    console.log('\n--- VIOLATIONS DETECTED ---');
    violations.forEach(v => {
      console.log(`[${v.type}] ${v.time || v.tradeId}: ${v.message}`);
    });
  } else {
    console.log('\n✅ No major risk or math violations detected.');
  }
}

runAudit().catch(console.error);
