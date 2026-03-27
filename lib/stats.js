// stats.js — Server-side session statistics engine.
// Single source of truth for all dashboard session stats.
// Processes raw logs from logger.js and merges with broker data.

const MARKET_SKIP_PREFIXES = [
  'SKIP: Weekend',
  'SKIP: Outside Golden Hour',
  'SKIP: Friday close',
  'SKIP: Concurrency lock',
  'SKIP: Concurrency block',
  'SKIP: Capital.com auth',
  'SKIP: Bot disabled',
  'SKIP: Balance not yet synced',
  'Bot disabled via',
  'SKIP: Signal from already processed candle',
  'SKIP: Duplicate candle',
  'SKIP: No new candle',
  'SKIP: Market data',
  'SKIP: Insufficient candles',
];

function classifyLog(log) {
  const reason = log.reason || '';
  const entryType = log.entryType || log.signal?.entryType || null;

  if (reason.startsWith('CLOSED:') || entryType === 'closure') return 'CLOSURE';
  for (const prefix of MARKET_SKIP_PREFIXES) {
    if (reason.startsWith(prefix)) return 'MARKET_SKIP';
  }
  if (log.tradeExecuted === true) return 'DECISION_EXECUTED';
  const signal = log.signalDetected || 'NONE';
  if (signal === 'BUY' || signal === 'SELL') return 'DECISION_REJECTED';
  return 'DECISION_SKIPPED';
}

/**
 * Compute all session statistics from raw logs and broker data.
 * @param {Array<Object>} logs — Array of log entries
 * @param {Object} [brokerStats] — Optional broker stats (state)
 */
export function computeSessionStats(logs, brokerStats) {
  // UAE Time filtering
  const uaeNow = new Date(Date.now() + 4 * 60 * 60 * 1000);
  const todayUaeDateStr = uaeNow.toISOString().slice(0, 10);

  const sessionLogs = (logs || []).filter(log => {
    if (!log.time) return false;
    const logUaeTime = new Date(new Date(log.time).getTime() + 4 * 60 * 60 * 1000);
    return logUaeTime.toISOString().slice(0, 10) === todayUaeDateStr;
  });

  const classified = sessionLogs.map(log => ({
    log,
    category: classifyLog(log),
  }));

  // Log counts
  const rejectedCount    = classified.filter(c => c.category === 'DECISION_REJECTED').length;
  const rawExecutedCount = classified.filter(c => c.category === 'DECISION_EXECUTED').length;
  const skippedCount     = classified.filter(c => c.category === 'DECISION_SKIPPED').length;

  const closureCount     = classified.filter(c => c.category === 'CLOSURE').length;

  // Broker primary state
  const executedMetric = brokerStats?.todayTrades ?? 0;
  const buysMetric     = brokerStats?.todayBuys   ?? 0;
  const sellsMetric    = brokerStats?.todaySells  ?? 0;
  const rejectedMetric = rejectedCount;

  // RECONCILIATION LOGIC:
  // Every execution from the broker is a decision.
  // Every hold from the logs is a decision.
  // Every rejection from the logs is a decision.
  // If we have local execution logs (rawExecutedCount), we assume they are included in the broker count (executedMetric).
  // Total Decisions = Logged Skips + Logged Rejects + max(Logged Execution Logs, Real Broker Executions)
  const totalDecisions = skippedCount + rejectedMetric + Math.max(rawExecutedCount, executedMetric);
  
  // Metric finalization
  const skippedMetric = skippedCount; // We trust logs for skips as broker doesn't track them.

  // Performance Metrics (Source of Truth: Broker)
  const winRateMetric    = brokerStats?.todayWinRate ?? 0;
  const bestTradeMetric  = brokerStats?.todayBest    ?? 0;
  const worstTradeMetric = brokerStats?.todayWorst   ?? 0;

  return {
    totalLogs: sessionLogs.length,
    totalDecisions,
    executed: executedMetric,
    skipped: skippedMetric,
    rejected: rejectedMetric,
    closures: closureCount,
    closedTrades: closureCount, // Alias for audit compatibility
    buys: buysMetric,
    sells: sellsMetric,
    winRate: parseFloat(winRateMetric.toFixed(1)),
    bestTrade: parseFloat(bestTradeMetric.toFixed(2)),
    worstTrade: parseFloat(worstTradeMetric.toFixed(2)),
    valid: true,
    source: 'broker_reconciled'
  };
}
