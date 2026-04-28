// audit.js — Daily Claude audit triggered at 9PM UAE (17:00 UTC) via GitHub Actions audit.yml.
// Claude Haiku reviews today's decisions for anomalies, rule violations, and performance.
// Cost: ~$0.01/day.

import { getLogs }          from '../lib/logger.js';
import { loadState, saveAudit } from '../lib/state.js';
import { sendAlert }        from '../lib/monitor.js';
import { fetchWithTimeout } from '../lib/fetch.js';
import { latestStrategyVersionFromLogs } from '../lib/daily_audit.js';

export default async function handler(req, res) {
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  const providedAuth = req.headers['authorization'] || req.headers['Authorization'];
  if (process.env.CRON_SECRET && providedAuth !== expectedAuth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const [logs, botState] = await Promise.all([getLogs(), loadState()]);

    if (logs.length === 0) {
      return res.json({ message: 'No logs found — nothing to audit' });
    }

    const today     = new Date().toISOString().slice(0, 10);
    const todayLogs = logs.filter(l => l.time && l.time.startsWith(today));

    if (todayLogs.length === 0) {
      return res.json({ message: `No decisions logged today (${today})` });
    }

    // Build compact summary for Claude — include all decisions including skips
    const tradeSummary = todayLogs.map(l =>
      [
        `Time: ${l.timeUAE}`,
        `Signal: ${l.signalDetected}`,
        `Type: ${l.entryType || 'N/A'}`,
        `Executed: ${l.tradeExecuted}`,
        `Reason: ${l.reason || 'TRADED'}`,
        `EMA20: ${l.ema20?.toFixed(2) ?? 'N/A'}`,
        `EMA50: ${l.ema50?.toFixed(2) ?? 'N/A'}`,
        `ATR: ${l.atr?.toFixed(2) ?? 'N/A'}`,
        `RSI: ${l.rsi?.toFixed(0) ?? 'N/A'}`,
        `Score: ${l.score ?? 'N/A'}`,
        `Spread: ${l.spread?.toFixed(2) ?? 'N/A'}`,
        `Balance: $${l.balance?.toFixed(2) ?? 'N/A'}`,
      ].join(' | ')
    ).join('\n');

    const executedToday = todayLogs.filter(l => l.tradeExecuted);
    const skipsToday    = todayLogs.filter(l => !l.tradeExecuted);

    // Call Claude Haiku for the audit
    // Use a 30s timeout — LLM responses can take 5-30s and the audit function has 60s maxDuration
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-3-haiku-20240307',
        max_tokens: 1000,
        messages: [{
          role:    'user',
          content: `You are auditing a gold (XAU) algorithmic trading bot that uses EMA 20/50 crossover strategy.

Today's complete decision log (${todayLogs.length} decisions: ${executedToday.length} trades, ${skipsToday.length} skips):

${tradeSummary}

Current account state:
- Balance: $${parseFloat(botState.balance).toFixed(2)}
- Peak balance: $${parseFloat(botState.peakBalance).toFixed(2)}
- Daily trades today: ${botState.dailyTrades}
- Daily loss today: $${parseFloat(botState.dailyLoss).toFixed(2)}
- Total drawdown: ${parseFloat(botState.totalDrawdown).toFixed(2)}%
- Open positions: ${botState.openTrades?.length ?? 0}
- Bot enabled: ${botState.botEnabled}

Please analyze (be direct and concise, max 200 words):
1. Were EMA crossover/pullback rules followed correctly?
2. Were skips legitimate? Any suspicious skip reasons?
3. Any anomalies in indicator values (ATR spike, RSI extreme, spread outliers)?
4. Performance summary for the day
5. One concrete recommendation for tomorrow

Flag any red flags clearly.`,
        }],
      }),
    }, 30000); // 30s timeout — Claude Haiku takes 5-25s for 1000-token responses; 30s adds a 5s safety buffer

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return res.status(response.status).json({ error: `Claude API error: ${errText}` });
    }

    let auditData;
    try {
      auditData = await response.json();
    } catch (e) {
      return res.status(500).json({ error: 'Invalid JSON from Claude API' });
    }
    const auditReport = auditData.content?.[0]?.text || 'Audit failed — no response from Claude';

    // Save audit result to Redis for dashboard display
    await saveAudit({
      date:           today,
      report:         auditReport,
      strategyVersion: latestStrategyVersionFromLogs(todayLogs),
      totalDecisions: todayLogs.length,
      tradesExecuted: executedToday.length,
      skips:          skipsToday.length,
      generatedAt:    new Date().toISOString(),
    });

    // Send audit report via Telegram alert
    await sendAlert(`📋 Daily Audit (${today}):\n\n${auditReport}`);

    return res.json({
      success:        true,
      date:           today,
      report:         auditReport,
      totalDecisions: todayLogs.length,
      tradesExecuted: executedToday.length,
      skips:          skipsToday.length,
    });

  } catch (err) {
    console.error('Audit error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
