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

  // ── FILTER BY SESSION: Only include logs from TODAY (UAE time) ────────────
  const uaeNow = new Date(Date.now() + 4 * 60 * 60 * 1000);
  const todayUaeDateStr = uaeNow.toISOString().slice(0, 10);

  const sessionLogs = logs.filter(log => {
    if (!log.time) return false;
    const logUaeTime = new Date(new Date(log.time).getTime() + 4 * 60 * 60 * 1000);
    const logUaeDateStr = logUaeTime.toISOString().slice(0, 10);
    return logUaeDateStr === todayUaeDateStr;
  });

  // ── Pass 1: Classify every log in the session ──────────────────────────
  const classified = sessionLogs.map(log => ({
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
        // 'hold' is NOT a separate category, it is mapped here as skipped.
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
  // Strictly computed from raw session logs per requirements, ignoring all caches.
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

  const closedTrades = pnls.length;
  const wins         = pnls.filter(p => p > 0.001).length;
  const losses       = pnls.filter(p => p < -0.001).length;
  // User explicitly defines: Win rate = winning trades / executed trades × 100
  const winRate      = executed > 0 ? parseFloat(((wins / executed) * 100).toFixed(1)) : null;
  const bestTrade    = pnls.length > 0 ? Math.max(...pnls) : null;
  const worstTrade   = pnls.length > 0 ? Math.min(...pnls) : null;
  const totalPnl     = pnls.length > 0 ? parseFloat(pnls.reduce((sum, p) => sum + p, 0).toFixed(2)) : null;

  // ── STRICT TRADE METRIC VALIDATION ──────────────────────────────────────
  if (closures > 0 && (bestTrade == null || worstTrade == null)) {
    throw new Error(`INVARIANT FAILED: Executed and closed trades exist (${closures}), but trade metrics failed calculating.`);
  }

  // ── Pass 4: Validation ──────────────────────────────────────────────────
  if (totalDecisions !== executed + skipped + rejected) {
    throw new Error(`INVARIANT FAILED: totalDecisions (${totalDecisions}) does not equal executed (${executed}) + skipped (${skipped}) + rejected (${rejected})`);
  }

  if (executed !== buys + sells) {
    throw new Error(`INVARIANT FAILED: executed (${executed}) does not equal buys (${buys}) + sells (${sells})`);
  }

  if (executed > totalDecisions || skipped > totalDecisions || rejected > totalDecisions) {
    throw new Error(`INVARIANT FAILED: A category count exceeds totalDecisions.`);
  }

  const totalClassified = executed + skipped + rejected + marketSkips + closures;
  if (totalClassified !== sessionLogs.length) {
    throw new Error(`INVARIANT FAILED: totalClassified (${totalClassified}) does not equal sessionLogs.length (${sessionLogs.length})`);
  }

  // For debug console checks
  console.log(`STATS CHECK: processed ${totalDecisions} decisions today, executed ${executed}`);
  console.log(`TRADE CHECK: executed ${executed}, closed ${closedTrades}, wins ${wins}`);

  return {
    totalLogs: sessionLogs.length,
    totalDecisions,
    executed,
    skipped,
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
    valid: true,
    validationErrors: [],
    source: 'raw_logs',
  };
}

