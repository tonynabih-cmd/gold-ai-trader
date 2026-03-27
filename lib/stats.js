// stats.js — Server-side session statistics engine.
// Single source of truth for all dashboard session stats.
// Processes raw logs from logger.js and returns validated, internally-consistent metrics.
//
// LOG CLASSIFICATION:
//   Every log entry falls into exactly ONE of these categories:
//   1. MARKET_SKIP     — Not a trading decision (weekend, after-hours, concurrency lock, auth fail, bot disabled)
//   2. CLOSURE         — A trade was closed (SL/TP hit). Has reason starting with "CLOSED:" or entryType "closure"
//   3. DECISION_EXECUTED — Strategy generated a signal, risk approved, trade placed on Capital.com
//   4. DECISION_SKIPPED  — Strategy evaluated, no signal generated (hold)
//   5. DECISION_REJECTED — Strategy generated a signal, but risk.js or execution.js blocked it
//
// INVARIANTS:
//   totalDecisions === executed + skipped + rejected
//   executed === buys + sells
//   Every log is classified into exactly one bucket

// Reason prefixes that indicate a market skip (not a real trading decision)
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

/**
 * Classify a single log entry into one of the 5 categories.
 * @param {Object} log — A single log entry from logger.js
 * @returns {'MARKET_SKIP'|'CLOSURE'|'DECISION_EXECUTED'|'DECISION_SKIPPED'|'DECISION_REJECTED'}
 */
function classifyLog(log) {
  const reason = log.reason || '';
  const entryType = log.entryType || log.signal?.entryType || null;

  // 1. Closure logs — trade was closed by broker (SL/TP/manual)
  if (reason.startsWith('CLOSED:') || entryType === 'closure') {
    return 'CLOSURE';
  }

  // 2. Market skips — not a real trading decision
  for (const prefix of MARKET_SKIP_PREFIXES) {
    if (reason.startsWith(prefix)) {
      return 'MARKET_SKIP';
    }
  }

  // 3. Executed trades — trade was placed
  if (log.tradeExecuted === true) {
    return 'DECISION_EXECUTED';
  }

  // 4. Signal was detected but blocked by risk/execution
  const signal = log.signalDetected || 'NONE';
  if (signal === 'BUY' || signal === 'SELL') {
    return 'DECISION_REJECTED';
  }

  // 5. No signal generated — strategy evaluated but no entry conditions met
  return 'DECISION_SKIPPED';
}


/**
 * Compute all session statistics from raw logs and broker data.
 * @param {Array<Object>} logs — Array of log entries from getLogs()
 * @param {Object} [brokerStats] — Optional broker stats from botState (from fetchBrokerTradeStats)
 *   Expected shape: { brokerWinRate, brokerBestTrade, brokerWorstTrade, brokerTotalPnl,
 *                     brokerWins, brokerLosses, brokerTotalTrades }
 * @returns {Object} Validated statistics object
 */
