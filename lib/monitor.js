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



export async function checkPerformance(logs, botState) {
  try {
    const executedTrades = logs.filter(t => t.tradeExecuted === true);
    if (executedTrades.length === 0) return;

    // Use broker-synced gross P&L (immune to balance deposits/withdrawals)
    const grossProfitVal = parseFloat(botState.brokerGrossProfit) || 0;
    const grossLossVal   = Math.abs(parseFloat(botState.brokerGrossLoss)) || 0;

    // Safety checks — run EVERY cycle if we have enough trades to be meaningful
    if (executedTrades.length >= 5) {
      const drawdownHardLimit = 20; // 20% hard drawdown limit
      const pfThreshold = 1.1;

      if (grossLossVal > 0) {
        const profitFactor = grossProfitVal / grossLossVal;
        if (profitFactor < pfThreshold) {
          botState.botEnabled = false;
          await saveState(botState);
          await sendAlert(
            `⚠️ Bot PAUSED: Profit factor ${profitFactor.toFixed(2)} < ${pfThreshold}.\n` +
            `Performance review required before live trading continues.`
          );
        }
      }

      const drawdown = parseFloat(botState.totalDrawdown);
      if (drawdown >= drawdownHardLimit) {
        botState.botEnabled = false;
        await saveState(botState);
        await sendAlert(
          `🚨 Bot DISABLED: Drawdown ${drawdown.toFixed(2)}% hit ${drawdownHardLimit}% limit.\n` +
          `Account review required before re-enabling.`
        );
      }
    }

    // Status updates — Trigger every 50 trades
    if (executedTrades.length % 50 !== 0) return;

    if (grossLossVal === 0) {
      await sendAlert(
        `📊 Performance Update (${executedTrades.length} trades):\n` +
        `All winning streak! No realized losses yet over the last 30 days.\n` +
        `Gross Profit: $${grossProfitVal.toFixed(2)} | Balance: AED ${parseFloat(botState.balance).toFixed(2)}`
      );
      return;
    }

    const profitFactor = grossProfitVal / grossLossVal;
    
    await sendAlert(
      `📊 Broker-Synched Performance (${executedTrades.length} trades):\n` +
      `Profit Factor: ${profitFactor.toFixed(2)} (Last 30 days)\n` +
      `Win Rate: ${botState.brokerWinRate ?? '0'}%\n` +
      `Gross Profit: $${grossProfitVal.toFixed(2)} | Gross Loss: $${grossLossVal.toFixed(2)}\n` +
      `Balance: AED ${parseFloat(botState.balance).toFixed(2)}`
    );

  } catch (err) {
    console.error('checkPerformance error:', err.message);
  }
}
