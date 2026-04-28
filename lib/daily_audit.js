import { STRATEGY_VERSION } from './strategy.js';

export function getUaeDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Dubai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type) => parts.find(p => p.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function logUaeDate(log) {
  if (!log?.time) return null;
  const time = new Date(log.time);
  if (Number.isNaN(time.getTime())) return null;
  return getUaeDateString(time);
}

function average(values) {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function topEntries(counts, limit = 5) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

export function latestStrategyVersionFromLogs(logs, fallback = STRATEGY_VERSION) {
  const latestLogWithVersion = [...(Array.isArray(logs) ? logs : [])]
    .filter(log => /^v\d+(?:\.\d+)*$/.test(String(log?.strategyVersion || '').trim()))
    .sort((a, b) => {
      const aTime = a.time ? new Date(a.time).getTime() : 0;
      const bTime = b.time ? new Date(b.time).getTime() : 0;
      return bTime - aTime;
    })[0];

  return latestLogWithVersion?.strategyVersion || fallback;
}

function detectAuditAnomalies(audit, dayLogs) {
  const anomalies = [];
  const {
    totalCycles, trades, setups, noSignalPct, totalRejects, topRejects,
    dupSkips, staleSkips, brokerErrors, avgATR, avgATRav,
  } = audit;

  const minExpectedCycles = 288 * 0.60;

  if (totalCycles === 0) {
    anomalies.push('No cycles logged for the UAE day.');
  }
  if (totalCycles > 0 && totalCycles < minExpectedCycles) {
    anomalies.push(`Low cycle count: ${totalCycles} (expected roughly 288).`);
  }
  if (totalCycles > 0 && setups === 0) {
    anomalies.push('No setups detected for the UAE day.');
  }
  if (setups > 0 && trades === 0) {
    const topReason = topRejects.length > 0 ? topRejects[0][0] : 'unknown';
    anomalies.push(`${setups} setup(s) detected but 0 trades executed; main block: ${topReason}.`);
  }
  if (totalCycles > 0 && Number(noSignalPct) > 95) {
    anomalies.push(`NO_SIGNAL rate extremely high: ${noSignalPct}%.`);
  }
  if (topRejects.length > 0 && totalRejects > 0) {
    const [topName, topCount] = topRejects[0];
    const domPct = (topCount / totalRejects) * 100;
    if (domPct > 70) {
      anomalies.push(`One rejection dominates: "${topName}" is ${domPct.toFixed(0)}% of rejections.`);
    }
  }
  if (totalCycles > 0 && dupSkips / totalCycles > 0.20) {
    anomalies.push(`Duplicate candle skips elevated: ${dupSkips} (${((dupSkips / totalCycles) * 100).toFixed(1)}%).`);
  }
  if (totalCycles > 0 && staleSkips / totalCycles > 0.15) {
    anomalies.push(`Stale candle skips elevated: ${staleSkips} (${((staleSkips / totalCycles) * 100).toFixed(1)}%).`);
  }
  if (brokerErrors > 0) {
    anomalies.push(`Broker errors detected: ${brokerErrors}.`);
  }

  const indicatorLogs = dayLogs.filter(l =>
    typeof l.ema20 === 'number' &&
    typeof l.ema50 === 'number' &&
    typeof l.atr === 'number' &&
    typeof l.atrAverage === 'number'
  );
  const missingIndicatorPct = totalCycles > 0
    ? ((totalCycles - indicatorLogs.length) / totalCycles) * 100
    : 0;
  if (totalCycles > 0 && missingIndicatorPct > 50) {
    anomalies.push(`High missing indicator rate: ${missingIndicatorPct.toFixed(0)}%.`);
  }
  if (avgATR !== null && avgATRav !== null && avgATR > avgATRav * 1.8) {
    anomalies.push(`ATR spike detected: avg ATR ${avgATR.toFixed(2)} vs avg baseline ${avgATRav.toFixed(2)}.`);
  }

  return anomalies;
}

export function buildDailyAuditFromLogs(logs, botState, options = {}) {
  const date = options.date || getUaeDateString();
  const dayLogs = (logs || []).filter(log => logUaeDate(log) === date);
  const strategyVersion = latestStrategyVersionFromLogs(dayLogs, latestStrategyVersionFromLogs(logs));
  const totalCycles = dayLogs.length;
  const trades = dayLogs.filter(l => l.tradeExecuted === true).length;
  const setups = dayLogs.filter(l => l.dbgSetupReady === true).length;
  const setupPct = totalCycles > 0 ? ((setups / totalCycles) * 100).toFixed(1) : '0.0';
  const sigBuy = dayLogs.filter(l => l.signalDetected === 'BUY').length;
  const sigSell = dayLogs.filter(l => l.signalDetected === 'SELL').length;
  const sigNone = dayLogs.filter(l => !l.signalDetected || l.signalDetected === 'NONE').length;
  const noSignalPct = totalCycles > 0 ? ((sigNone / totalCycles) * 100).toFixed(1) : '100.0';

  const rejectMap = {};
  for (const log of dayLogs) {
    if (log.dbgRejectReason) {
      rejectMap[log.dbgRejectReason] = (rejectMap[log.dbgRejectReason] || 0) + 1;
    }
  }
  const totalRejects = Object.values(rejectMap).reduce((sum, count) => sum + count, 0);
  const topRejects = topEntries(rejectMap);

  const entryCounts = { crossover: 0, pullback: 0, breakout: 0, other: 0 };
  for (const log of dayLogs) {
    const entryType = log.entryType || log.dbgEntryType;
    if (entryType === 'crossover') entryCounts.crossover++;
    else if (entryType === 'pullback') entryCounts.pullback++;
    else if (entryType === 'breakout') entryCounts.breakout++;
    else if (
      entryType &&
      entryType !== 'closure' &&
      entryType !== 'sync_event' &&
      entryType !== 'trade_management' &&
      entryType !== 'partial_close'
    ) {
      entryCounts.other++;
    }
  }

  const brokerErrors = dayLogs.filter(l => l.brokerResponse && typeof l.brokerResponse === 'object').length;
  const dupSkips = dayLogs.filter(l =>
    typeof l.reason === 'string' && (
      l.reason.startsWith('SKIP: Duplicate candle') ||
      l.reason.startsWith('SKIP: Signal from already processed candle') ||
      l.reason.startsWith('SKIP: No new candle')
    )
  ).length;
  const staleSkips = dayLogs.filter(l =>
    typeof l.reason === 'string' && l.reason.toLowerCase().includes('stale')
  ).length;

  const avgATR = average(dayLogs.map(l => l.atr).filter(v => typeof v === 'number' && v > 0));
  const avgATRav = average(dayLogs.map(l => l.atrAverage).filter(v => typeof v === 'number' && v > 0));
  const atrStatus = avgATR !== null && avgATRav !== null
    ? (avgATR >= avgATRav
      ? `Active (${avgATR.toFixed(2)} >= avg ${avgATRav.toFixed(2)})`
      : `Dead (${avgATR.toFixed(2)} < avg ${avgATRav.toFixed(2)})`)
    : 'N/A';

  const lastLogWithEma = [...dayLogs].reverse().find(l => typeof l.ema20 === 'number' && typeof l.ema50 === 'number');
  const trendBias = lastLogWithEma
    ? (lastLogWithEma.ema20 > lastLogWithEma.ema50 ? 'UP (EMA20 > EMA50)' : 'DOWN (EMA20 < EMA50)')
    : 'N/A';

  let pfStr = 'N/A';
  if (trades > 0) {
    const grossProfit = parseFloat(botState?.brokerGrossProfit) || 0;
    const grossLoss = Math.abs(parseFloat(botState?.brokerGrossLoss)) || 0;
    pfStr = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? 'Infinity' : 'N/A');
  }

  const topReject = topRejects.length > 0 ? topRejects[0] : null;
  let conclusion;
  if (totalCycles === 0) {
    conclusion = 'No cycles logged for the UAE day.';
  } else if (trades > 0 && topReject) {
    conclusion = `Trades executed from confirmed setups. Main filter for the rest: "${topReject[0]}".`;
  } else if (trades > 0) {
    conclusion = 'Trades executed from all detected setups.';
  } else if (totalCycles > 0 && staleSkips / totalCycles > 0.10) {
    conclusion = `High stale skip rate (${((staleSkips / totalCycles) * 100).toFixed(1)}%) may have reduced valid entries.`;
  } else if (setups > 0 && topReject) {
    const topRejectPct = totalRejects > 0 ? ((topReject[1] / totalRejects) * 100).toFixed(0) : '?';
    conclusion = `Setups were blocked mainly by "${topReject[0]}" (${topRejectPct}% of rejections).`;
  } else if (setups > 0) {
    conclusion = 'Setups detected but no trades placed; risk or session filters intervened.';
  } else {
    conclusion = 'No setups detected for the UAE day.';
  }

  const audit = {
    date,
    strategyVersion,
    schedulerSource: botState?.schedulerSource ?? 'admin-backfill',
    totalCycles,
    totalDecisions: totalCycles,
    trades,
    tradesExecuted: trades,
    setups,
    setupPct,
    sigBuy,
    sigSell,
    sigNone,
    noSignalPct,
    totalRejects,
    topRejects,
    entryCounts,
    brokerErrors,
    dupSkips,
    staleSkips,
    avgATR,
    avgATRav,
    atrStatus,
    trendBias,
    pfStr,
    profitFactor: pfStr,
    conclusion,
    generatedAt: new Date().toISOString(),
  };
  audit.anomalies = detectAuditAnomalies(audit, dayLogs);

  const rejectionLines = topRejects.length > 0
    ? topRejects.map(([reason, count]) => `  - ${reason}: ${count}`).join('\n')
    : '  None';
  const entryLines = Object.entries(entryCounts)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `  ${type}: ${count}`)
    .join('\n') || '  None';

  audit.report =
    `DAILY AUDIT (${date})\n` +
    `Cycles: ${totalCycles}\n` +
    `Trades: ${trades}\n` +
    `Setups: ${setups} (${setupPct}%)\n` +
    `Profit Factor: ${pfStr}\n\n` +
    `Signals:\n  BUY: ${sigBuy} | SELL: ${sigSell} | NONE: ${sigNone} (${noSignalPct}%)\n\n` +
    `Top Rejections:\n${rejectionLines}\n\n` +
    `Entry Types:\n${entryLines}\n\n` +
    `Infra:\n  Broker Errors: ${brokerErrors}\n  Duplicate Skips: ${dupSkips}\n  Stale Skips: ${staleSkips}\n\n` +
    `Market:\n  ATR: ${atrStatus}\n  Trend: ${trendBias}\n\n` +
    `Conclusion:\n${conclusion}`;

  return {
    audit,
    dayLogsCount: dayLogs.length,
  };
}
