import { getLogs } from '../lib/logger.js';
import { loadState } from '../lib/state.js';
import { sendAlert } from '../lib/monitor.js';
import { Redis } from '@upstash/redis';

export default async function handler(req, res) {
  try {
    const logs = await getLogs();
    const botState = await loadState();

    if (logs.length === 0) return res.json({ message: 'No trades to audit today' });

    const today = new Date().toISOString().slice(0, 10);
    const todayLogs = logs.filter(l => l.time.startsWith(today));

    if (todayLogs.length === 0) return res.json({ message: 'No trades today to audit' });

    const tradeSummary = todayLogs.map(l =>
      `Time: ${l.timeUAE} | Signal: ${l.signalDetected} | Executed: ${l.tradeExecuted} | Reason: ${l.reason || 'TRADED'} | EMA20: ${l.ema20?.toFixed(2)} | EMA50: ${l.ema50?.toFixed(2)} | ATR: ${l.atr?.toFixed(2)} | RSI: ${l.rsi?.toFixed(0)} | Score: ${l.score}`
    ).join('\n');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `You are auditing a gold trading bot. Review today's decisions and provide a brief analysis.\n\nToday's trade log:\n${tradeSummary}\n\nCurrent state:\n- Balance: $${botState.balance}\n- Daily trades: ${botState.dailyTrades}\n- Daily loss: $${botState.dailyLoss}\n- Total drawdown: ${botState.totalDrawdown}%\n- Open trades: ${botState.openTrades?.length || 0}\n\nPlease analyze:\n1. Were EMA crossover rules followed correctly?\n2. Were skips legitimate?\n3. Any anomalies or concerns?\n4. Performance summary\n5. Recommendation for tomorrow\n\nKeep it concise - max 200 words.`
        }]
      })
    });

    const data = await response.json();
    const auditReport = data.content[0].text;

    const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    await redis.set('last_audit', {
      date: today,
      report: auditReport,
      totalDecisions: todayLogs.length,
      tradesExecuted: todayLogs.filter(l => l.tradeExecuted).length,
      skips: todayLogs.filter(l => !l.tradeExecuted).length,
    });

    await sendAlert(`📋 Daily Audit Complete:\n${auditReport}`);
    return res.json({ success: true, report: auditReport, totalDecisions: todayLogs.length });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}