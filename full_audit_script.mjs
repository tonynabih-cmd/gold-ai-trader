import { Redis } from '@upstash/redis';
import fs from 'fs';
import { getCapitalSession } from './lib/session.js';
import { fetchWithTimeout } from './lib/fetch.js';

// Load .env.local
try {
  const env = fs.readFileSync('.env.local', 'utf-8');
  env.split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const val = parts.slice(1).join('=').trim().replace(/"/g, '');
      process.env[key] = val;
    }
  });
} catch (e) {
  console.log('No .env.local found, using process.env');
}

const redis = new Redis({
  url:   'https://well-hawk-71664.upstash.io',
  token: 'gQAAAAAAARfwAAIncDE5Y2Y4MTg0MWZlN2E0ZTMxYjdkYjZlZGNlODgyNTJiZXAxNzE2NjQ',
});

async function main() {
  const report = {
    summary: {
      today: { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0 },
      week:  { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0 },
      month: { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0 },
      overall: { profitFactor: 0, maxDrawdown: 0 }
    },
    trades: [],
    rejections: {},
    strategy: {
      avgAtr: 0,
      avgScore: 0,
      pullbacks: 0,
      crossovers: 0,
    },
    timing: {
      duplicates: 0,
      delays: 0
    }
  };

  try {
    // 1. Fetch Redis Logs (Today)
    console.log('Fetching Redis logs...');
    const rawLogs = await redis.lrange('trade_logs_list', 0, -1);
    const logs = rawLogs.map(e => typeof e === 'string' ? JSON.parse(e) : e).filter(l => l !== null);
    
    // 2. Fetch Broker History (Month)
    console.log('Fetching Broker history...');
    const session = await getCapitalSession();
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1)); // Monday
    weekStart.setHours(0,0,0,0);

    const historyUrl = `${session.baseUrl}/api/v1/history/transactions?from=${monthStart.toISOString().split('.')[0]}`;
    const hRes = await fetchWithTimeout(historyUrl, {
        headers: {
            'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
            'CST': session.cst,
            'X-SECURITY-TOKEN': session.securityToken,
        }
    });
    const hData = await hRes.json();
    const transactions = hData.transactions || [];
    const goldTx = transactions.filter(t => t.instrumentName?.includes('GOLD'));

    // 3. Process Broker History for Summary
    const todayStr = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const weekStr = weekStart.toISOString().slice(0, 10);

    let grossProfit = 0;
    let grossLoss = 0;

    goldTx.forEach(t => {
        const pnl = parseFloat(t.profitAndLoss || 0);
        const date = new Date(t.date);
        const dateUAE = new Date(date.getTime() + 4 * 60 * 60 * 1000);
        const dateStr = dateUAE.toISOString().slice(0, 10);

        if (pnl > 0.001) grossProfit += pnl;
        if (pnl < -0.001) grossLoss += Math.abs(pnl);

        // Month
        report.summary.month.trades++;
        report.summary.month.pnl += pnl;
        if (pnl > 0.001) report.summary.month.wins++;
        else if (pnl < -0.001) report.summary.month.losses++;

        // Week
        if (date >= weekStart) {
            report.summary.week.trades++;
            report.summary.week.pnl += pnl;
            if (pnl > 0.001) report.summary.week.wins++;
            else if (pnl < -0.001) report.summary.week.losses++;
        }

        // Today
        if (dateStr === todayStr) {
            report.summary.today.trades++;
            report.summary.today.pnl += pnl;
            if (pnl > 0.001) report.summary.today.wins++;
            else if (pnl < -0.001) report.summary.today.losses++;
        }
    });

    report.summary.month.winRate = (report.summary.month.wins / (report.summary.month.wins + report.summary.month.losses)) * 100 || 0;
    report.summary.week.winRate = (report.summary.week.wins / (report.summary.week.wins + report.summary.week.losses)) * 100 || 0;
    report.summary.today.winRate = (report.summary.today.wins / (report.summary.today.wins + report.summary.today.losses)) * 100 || 0;
    report.summary.overall.profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);

    // 4. Process Logs for Details & Strategy
    console.log('Processing logs for details...');
    const executedLogs = logs.filter(l => l.tradeExecuted);
    const closureLogs = logs.filter(l => l.reason && l.reason.startsWith('CLOSED:'));

    executedLogs.forEach(l => {
        const trade = {
            time: l.timeUAE,
            type: l.signalDetected,
            entry: l.entryPrice,
            sl: l.stopLoss,
            tp: l.takeProfit,
            size: l.size,
            reason: l.dbgEntryType || 'Unknown',
            ema20: l.ema20,
            ema50: l.ema50,
            slope: l.emaSlope,
            atr: l.atr,
            rsi: l.rsi,
            score: l.score,
            status: 'OPEN'
        };

        // Find closure
        const closure = closureLogs.find(c => c.reason.includes(l.dealReference) || c.reason.includes(String(l.tradeId)));
        if (closure) {
            trade.status = 'CLOSED';
            const pnlMatch = closure.reason.match(/Realized P&L: \$(-?\d+\.\d+)/);
            trade.pnl = pnlMatch ? parseFloat(pnlMatch[1]) : 0;
            trade.exitPrice = closure.goldPrice;
            trade.closureReason = closure.reason.split('|')[0].replace('CLOSED: ', '').trim();
            
            const start = new Date(l.time);
            const end = new Date(closure.time);
            const diffMin = Math.floor((end - start) / 60000);
            trade.duration = `${diffMin}m`;
        }

        report.trades.push(trade);

        if (l.dbgEntryType === 'pullback') report.strategy.pullbacks++;
        if (l.dbgEntryType === 'crossover') report.strategy.crossovers++;
        report.strategy.avgAtr += l.atr;
        report.strategy.avgScore += (l.score || 0);
    });

    if (executedLogs.length > 0) {
        report.strategy.avgAtr /= executedLogs.length;
        report.strategy.avgScore /= executedLogs.length;
    }

    // 5. Analyze Rejections
    const signalFailures = logs.filter(l => l.signalDetected !== 'NONE' && !l.tradeExecuted);
    signalFailures.forEach(l => {
        const r = l.reason || l.dbgRejectReason || 'Unknown';
        report.rejections[r] = (report.rejections[r] || 0) + 1;
    });

    // 6. Timing and Cron
    const times = logs.map(l => new Date(l.time).getTime());
    for (let i = 0; i < times.length - 1; i++) {
        if (times[i+1] === times[i]) report.timing.duplicates++;
    }

    // Output raw report for processing
    console.log('--- REPORT DATA START ---');
    console.log(JSON.stringify(report, null, 2));
    console.log('--- REPORT DATA END ---');

  } catch (err) {
    console.error('Error during report generation:', err.stack);
  }
}

main();
