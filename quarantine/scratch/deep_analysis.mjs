import { Redis } from '@upstash/redis';
import fs from 'fs';

async function main() {
  const env = fs.readFileSync('.env.local', 'utf-8');
  env.split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const val = parts.slice(1).join('=').trim().replace(/"/g, '');
      if (key) process.env[key] = val;
    }
  });

  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  const rawLogs = await redis.lrange('trade_logs_list', -10000, -1);
  const logs = rawLogs.map(l => typeof l === 'string' ? JSON.parse(l) : l).filter(l => l);
  
  // Filter for last 48 hours
  const cutoff = new Date('2026-04-09T00:00:00Z').getTime();
  const recentLogs = logs.filter(l => new Date(l.time).getTime() >= cutoff);

  console.log(`Analyzing ${recentLogs.length} logs from Apr 9 to Apr 11.`);

  let missedPullbacks = [];
  let blockedBy429 = [];
  let prevGoldPrice = null;

  for (let i = 0; i < recentLogs.length; i++) {
      const log = recentLogs[i];
      if (log.reason && log.reason.includes('429') || log.reason?.includes('Too Many Requests') || log.reason?.includes('Capital.com auth failed')) {
          blockedBy429.push(log);
      }
      
      if (log.dbgRejectReason && log.dbgRejectReason.includes('pullback: price not close enough to EMA20')) {
          // Look ahead to see if it would have been profitable
          let maxFavorable = log.goldPrice;
          let maxAdverse = log.goldPrice;
          const entryPrice = log.goldPrice;
          const isBuy = !log.dbgRejectReason.includes('SELL'); // Approximation
          
          for (let j = i + 1; j < Math.min(i + 60, recentLogs.length); j++) {
              const futurePrice = recentLogs[j].goldPrice;
              if (!futurePrice) continue;
              if (isBuy) {
                  maxFavorable = Math.max(maxFavorable, futurePrice);
                  maxAdverse = Math.min(maxAdverse, futurePrice);
              } else {
                  maxFavorable = Math.min(maxFavorable, futurePrice);
                  maxAdverse = Math.max(maxAdverse, futurePrice);
              }
          }
          
          missedPullbacks.push({
              time: log.time,
              price: entryPrice,
              rejectStr: log.dbgRejectReason,
              dist: parseFloat(log.dbgRejectReason.match(/dist ([\d\.]+)/)?.[1] || 0),
              threshold: parseFloat(log.dbgRejectReason.match(/threshold ([\d\.]+)/)?.[1] || 0),
              atr: log.atr,
              isBuy,
              maxFavorableMove: isBuy ? maxFavorable - entryPrice : entryPrice - maxFavorable,
              maxAdverseMove: isBuy ? entryPrice - maxAdverse : maxAdverse - entryPrice,
          });
      }
  }

  console.log(`429 Errors: ${blockedBy429.length}`);
  
  // Group 429s by hour
  const hours429 = {};
  blockedBy429.forEach(l => {
      const hr = new Date(l.time).toISOString().substring(0, 13);
      hours429[hr] = (hours429[hr] || 0) + 1;
  });
  console.log('429s per hour:', hours429);

  // Analyze Pullbacks
  console.log(`\nMissed Pullback Trades: ${missedPullbacks.length}`);
  const goodMisses = missedPullbacks.filter(m => m.maxFavorableMove > m.atr * 1.0);
  console.log(`Valid Missed Trades (Favorable > 1.0 ATR): ${goodMisses.length}`);
  
  // Show top 5 missed
  const topMissed = [...goodMisses].sort((a,b) => b.maxFavorableMove - a.maxFavorableMove).slice(0, 5);
  topMissed.forEach(m => {
      console.log(`  [${m.time}] Entry @ ${m.price}. Favorable: +$${m.maxFavorableMove.toFixed(2)}. Adverse: -$${m.maxAdverseMove.toFixed(2)}. Dist: ${m.dist}, Threshold: ${m.threshold}, ATR: ${m.atr.toFixed(2)}`);
  });

  // Risk Sizing Math Analysis
  console.log(`\n--- RISK VS GROWTH ---`);
  const balanceAED = 196;
  const balanceUSD = balanceAED / 3.6725; // ~ 53.37
  const defaultStopDistance = 4; // Approx $4 gold move
  
  [1, 2, 3].forEach(pct => {
      const riskAmountUSD = balanceUSD * (pct / 100);
      const idealSize = riskAmountUSD / defaultStopDistance;
      const actualSize = Math.max(0.01, Math.min(idealSize, 1.0));
      const actualRiskUSD = actualSize * defaultStopDistance;
      const marginReqUSD = (actualSize * 2300) * 0.05; // Notional * 5% margin roughly at gold=2300
      
      console.log(`${pct}% Risk ($${riskAmountUSD.toFixed(2)} target) -> Size: ${actualSize.toFixed(3)} oz. Actual Risk: $${actualRiskUSD.toFixed(2)} | Margin: $${marginReqUSD.toFixed(2)}`);
  });

}

main().catch(console.error);
