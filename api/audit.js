import { getLogs } from './logger.js';
import { loadState } from './state.js';
import { sendAlert } from './monitor.js';

export default async function handler(req, res) {
  try {
    const logs = await getLogs();
    const botState = await loadState();

    if (logs.length === 0) {
      return res.json({ message: 'No trades to audit today' });
    }

    // Get today's logs only
    const today = new Date().toISOString().slice(0, 10);
    const todayLogs = logs.filter(l => l.time.startsWith(today));

    if (todayLogs.length === 0) {
      return res.json({ message: 'No trades today to audit' });
    }

    // Build summary for Claude
    const tradeSummary = todayLogs.map(l =>
      `Time: ${l.timeUAE} | Signal: ${l.signalDetected} | Executed: ${l.tradeExecuted} | Reason: ${l.reason || 'TRADED'} | EMA20: ${l.ema20?.toFixed(2)} | EMA50: ${l.ema50?.toFixed(2)} | ATR: ${l.atr?.toFixed(2)} | RSI: ${l.rsi?.toFixed(0)} | Score: ${l.score}`
    ).join('\n');

    // Call Claude for audit
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
          content: `You are auditing a gold trading bot. Review today's decisions and provide a brief analysis.

Today's trade log:
${tradeSummary}

Current state:
- Balance: $${botState.balance}
- Daily trades: ${botState.dailyTrades}
- Daily loss: $${botState.dailyLoss}
- Total drawdown: ${botState.totalDrawdown}%
- Open trades: ${botState.openTrades?.length || 0}

Please analyze:
1. Were EMA crossover rules followed correctly?
2. Were skips legitimate?
3. Any anomalies or concerns?
4. Performance summary
5. Recommendation for tomorrow

Keep it concise - max 200 words.`
        }]
      })
    });

    const data = await response.json();
    const auditReport = data.content[0].text;

    // Save audit report
    const { Redis } = await import('@upstash/redis');
    const redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });

    await redis.set('last_audit', {
      date: today,
      report: auditReport,
      totalDecisions: todayLogs.length,
      tradesExecuted: todayLogs.filter(l => l.tradeExecuted).length,
      skips: todayLogs.filter(l => !l.tradeExecuted).length,
    });

    await sendAlert(`📋 Daily Audit Complete:\n${auditReport}`);

    return res.json({
      success: true,
      report: auditReport,
      totalDecisions: todayLogs.length,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
