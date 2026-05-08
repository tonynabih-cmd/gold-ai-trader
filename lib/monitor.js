// monitor.js — Heartbeat, Telegram alerts, and performance auto-checks.
// sendAlert() is fire-and-forget — never throws, never blocks the main pipeline.

import { saveState } from './state.js';

import { fetchWithTimeout } from './fetch.js';

export const ALERT_SEVERITY = Object.freeze({
  INFO: 'INFO',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
});

export const ALERT_COOLDOWN_MS = Object.freeze({
  INFO: 2 * 60 * 60 * 1000,
  WARNING: 30 * 60 * 1000,
  CRITICAL: 0,
});

function normalizeSeverity(severity) {
  const value = String(severity || ALERT_SEVERITY.WARNING).toUpperCase();
  return ALERT_SEVERITY[value] || ALERT_SEVERITY.WARNING;
}

function stableAlertKey(message, severity, options = {}) {
  return String(options.dedupeKey || options.id || `${severity}:${message}`).slice(0, 240);
}

function isTelegramSeverity(severity) {
  return severity === ALERT_SEVERITY.WARNING || severity === ALERT_SEVERITY.CRITICAL;
}

export function shouldDispatchAlert(botState, message, options = {}) {
  const severity = normalizeSeverity(options.severity);
  const now = Number(options.now || Date.now());
  const key = stableAlertKey(message, severity, options);
  const cooldownMs = Number(options.cooldownMs ?? ALERT_COOLDOWN_MS[severity] ?? 0);

  if (!botState || typeof botState !== 'object') {
    return {
      dispatch: true,
      severity,
      key,
      reason: 'NO_STATE',
      stateModified: false,
    };
  }

  const registry = botState.alertRegistry && typeof botState.alertRegistry === 'object'
    ? botState.alertRegistry
    : {};
  const existing = registry[key] || {};
  const lastSentAt = Number(existing.lastSentAt || 0);
  const isActive = existing.active === true;
  const sameMessage = existing.message === message;
  const withinCooldown = cooldownMs > 0 && lastSentAt > 0 && now - lastSentAt < cooldownMs;

  if (isActive && sameMessage) {
    return { dispatch: false, severity, key, reason: 'DEDUPED_ACTIVE', stateModified: false };
  }
  if (withinCooldown) {
    return { dispatch: false, severity, key, reason: 'COOLDOWN', stateModified: false };
  }

  registry[key] = {
    id: options.id || key,
    severity,
    message,
    active: true,
    firstSeenAt: existing.firstSeenAt || now,
    lastSeenAt: now,
    lastSentAt: now,
    sendCount: Number(existing.sendCount || 0) + 1,
  };
  botState.alertRegistry = registry;

  return { dispatch: true, severity, key, reason: 'DISPATCH', stateModified: true };
}

export async function sendAlert(message, options = {}) {
  try {
    const severity = normalizeSeverity(options.severity);
    let gate = { stateModified: false };

    if (options.botState) {
      gate = shouldDispatchAlert(options.botState, message, { ...options, severity });
      if (!gate.dispatch) {
        console.log(`ALERT_SUPPRESSED [${gate.severity}] ${gate.reason}: ${message}`);
        return gate;
      }
    }

    // Always log to Vercel console (visible in Vercel dashboard → Functions → Logs)
    console.log(`ALERT [${severity}]: ${message}`);

    // Telegram alerts — instant phone notifications, no domain/email setup needed
    if (!isTelegramSeverity(severity)) {
      return { sent: false, severity, telegram: false, reason: 'INFO_NOT_SENT_TO_TELEGRAM', stateModified: gate.stateModified };
    }
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
      return { sent: false, severity, telegram: false, reason: 'TELEGRAM_NOT_CONFIGURED', stateModified: gate.stateModified };
    }

    // Use fetchWithTimeout (10s) so a slow/unreachable Telegram cannot stall the pipeline
    await fetchWithTimeout(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text:    message,
        }),
      },
      10000 // 10s — generous for Telegram but won't block the cron pipeline
    );
    return { sent: true, severity, telegram: true, stateModified: gate.stateModified };
  } catch (err) {
    // Never let alert failure crash the bot
    console.error('Alert send error:', err.message);
    return { sent: false, error: err.message };
  }
}



export async function checkPerformance(logs, botState) {
  try {
    const executedTrades = logs.filter(t => t.tradeExecuted === true);
    if (executedTrades.length === 0) return;
    const numericOutcomes = (Array.isArray(botState.recentOutcomes) ? botState.recentOutcomes : [])
      .filter(t => typeof t?.pnl === 'number');
    const last10 = numericOutcomes.slice(-10);
    const last15 = numericOutcomes.slice(-15);
    let stateChanged = false;

    // Use broker-synced gross P&L (immune to balance deposits/withdrawals)
    const grossProfitVal = parseFloat(botState.brokerGrossProfit) || 0;
    const grossLossVal   = Math.abs(parseFloat(botState.brokerGrossLoss)) || 0;

    if (last10.length === 10) {
      const wins = last10.filter(t => t.pnl > 0).length;
      const rollingWinRate10 = parseFloat(((wins / 10) * 100).toFixed(2));
      if (botState.rollingWinRate10 !== rollingWinRate10) {
        botState.rollingWinRate10 = rollingWinRate10;
        stateChanged = true;
      }
    }

    if (last15.length === 15) {
      const rollingGrossProfit15 = parseFloat(last15.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0).toFixed(2));
      const rollingGrossLoss15 = parseFloat(Math.abs(last15.filter(t => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0)).toFixed(2));
      const rollingProfitFactor15 = rollingGrossLoss15 === 0
        ? (rollingGrossProfit15 > 0 ? 999 : 0)
        : parseFloat((rollingGrossProfit15 / rollingGrossLoss15).toFixed(2));

      if (botState.rollingGrossProfit15 !== rollingGrossProfit15) {
        botState.rollingGrossProfit15 = rollingGrossProfit15;
        stateChanged = true;
      }
      if (botState.rollingGrossLoss15 !== rollingGrossLoss15) {
        botState.rollingGrossLoss15 = rollingGrossLoss15;
        stateChanged = true;
      }
      if (botState.rollingProfitFactor15 !== rollingProfitFactor15) {
        botState.rollingProfitFactor15 = rollingProfitFactor15;
        stateChanged = true;
      }

      const reasons = [];
      if ((botState.rollingWinRate10 ?? 100) < 50) reasons.push(`Win Rate 10=${botState.rollingWinRate10.toFixed(2)}% < 50%`);
      if (rollingProfitFactor15 < 1) reasons.push(`PF 15=${rollingProfitFactor15.toFixed(2)} < 1.00`);
      const reviewReason = reasons.join(' | ');
      const reviewNeeded = reasons.length > 0;

      if (botState.performanceReviewNeeded !== reviewNeeded || botState.performanceReviewReason !== reviewReason) {
        botState.performanceReviewNeeded = reviewNeeded;
        botState.performanceReviewReason = reviewReason;
        stateChanged = true;
      }

      if (reviewNeeded && numericOutcomes.length === 15) {
        await sendAlert(
          `⚠️ Performance review trigger:\n` +
          `${reviewReason}\n` +
          `Re-evaluate EMA slope threshold and TP multiplier before scaling risk.`
        );
      }
    }

    if (stateChanged) {
      await saveState(botState);
    }

    // Safety checks — run EVERY cycle if we have enough trades to be meaningful
    if (executedTrades.length >= 50) {
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