export function computeSessionStats(logs, brokerStats) {
  if (!Array.isArray(logs) || logs.length === 0) {
    // Even with no logs, broker stats may have trade data
    const hasBroker = brokerStats && brokerStats.brokerTotalTrades > 0;
    return {
      totalLogs: 0,
      totalDecisions: 0,
      executed: 0,
      skipped: 0,
      rejected: 0,
      buys: 0,
      sells: 0,
      marketSkips: 0,
      closures: 0,
      winRate:      hasBroker ? brokerStats.brokerWinRate     : null,
      bestTrade:    hasBroker ? brokerStats.brokerBestTrade   : null,
      worstTrade:   hasBroker ? brokerStats.brokerWorstTrade  : null,
      totalPnl:     hasBroker ? brokerStats.brokerTotalPnl    : null,
      closedTrades: hasBroker ? brokerStats.brokerTotalTrades : 0,
      wins:         hasBroker ? brokerStats.brokerWins        : 0,
      losses:       hasBroker ? brokerStats.brokerLosses      : 0,
      valid: true,
      validationErrors: [],
      source: hasBroker ? 'broker' : 'none',
    };
  }

  // ── Pass 1: Classify every log ──────────────────────────────────────────
  const classified = logs.map(log => ({
    log,
    category: classifyLog(log),
  }));

  // ── Pass 2: Count by category ──────────────────────────────────────────
  let executed = 0;
  let skipped = 0;
  let rejected = 0;
  let marketSkips = 0;
  let closures = 0;
  let buys = 0;
  let sells = 0;

  for (const { log, category } of classified) {
    switch (category) {
      case 'DECISION_EXECUTED':
        executed++;
        if (log.signalDetected === 'BUY') buys++;
        else if (log.signalDetected === 'SELL') sells++;
        break;
      case 'DECISION_SKIPPED':
        skipped++;
        break;
      case 'DECISION_REJECTED':
        rejected++;
        break;
      case 'MARKET_SKIP':
        marketSkips++;
        break;
      case 'CLOSURE':
        closures++;
        break;
    }
  }

  const totalDecisions = executed + skipped + rejected;

  // ── Pass 3: Trade P&L metrics ───────────────────────────────────────────
  // PRIMARY SOURCE: Broker stats from Capital.com transaction history (always accurate).
  // FALLBACK:       Closure logs (only if broker stats are unavailable).
  const hasBroker = brokerStats
    && brokerStats.brokerTotalTrades != null
    && brokerStats.brokerTotalTrades > 0;

  let winRate, bestTrade, worstTrade, totalPnl, closedTrades, wins, losses;

  if (hasBroker) {
    // Use broker data — this matches the Capital.com screenshot exactly
    winRate      = brokerStats.brokerWinRate;
    bestTrade    = brokerStats.brokerBestTrade;
    worstTrade   = brokerStats.brokerWorstTrade;
    totalPnl     = brokerStats.brokerTotalPnl;
    closedTrades = brokerStats.brokerTotalTrades;
    wins         = brokerStats.brokerWins;
    losses       = brokerStats.brokerLosses;
  } else {
    // Fallback: extract from closure logs
    const pnls = [];
    for (const { log, category } of classified) {
      if (category !== 'CLOSURE') continue;

      let pnl = null;
      if (log.result?.realizedPnl != null) {
        pnl = parseFloat(log.result.realizedPnl);
      } else if (log.reason) {
        const match = log.reason.match(/P&L:\s*\$?([-\d.]+)/);
        if (match) {
          pnl = parseFloat(match[1]);
        }
      }

      if (pnl != null && !isNaN(pnl)) {
        pnls.push(pnl);
      }
    }

    closedTrades = pnls.length;
    wins         = pnls.filter(p => p > 0.001).length;
    losses       = pnls.filter(p => p < -0.001).length;
    winRate      = closedTrades > 0 ? parseFloat(((wins / closedTrades) * 100).toFixed(1)) : null;
    bestTrade    = pnls.length > 0 ? Math.max(...pnls) : null;
    worstTrade   = pnls.length > 0 ? Math.min(...pnls) : null;
    totalPnl     = pnls.length > 0 ? parseFloat(pnls.reduce((sum, p) => sum + p, 0).toFixed(2)) : null;
  }

  // ── Pass 4: Validation ──────────────────────────────────────────────────
  const validationErrors = [];

  if (totalDecisions !== executed + skipped + rejected) {
    validationErrors.push(
      `INVARIANT FAILED: totalDecisions(${totalDecisions}) !== executed(${executed}) + skipped(${skipped}) + rejected(${rejected})`
    );
  }

  if (executed !== buys + sells) {
    validationErrors.push(
      `INVARIANT FAILED: executed(${executed}) !== buys(${buys}) + sells(${sells})`
    );
  }

  const totalClassified = executed + skipped + rejected + marketSkips + closures;
  if (totalClassified !== logs.length) {
    validationErrors.push(
      `INVARIANT FAILED: totalClassified(${totalClassified}) !== logs.length(${logs.length})`
    );
  }

  if (validationErrors.length > 0) {
    console.error('Stats validation errors:', validationErrors);
  }

  return {
    totalLogs: logs.length,
    totalDecisions,
    executed,
    skipped,       // also displayed as "Holds"
    rejected,
    buys,
    sells,
    marketSkips,
    closures,
    winRate,        // number (e.g. 47.06) or null
    bestTrade,      // number or null
    worstTrade,     // number or null
    totalPnl,       // number or null
    closedTrades,
    wins,
    losses,
    valid: validationErrors.length === 0,
    validationErrors,
    source: hasBroker ? 'broker' : 'logs',
  };
}

