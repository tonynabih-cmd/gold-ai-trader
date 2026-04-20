#!/usr/bin/env node
// patch_audit_v2.mjs — Replaces generateLocalAudit() with structured + anomaly version.
// Run from project root: node scratch/patch_audit_v2.mjs
import { readFileSync, writeFileSync } from 'fs';

const file = 'api/cron.js';
let content = readFileSync(file, 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// TARGET: the entire current generateLocalAudit block (inclusive of header comment)
// Delimited by known unique strings
// ─────────────────────────────────────────────────────────────────────────────
const START_MARKER = '// ── LOCAL RULE-BASED DAILY AUDIT ──────────────────────────────────────────';
const END_MARKER   = "  console.log('[AUDIT] Sending daily rule-based audit to Telegram');\r\n  await sendAlert(msg);\r\n}\r\n";

const startIdx = content.indexOf(START_MARKER);
const endIdx   = content.indexOf(END_MARKER);

if (startIdx < 0) { console.error('START_MARKER not found'); process.exit(1); }
if (endIdx   < 0) { console.error('END_MARKER not found');   process.exit(1); }

const endPos = endIdx + END_MARKER.length;

console.log(`START at char ${startIdx}, END at char ${endPos}`);

// ─────────────────────────────────────────────────────────────────────────────
// REPLACEMENT: full upgraded audit block
// ─────────────────────────────────────────────────────────────────────────────
const newAuditBlock = `// ── LOCAL RULE-BASED DAILY AUDIT ─────────────────────────────────────────────
// Replaces the disabled Claude-based daily audit.
// Reads the last 24h of trade_logs_list from Redis and computes all metrics.
// Sends a structured summary + anomaly alert (when anomalies exist) to Telegram.

// ── Anomaly detection — runs after the main audit ──────────────────────────
function detectAuditAnomalies(audit, dayLogs, botState) {
  const anomalies = [];
  const {
    totalCycles, trades, setups, noSignalPct,
    topRejects, dupSkips, staleSkips, brokerErrors,
    avgATR, avgATRav,
  } = audit;

  // Expected cycles based on a 5-min cron: ~288 per 24h (allow 40% margin)
  const MIN_EXPECTED_CYCLES = 288 * 0.60; // 173

  // ── 1. No cycles at all ──────────────────────────────────────────────────
  if (totalCycles === 0) {
    anomalies.push('No cycles logged — bot may have been offline the entire day.');
  }

  // ── 2. Abnormally low cycle count ────────────────────────────────────────
  if (totalCycles > 0 && totalCycles < MIN_EXPECTED_CYCLES) {
    anomalies.push(\`Low cycle count: \${totalCycles} (expected ~288). Bot may have been intermittent.\`);
  }

  // ── 3. Zero setups in 24h ────────────────────────────────────────────────
  if (totalCycles > 0 && setups === 0) {
    anomalies.push('Zero setups detected in 24h — strategy filters may be too strict or market was flat all day.');
  }

  // ── 4. Setups present but no trades ──────────────────────────────────────
  if (setups > 0 && trades === 0) {
    const topRej = topRejects.length > 0 ? topRejects[0][0] : 'unknown';
    anomalies.push(\`\${setups} setup(s) detected but 0 trades executed — blocked mainly by: \${topRej}.\`);
  }

  // ── 5. NO_SIGNAL rate above 95% ──────────────────────────────────────────
  if (totalCycles > 0 && parseFloat(noSignalPct) > 95) {
    anomalies.push(\`NO_SIGNAL rate extremely high: \${noSignalPct}% — strategy is rarely generating signals.\`);
  }

  // ── 6. Single rejection reason dominates (>70% of all logged rejections) ─
  if (topRejects.length > 0) {
    const totalRejected = topRejects.reduce((s, [, n]) => s + n, 0);
    const [topName, topCount] = topRejects[0];
    const domPct = (topCount / totalRejected) * 100;
    if (domPct > 70) {
      anomalies.push(\`One rejection dominates: "\${topName}" accounts for \${domPct.toFixed(0)}% of all blocked setups.\`);
    }
  }

  // ── 7. Duplicate candle skips elevated (>20% of cycles) ─────────────────
  if (totalCycles > 0 && dupSkips / totalCycles > 0.20) {
    anomalies.push(\`Duplicate candle skips elevated: \${dupSkips} (\${((dupSkips / totalCycles) * 100).toFixed(1)}% of cycles) — possible cron scheduling issue.\`);
  }

  // ── 8. Stale candle skips elevated (>15% of cycles) ─────────────────────
  if (totalCycles > 0 && staleSkips / totalCycles > 0.15) {
    anomalies.push(\`Stale candle skips elevated: \${staleSkips} (\${((staleSkips / totalCycles) * 100).toFixed(1)}% of cycles) — infrastructure latency may be reducing valid entries.\`);
  }

  // ── 9. Broker/account errors ─────────────────────────────────────────────
  if (brokerErrors > 0) {
    anomalies.push(\`Broker errors detected: \${brokerErrors} log(s) contain a brokerResponse error object.\`);
  }

  // ── 10. Missing EMA/ATR telemetry in many logs ───────────────────────────
  const indicatorLogs = dayLogs.filter(l => l.ema20 !== null && l.ema20 !== undefined);
  const missingIndicatorPct = totalCycles > 0
    ? ((totalCycles - indicatorLogs.length) / totalCycles) * 100
    : 0;
  if (totalCycles > 0 && missingIndicatorPct > 50) {
    anomalies.push(\`High missing indicator rate: \${missingIndicatorPct.toFixed(0)}% of cycles had no EMA/ATR data — market data may be failing frequently.\`);
  }

  // ── 11. ATR much higher than ATR average (volatile spike) ────────────────
  if (avgATR !== null && avgATRav !== null && avgATR > avgATRav * 1.8) {
    anomalies.push(\`ATR spike detected: avg ATR \${avgATR.toFixed(2)} is \${((avgATR / avgATRav) * 100 - 100).toFixed(0)}% above its own average (\${avgATRav.toFixed(2)}) — market was unusually volatile.\`);
  }

  return anomalies;
}

async function generateLocalAudit(logs, botState) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // last 24 hours
  const date   = new Date(Date.now()).toISOString().slice(0, 10);

  // ── Filter to last 24h only ───────────────────────────────────────────────
  const dayLogs = (logs || []).filter(l => {
    const t = l.time ? new Date(l.time).getTime() : 0;
    return t >= cutoff;
  });

  const totalCycles = dayLogs.length;

  // ── Trades Executed ───────────────────────────────────────────────────────
  const trades = dayLogs.filter(l => l.tradeExecuted === true).length;

  // ── Setups Detected ───────────────────────────────────────────────────────
  const setups    = dayLogs.filter(l => l.dbgSetupReady === true).length;
  const setupPct  = totalCycles > 0 ? ((setups / totalCycles) * 100).toFixed(1) : '0.0';

  // ── Signal Distribution (BUY / SELL / NONE) ──────────────────────────────
  const sigBuy      = dayLogs.filter(l => l.signalDetected === 'BUY').length;
  const sigSell     = dayLogs.filter(l => l.signalDetected === 'SELL').length;
  const sigNone     = dayLogs.filter(l => !l.signalDetected || l.signalDetected === 'NONE').length;
  const noSignalPct = totalCycles > 0 ? ((sigNone / totalCycles) * 100).toFixed(1) : '100.0';

  // ── Top Rejection Reasons (dbgRejectReason) ───────────────────────────────
  const rejectMap = {};
  for (const l of dayLogs) {
    if (l.dbgRejectReason) {
      rejectMap[l.dbgRejectReason] = (rejectMap[l.dbgRejectReason] || 0) + 1;
    }
  }
  const topRejects = Object.entries(rejectMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // ── Entry Type Distribution ───────────────────────────────────────────────
  const entryCounts = { crossover: 0, pullback: 0, breakout: 0, other: 0 };
  for (const l of dayLogs) {
    const et = l.entryType || l.dbgEntryType;
    if (et === 'crossover') entryCounts.crossover++;
    else if (et === 'pullback') entryCounts.pullback++;
    else if (et === 'breakout') entryCounts.breakout++;
    else if (et && et !== 'closure' && et !== 'sync_event' && et !== 'trade_management' && et !== 'partial_close') entryCounts.other++;
  }

  // ── Broker Errors ─────────────────────────────────────────────────────────
  const brokerErrors = dayLogs.filter(l =>
    l.brokerResponse && typeof l.brokerResponse === 'object'
  ).length;

  // ── Duplicate Candle Skips ────────────────────────────────────────────────
  const dupSkips = dayLogs.filter(l =>
    typeof l.reason === 'string' && (
      l.reason.startsWith('SKIP: Duplicate candle') ||
      l.reason.startsWith('SKIP: Signal from already processed candle') ||
      l.reason.startsWith('SKIP: No new candle')
    )
  ).length;

  // ── Stale Candle Skips ────────────────────────────────────────────────────
  const staleSkips = dayLogs.filter(l =>
    typeof l.reason === 'string' && l.reason.toLowerCase().includes('stale')
  ).length;

  // ── Market Stats: ATR ─────────────────────────────────────────────────────
  const atrValues = dayLogs.map(l => l.atr).filter(v => typeof v === 'number' && v > 0);
  const avgValues = dayLogs.map(l => l.atrAverage).filter(v => typeof v === 'number' && v > 0);
  const avgATR    = atrValues.length > 0 ? atrValues.reduce((s, v) => s + v, 0) / atrValues.length : null;
  const avgATRav  = avgValues.length > 0 ? avgValues.reduce((s, v) => s + v, 0) / avgValues.length : null;
  let atrStatus = 'N/A';
  if (avgATR !== null && avgATRav !== null) {
    atrStatus = avgATR >= avgATRav
      ? \`Active (\${avgATR.toFixed(2)} >= avg \${avgATRav.toFixed(2)})\`
      : \`Dead (\${avgATR.toFixed(2)} < avg \${avgATRav.toFixed(2)})\`;
  }

  // ── Trend Bias (EMA20 vs EMA50) ───────────────────────────────────────────
  const lastLogWithEma = [...dayLogs].reverse().find(l => typeof l.ema20 === 'number' && typeof l.ema50 === 'number');
  let trendBias = 'N/A';
  if (lastLogWithEma) {
    trendBias = lastLogWithEma.ema20 > lastLogWithEma.ema50 ? 'UP (EMA20 > EMA50)' : 'DOWN (EMA20 < EMA50)';
  }

  // ── Profit Factor — N/A when trades = 0 (safety) ─────────────────────────
  let pfStr = 'N/A';
  if (trades > 0) {
    const grossProfit = parseFloat(botState.brokerGrossProfit) || 0;
    const grossLoss   = Math.abs(parseFloat(botState.brokerGrossLoss)) || 0;
    pfStr = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? '∞' : 'N/A');
  }

  // ── Deterministic Conclusion ──────────────────────────────────────────────
  // Rule priority (top to bottom — first matching rule wins):
  // 1. No cycles → bot was offline
  // 2. Trades executed → report outcome and dominant filter
  // 3. High stale skip rate → infrastructure limited entries
  // 4. Setups blocked → identify the dominant rejection reason
  // 5. No setups → market conditions were not met
  let conclusion;
  const topRej = topRejects.length > 0 ? topRejects[0] : null;

  if (totalCycles === 0) {
    conclusion = 'No cycles logged — bot was offline or failed to run all day.';
  } else if (trades > 0 && topRej) {
    conclusion = \`Trades executed normally from confirmed setups. Main filter for the rest: "\${topRej[0]}".\`;
  } else if (trades > 0) {
    conclusion = 'All setups converted to trades — unusually clean session.';
  } else if (staleSkips > 20) {
    conclusion = \`High stale skip rate (\${staleSkips}) may have reduced the number of valid entry windows.\`;
  } else if (setups > 0 && topRej) {
    const topRejPct = topRejects.reduce((s, [, n]) => s + n, 0) > 0
      ? ((topRej[1] / topRejects.reduce((s, [, n]) => s + n, 0)) * 100).toFixed(0)
      : '?';
    conclusion = \`Setups were blocked mainly by "\${topRej[0]}" (\${topRejPct}% of rejections).\`;
  } else if (setups > 0) {
    conclusion = 'Setups detected but no trades placed — risk or session filters intervened.';
  } else {
    conclusion = 'No valid setups found — market conditions did not satisfy strategy criteria.';
  }

  // ── Build structured audit object (used by anomaly detector) ─────────────
  const audit = {
    totalCycles, trades, setups, setupPct, noSignalPct,
    sigBuy, sigSell, sigNone,
    topRejects, entryCounts,
    brokerErrors, dupSkips, staleSkips,
    avgATR, avgATRav, atrStatus, trendBias,
    pfStr, conclusion, date,
  };

  // ── Format and send daily audit message ──────────────────────────────────
  const rejLines = topRejects.length > 0
    ? topRejects.map(([r, n]) => \`  • \${r}: \${n}\`).join('\\n')
    : '  None';

  const entryLines = Object.entries(entryCounts)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => \`  \${t}: \${n}\`)
    .join('\\n') || '  None';

  const msg =
    \`📊 DAILY AUDIT (\${date})\\n\` +
    \`Cycles: \${totalCycles}\\n\` +
    \`Trades: \${trades}\\n\` +
    \`Setups: \${setups} (\${setupPct}%)\\n\` +
    \`Profit Factor: \${pfStr}\\n\\n\` +
    \`Signals:\\n  BUY: \${sigBuy} | SELL: \${sigSell} | NONE: \${sigNone} (\${noSignalPct}%)\\n\\n\` +
    \`Top Rejections:\\n\${rejLines}\\n\\n\` +
    \`Entry Types:\\n\${entryLines}\\n\\n\` +
    \`Infra:\\n  Broker Errors: \${brokerErrors}\\n  Duplicate Skips: \${dupSkips}\\n  Stale Skips: \${staleSkips}\\n\\n\` +
    \`Market:\\n  ATR: \${atrStatus}\\n  Trend: \${trendBias}\\n\\n\` +
    \`Conclusion:\\n\${conclusion}\`;

  console.log('[AUDIT] Sending daily rule-based audit to Telegram');
  await sendAlert(msg);

  // ── Anomaly detection — fires one extra alert only when anomalies exist ───
  const anomalies = detectAuditAnomalies(audit, dayLogs, botState);
  if (anomalies.length > 0) {
    const anomalyMsg =
      \`🚨 AUDIT ANOMALIES (\${date})\\n\` +
      anomalies.map(a => \`- \${a}\`).join('\\n');
    console.log(\`[AUDIT] \${anomalies.length} anomalie(s) detected — sending alert\`);
    await sendAlert(anomalyMsg);
  } else {
    console.log('[AUDIT] No anomalies detected.');
  }
}
`;

content = content.slice(0, startIdx) + newAuditBlock + content.slice(endPos);

writeFileSync(file, content, 'utf8');
console.log('Patch applied. File written successfully.');
console.log('New file size (bytes):', content.length);
