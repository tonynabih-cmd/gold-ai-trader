// monitor.js — Heartbeat, Telegram alerts, and performance auto-checks.
// sendAlert() is fire-and-forget — never throws, never blocks the main pipeline.

import { saveState } from './state.js';

export async function sendAlert(message) {
  try {
    // Always log to Vercel console (visible in Vercel dashboard → Functions → Logs)
    console.log(`ALERT: ${message}`);

    // Telegram alerts — instant phone notifications, no domain/email setup needed
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;

    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id:    process.env.TELEGRAM_CHAT_ID,
          text:       message,
        }),
      }
    );
  } catch (err) {
    // Never let alert failure crash the bot
    console.error('Alert send error:', err.message);
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
    const executedTrades = logs.filter(t => t.tradeExecuted === true);
    if (executedTrades.length === 0) return;

    // Only fire at every 50th executed trade
    if (executedTrades.length % 50 !== 0) return;

    // Derive P&L from consecutive balance snapshots in the log.
    // NOTE: This is an approximation — each log entry records the balance at that point.
    // Balance changes between consecutive executed trades represent trade P&L.
    // This will be replaced with per-trade profit logging after 100 demo trades.
    const balanceLogs = executedTrades.filter(t => t.balance != null);
    let grossProfit = 0;
    let grossLoss   = 0;
    let wins        = 0;
    let losses      = 0;

    for (let i = 1; i < balanceLogs.length; i++) {
      const pnl = parseFloat(balanceLogs[i].balance) - parseFloat(balanceLogs[i - 1].balance);
      if (pnl > 0)       { grossProfit += pnl;            wins++;   }
      else if (pnl < 0)  { grossLoss   += Math.abs(pnl);  losses++; }
      // pnl === 0: flat trade, ignore
    }

    // Need at least one win and one loss to compute meaningful profit factor
    if (grossLoss === 0) {
      await sendAlert(
        `📊 Performance after ${executedTrades.length} trades:\n` +
        `All wins so far — profit factor cannot be computed yet (no losses)\n` +
        `Balance: $${parseFloat(botState.balance).toFixed(2)}`
      );
      return;
    }

    const profitFactor = grossProfit / grossLoss;
    const winRate      = (wins + losses) > 0
      ? ((wins / (wins + losses)) * 100).toFixed(1)
      : '0.0';

    await sendAlert(
      `📊 Performance after ${executedTrades.length} trades:\n` +
      `Win rate: ${winRate}%\n` +
      `Profit factor: ${profitFactor.toFixed(2)}\n` +
      `Gross profit: $${grossProfit.toFixed(2)} | Gross loss: $${grossLoss.toFixed(2)}\n` +
      `Balance: $${parseFloat(botState.balance).toFixed(2)}`
    );

    // Auto-pause if profit factor drops below 1.1 (losing system)
    if (profitFactor < 1.1) {
      botState.botEnabled = false;
      await saveState(botState);
      await sendAlert(
        `⚠️ Bot PAUSED: Profit factor ${profitFactor.toFixed(2)} is below 1.1 threshold.\n` +
        `Review performance before re-enabling via Vercel → bot_state → botEnabled: true`
      );
    }

    // Auto-disable if drawdown exceeds 30%
    const drawdown = parseFloat(botState.totalDrawdown);
    if (drawdown > 30) {
      botState.botEnabled = false;
      await saveState(botState);
      await sendAlert(
        `🚨 Bot DISABLED: Drawdown ${drawdown.toFixed(2)}% exceeded 30% limit.\n` +
        `Account review required before re-enabling.`
      );
    }

  } catch (err) {
    console.error('checkPerformance error:', err.message);
  }
}
