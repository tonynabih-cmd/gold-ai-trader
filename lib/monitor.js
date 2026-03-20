import { saveState } from './state.js';

export async function sendAlert(message) {
  try {
    console.log(`ALERT: ${message}`);

    if (!process.env.RESEND_API_KEY || !process.env.ALERT_EMAIL) return;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Gold AI Trader <alerts@yourdomain.com>',
        to: process.env.ALERT_EMAIL,
        subject: `Gold AI Trader — ${message.slice(0, 60)}`,
        text: message,
        html: `<pre style="font-family:monospace;font-size:14px;line-height:1.6">${message}</pre>`,
      }),
    });
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
    const executedTrades = logs.filter(t => t.tradeExecuted);
    if (executedTrades.length === 0) return;
    if (executedTrades.length % 50 !== 0) return;

    // Derive P&L from consecutive balance snapshots
    const balanceLogs = executedTrades.filter(t => t.balance != null);
    let grossProfit = 0;
    let grossLoss   = 0;
    let wins        = 0;
    let losses      = 0;

    for (let i = 1; i < balanceLogs.length; i++) {
      const pnl = parseFloat(balanceLogs[i].balance) - parseFloat(balanceLogs[i - 1].balance);
      if (pnl > 0) { grossProfit += pnl; wins++; }
      else         { grossLoss   += Math.abs(pnl); losses++; }
    }

    if (grossLoss === 0) return;

    const profitFactor = grossProfit / grossLoss;
    const winRate      = ((wins / (wins + losses)) * 100).toFixed(1);

    await sendAlert(
      `📊 Performance after ${executedTrades.length} trades:\n` +
      `Win rate: ${winRate}%\n` +
      `Profit factor: ${profitFactor.toFixed(2)}\n` +
      `Balance: $${botState.balance}`
    );

    if (profitFactor < 1.1) {
      botState.botEnabled = false;
      await saveState(botState);
      await sendAlert(`⚠️ Profit factor ${profitFactor.toFixed(2)} below 1.1 — bot paused`);
    }

    const drawdown = parseFloat(botState.totalDrawdown);
    if (drawdown > 30) {
      botState.botEnabled = false;
      await saveState(botState);
      await sendAlert(`🚨 Drawdown ${drawdown}% exceeded 30% — bot disabled`);
    }

  } catch (err) {
    console.error('Performance check error:', err.message);
  }
}
