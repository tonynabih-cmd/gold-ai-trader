import { saveState } from './state.js';

const ALERT_EMAIL = process.env.ALERT_EMAIL;

export async function sendAlert(message) {
  try {
    console.log(`ALERT: ${message}`);
    // Email alerts via Vercel environment
    // Add email service here if needed (SendGrid, Resend, etc.)
  } catch (err) {
    console.error('Alert error:', err.message);
  }
}

export async function heartbeat(botState) {
  try {
    botState.lastHeartbeat = Date.now();
    await saveState(botState);
  } catch (err) {
    console.error('Heartbeat error:', err.message);
  }
}

export async function checkPerformance(logs, botState) {
  try {
    const closedTrades = logs.filter(t => t.tradeExecuted && t.result);

    if (closedTrades.length === 0) return;
    if (closedTrades.length % 50 !== 0) return;

    const wins = closedTrades.filter(t => t.profit > 0);
    const losses = closedTrades.filter(t => t.profit <= 0);

    const grossProfit = wins.reduce((s, t) => s + t.profit, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.profit, 0));

    if (grossLoss === 0) return;

    const profitFactor = grossProfit / grossLoss;
    const winRate = (wins.length / closedTrades.length * 100).toFixed(1);

    await sendAlert(
      `📊 Performance check after ${closedTrades.length} trades:\n` +
      `Win rate: ${winRate}%\n` +
      `Profit factor: ${profitFactor.toFixed(2)}\n` +
      `Balance: $${botState.balance}`
    );

    if (profitFactor < 1.1) {
      botState.botEnabled = false;
      await saveState(botState);
      await sendAlert(`⚠️ Profit factor ${profitFactor.toFixed(2)} below 1.1 - bot paused`);
    }

    // Max drawdown check
    const drawdown = parseFloat(botState.totalDrawdown);
    if (drawdown > 30) {
      botState.botEnabled = false;
      await saveState(botState);
      await sendAlert(`🚨 Drawdown ${drawdown}% exceeded 30% - bot disabled`);
    }

  } catch (err) {
    console.error('Performance check error:', err.message);
  }
}
