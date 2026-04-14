import { Redis } from '@upstash/redis';
import fs from 'fs';

const RISK_1 = 0.01;
const RISK_2 = 0.02;
const BALANCE_USD = 196 / 3.6725; // 53.37

async function main() {
  const env = fs.readFileSync('.env.local', 'utf-8');
  env.split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length >= 2) {
      if (parts[0].trim()) process.env[parts[0].trim()] = parts.slice(1).join('=').trim().replace(/"/g, '');
    }
  });

  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  // Pull deeper history if possible to get robust stats
  const rawLogs = await redis.lrange('trade_logs_list', -5000, -1);
  const logs = rawLogs.map(l => typeof l === 'string' ? JSON.parse(l) : l).filter(l => l && l.goldPrice);
  
  if (logs.length === 0) {
      console.log("No logs loaded."); return;
  }

  const multipliers = [1.0, 1.3, 1.6];
  const results = {};

  multipliers.forEach(mult => {
      let balance1 = BALANCE_USD;
      let balance2 = BALANCE_USD;
      let peak1 = BALANCE_USD;
      let peak2 = BALANCE_USD;
      let maxDrawdown1 = 0;
      let maxDrawdown2 = 0;
      let currentStreak = 0;
      let worstStreak = 0;
      
      let wins = 0;
      let losses = 0;
      let breakEven = 0;
      let totalDist = 0;
      let distCount = 0;
      
      let inTrade = false;
      let tradeDir = null;
      let entryPrice = 0;
      let currentAtr = 0;
      let sl = 0;
      let tp = 0;

      for (let i = 0; i < logs.length; i++) {
          const log = logs[i];
          
          if (inTrade) {
              const currentPrice = log.goldPrice;
              let closed = false;
              let isWin = false;
              let isBE = false;
              
              const beTrigger = entryPrice + (tradeDir === 'BUY' ? currentAtr : -currentAtr);
              
              if (tradeDir === 'BUY') {
                  if (currentPrice >= tp) { isWin = true; closed = true; }
                  else if (currentPrice <= sl) { closed = true; }
              } else {
                  if (currentPrice <= tp) { isWin = true; closed = true; }
                  else if (currentPrice >= sl) { closed = true; }
              }
              
              if (closed) {
                  inTrade = false;
                  // Calculate risk size for that trade
                  const riskAmt1 = balance1 * RISK_1;
                  const riskAmt2 = balance2 * RISK_2;
                  const stopDistance = Math.abs(entryPrice - sl);
                  
                  // Limit by capital min
                  const size1 = Math.max(0.01, riskAmt1 / stopDistance);
                  const size2 = Math.max(0.01, riskAmt2 / stopDistance);
                  
                  // Actual $ amount won/lost based on pure distance
                  const distMoved = isWin ? Math.abs(tp - entryPrice) : Math.abs(sl - entryPrice);
                  
                  if (isWin) {
                      wins++;
                      currentStreak = 0;
                      // Reward ratio usually 2.5
                      balance1 += (size1 * distMoved);
                      balance2 += (size2 * distMoved);
                  } else {
                      losses++;
                      currentStreak++;
                      if (currentStreak > worstStreak) worstStreak = currentStreak;
                      balance1 -= (size1 * distMoved);
                      balance2 -= (size2 * distMoved);
                  }
                  
                  if (balance1 > peak1) peak1 = balance1;
                  if (balance2 > peak2) peak2 = balance2;
                  
                  const dd1 = (peak1 - balance1) / peak1;
                  const dd2 = (peak2 - balance2) / peak2;
                  if (dd1 > maxDrawdown1) maxDrawdown1 = dd1;
                  if (dd2 > maxDrawdown2) maxDrawdown2 = dd2;
              }
              continue; // skip evaluating entries while in trade
          }
          
          // Strategy Evaluation (Pullback Logic Proxy)
          const distToEma = log.dbgDistToEMA20;
          const slope = log.emaSlope;
          
          if (distToEma == null || slope == null || log.atr == null) continue;
          
          const isUptrend = slope >= 0.05;
          const isDowntrend = slope <= -0.05;
          const allowedDist = log.atr * mult;
          
          if ((isUptrend || isDowntrend) && distToEma <= allowedDist) {
              // Ensure we aren't constantly entering. 
              // Needs momentum confirmation approximate
              if (log.dbg1mMomentumNet != null) {
                  const bullishMom = isUptrend && log.dbg1mMomentumNet > 0;
                  const bearishMom = isDowntrend && log.dbg1mMomentumNet < 0;
                  
                  if (bullishMom || bearishMom) {
                      inTrade = true;
                      tradeDir = bullishMom ? 'BUY' : 'SELL';
                      entryPrice = log.goldPrice;
                      currentAtr = log.atr;
                      sl = bullishMom ? entryPrice - (currentAtr * 1.2) : entryPrice + (currentAtr * 1.2);
                      tp = bullishMom ? entryPrice + (currentAtr * 3.0) : entryPrice - (currentAtr * 3.0);
                      
                      totalDist += distToEma;
                      distCount++;
                  }
              }
          }
      }
      
      const totalTrades = wins + losses + breakEven;
      const winRate = totalTrades > 0 ? wins / totalTrades : 0;
      
      results[mult] = {
          trades: totalTrades,
          wins,
          losses,
          winRate: (winRate * 100).toFixed(1) + '%',
          avgEntryDist: distCount > 0 ? (totalDist / distCount).toFixed(2) : '0',
          worstStreak,
          risk1: {
              finalBal: (balance1 * 3.6725).toFixed(2) + ' AED',
              maxDd: (maxDrawdown1 * 100).toFixed(1) + '%'
          },
          risk2: {
              finalBal: (balance2 * 3.6725).toFixed(2) + ' AED',
              maxDd: (maxDrawdown2 * 100).toFixed(1) + '%'
          }
      };
  });

  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
