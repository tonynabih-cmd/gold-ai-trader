import { loadState } from './lib/state.js';
import { Redis } from '@upstash/redis';

async function checkState() {
  console.log('Loading state...');
  const state = await loadState();
  
  console.log('\n--- Bot State ---');
  console.log(`Bot Enabled: ${state.botEnabled}`);
  console.log(`State Integrity OK: ${state.stateIntegrityOk}`);
  console.log(`Critical Failure: ${state.criticalFailure}`);
  if (state.criticalFailureReason) {
    console.log(`Critical Failure Reason: ${state.criticalFailureReason}`);
  }
  console.log(`Balance: ${state.balance}`);
  console.log(`Equity: ${state.equity}`);
  console.log(`Open Trades: ${state.openTrades.length}`);
  console.log(`Daily Trades: ${state.dailyTrades}`);
  console.log(`Daily Loss: ${state.dailyLoss}`);
  console.log(`Total Drawdown: ${state.totalDrawdown}%`);
  console.log(`Last Processed Candle: ${state.lastProcessedCandle}`);
  console.log(`Last Heartbeat: ${new Date(state.lastHeartbeat).toLocaleString()}`);
  
  if (state.openTrades.length > 0) {
    console.log('\n--- Open Trades ---');
    state.openTrades.forEach((t, i) => {
      console.log(`${i+1}. ${t.action} ${t.size}oz at ${t.entry} | dealId: ${t.dealId}`);
    });
  }

  if (state.recentOutcomes && state.recentOutcomes.length > 0) {
      console.log('\n--- Recent Outcomes ---');
      state.recentOutcomes.slice(-5).forEach(o => {
          console.log(`- PnL: ${o.pnl} | Action: ${o.action} | Closed At: ${new Date(o.closedAt).toLocaleString()}`);
      });
  }
}

checkState().catch(console.error);
