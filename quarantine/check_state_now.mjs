import fs from 'fs';
import { Redis } from '@upstash/redis';

// Load .env.local
const envFile = fs.readFileSync('.env.local', 'utf8');
const envLines = envFile.split('\n');
envLines.forEach(line => {
  const match = line.match(/^([^#\s=]+)="?([^"\n\r]*)"?/);
  if (match) {
    process.env[match[1]] = match[2];
  }
});

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  const state = await redis.get('bot_state');
  console.log('--- CURRENT BOT STATE ---');
  if (!state) {
    console.log('No state found for key "bot_state"');
  } else {
    // Only print relevant fields to avoid cluttering terminal
    const summary = {
      botEnabled: state.botEnabled,
      stateIntegrityOk: state.stateIntegrityOk,
      criticalFailure: state.criticalFailure,
      criticalFailureReason: state.criticalFailureReason,
      dailyTrades: state.dailyTrades,
      dailyLoss: state.dailyLoss,
      balance: state.balance,
      equity: state.equity,
      peakBalance: state.peakBalance,
      openTrades: state.openTrades?.length || 0,
      totalDrawdown: state.totalDrawdown,
      lastTradingDay: state.lastTradingDay,
      lastHeartbeatUAE: new Date(state.lastHeartbeat || 0).toLocaleString('en-US', { timeZone: 'Asia/Dubai' }),
      stateVersion: state.stateVersion
    };
    console.log(JSON.stringify(summary, null, 2));
  }
}

main().catch(console.error);
