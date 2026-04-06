import fs from 'fs';

const TARGET_TRADING_DATE = '2026-04-07';
const ENV_FILE = '.env.local';
const LIVE_CONFIRMATION = 'CONFIRMED_REAL_MONEY';
const CANONICAL_MAX_SPREAD = '0.5';
const PULLBACK_SLOPE_THRESHOLD = 0.15;
const MOMENTUM_RANGE_MULTIPLIER = 0.05;

let getCapitalSession;
let getMarketData;
let calculateIndicators;
let generateSignal;
let loadState;
let saveState;
let pingRedis;
let validateStateIntegrity;
let fetchBrokerPositions;
let fetchBrokerTradeStats;
let verifyExecutionCertainty;
let fetchWithTimeout;

function loadEnvLocal(filepath = ENV_FILE) {
  if (!fs.existsSync(filepath)) return;

  const raw = fs.readFileSync(filepath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^"(.*)"$/, '$1');
    if (key && process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

async function loadRuntimeModules() {
  if (getCapitalSession) return;

  ({ getCapitalSession } = await import('../lib/session.js'));
  ({ getMarketData } = await import('../lib/market_data.js'));
  ({ calculateIndicators } = await import('../lib/indicators.js'));
  ({ generateSignal } = await import('../lib/strategy.js'));
  ({
    loadState,
    saveState,
    pingRedis,
    validateStateIntegrity,
  } = await import('../lib/state.js'));
  ({
    fetchBrokerPositions,
    fetchBrokerTradeStats,
    verifyExecutionCertainty,
  } = await import('../lib/execution.js'));
  ({ fetchWithTimeout } = await import('../lib/fetch.js'));
}

function upsertEnvVar(filepath, key, value) {
  const normalizedValue = `"${value}"`;
  const exists = fs.existsSync(filepath);
  const raw = exists ? fs.readFileSync(filepath, 'utf8') : '';
  const lines = exists ? raw.split(/\r?\n/) : [];
  let changed = false;
  let found = false;

  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    if (!trimmed.startsWith(`${key}=`)) return line;
    found = true;
    if (trimmed === `${key}=${normalizedValue}`) return line;
    changed = true;
    return `${key}=${normalizedValue}`;
  });

  if (!found) {
    nextLines.push(`${key}=${normalizedValue}`);
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(filepath, `${nextLines.join('\n').replace(/\n+$/u, '')}\n`, 'utf8');
    process.env[key] = value;
  }

  return changed;
}

function readText(filepath) {
  return fs.readFileSync(filepath, 'utf8');
}

function extractNumber(source, regex) {
  const match = source.match(regex);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function extractStrategyMultipliers() {
  const source = readText('lib/strategy.js');
  return {
    stopLossAtr: extractNumber(source, /const\s+STOP_LOSS_ATR_MULTIPLIER\s*=\s*([0-9.]+)/),
    takeProfitAtr: extractNumber(source, /const\s+TAKE_PROFIT_ATR_MULTIPLIER\s*=\s*([0-9.]+)/),
  };
}

function extractExecutionMultipliers() {
  const source = readText('lib/execution.js');
  return {
    stopLossAtr: extractNumber(source, /const\s+adjustedSL\s*=\s*signal\.action\s*===\s*'BUY'[\s\S]*?\(\s*([0-9.]+)\s*\*\s*signal\.atr\s*\)/),
    takeProfitAtr: extractNumber(source, /const\s+adjustedTP\s*=\s*signal\.action\s*===\s*'BUY'[\s\S]*?\(\s*([0-9.]+)\s*\*\s*signal\.atr\s*\)/),
  };
}

function extractSpreadFallbacks() {
  const riskSource = readText('lib/risk.js');
  const executionSource = readText('lib/execution.js');

  return {
    riskFallback: extractNumber(riskSource, /parseFloat\(process\.env\.MAX_SPREAD\)\s*\|\|\s*([0-9.]+)/),
    executionFallback: extractNumber(executionSource, /parseFloat\(process\.env\.MAX_SPREAD\)\s*\|\|\s*([0-9.]+)/),
    envValue: process.env.MAX_SPREAD == null ? null : Number(process.env.MAX_SPREAD),
  };
}

function buildEnvSnapshot() {
  const loadedKeys = [
    'BOT_ENABLED',
    'CAPITAL_ENV',
    'LIVE_TRADING_MODE',
    'MAX_SPREAD',
    'CAPITAL_API_KEY',
    'CAPITAL_EMAIL',
    'CAPITAL_PASSWORD',
    'KV_REST_API_URL',
    'KV_REST_API_TOKEN',
    'KV_REST_API_READ_ONLY_TOKEN',
    'REDIS_URL',
    'KV_URL',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'CRON_SECRET',
  ];

  const rawValueKeys = new Set([
    'BOT_ENABLED',
    'CAPITAL_ENV',
    'LIVE_TRADING_MODE',
    'MAX_SPREAD',
  ]);

  const values = {};
  for (const key of loadedKeys) {
    const rawValue = process.env[key];
    values[key] = rawValueKeys.has(key) ? (rawValue ?? null) : rawValue != null;
  }

  return {
    fileLoaded: fs.existsSync(ENV_FILE),
    values,
    missingRequired: [
      'CAPITAL_API_KEY',
      'CAPITAL_EMAIL',
      'CAPITAL_PASSWORD',
      'KV_REST_API_URL',
      'KV_REST_API_TOKEN',
    ].filter((key) => !process.env[key]),
  };
}

function summarizeSignal(indicators, candles1m) {
  if (!indicators || indicators.skip || !Array.isArray(candles1m)) {
    return { signal: null, debug: null };
  }

  return generateSignal(indicators, candles1m);
}

function computeEmaCrossover(indicators) {
  if (!indicators || indicators.skip) {
    return {
      detected: false,
      direction: null,
    };
  }

  const prevDiff = indicators.prevEMA20 - indicators.prevEMA50;
  const currDiff = indicators.currEMA20 - indicators.currEMA50;
  const bullish = prevDiff <= 0 && currDiff > 0;
  const bearish = prevDiff >= 0 && currDiff < 0;

  return {
    detected: bullish || bearish,
    direction: bullish ? 'BUY' : bearish ? 'SELL' : null,
    prevDiff: Number(prevDiff.toFixed(4)),
    currDiff: Number(currDiff.toFixed(4)),
  };
}

function computeMomentumGate(indicators, candles1m, action) {
  if (!indicators || indicators.skip || !Array.isArray(candles1m) || candles1m.length === 0 || !action) {
    return {
      ready: null,
      reason: 'NO_DIRECTION',
      netMomentum1m: null,
      minThreshold: indicators?.atr ? Number((indicators.atr * MOMENTUM_RANGE_MULTIPLIER).toFixed(4)) : null,
      bullishCandles: 0,
      bearishCandles: 0,
      strongBullishCandles: 0,
      strongBearishCandles: 0,
    };
  }

  const recent1m = candles1m.slice(-3);
  const minThreshold = indicators.atr * MOMENTUM_RANGE_MULTIPLIER;
  let netMomentum1m = 0;
  let bullishCandles = 0;
  let bearishCandles = 0;
  let strongBullishCandles = 0;
  let strongBearishCandles = 0;

  for (const candle of recent1m) {
    if (
      typeof candle.close !== 'number' ||
      typeof candle.open !== 'number' ||
      typeof candle.high !== 'number' ||
      typeof candle.low !== 'number'
    ) {
      continue;
    }

    const candleRange = candle.high - candle.low;
    const strongEnough = candleRange >= minThreshold;
    const delta = candle.close - candle.open;
    netMomentum1m += delta;

    if (delta > 0) {
      bullishCandles++;
      if (strongEnough) strongBullishCandles++;
    } else if (delta < 0) {
      bearishCandles++;
      if (strongEnough) strongBearishCandles++;
    }
  }

  let ready = false;
  let reason = null;
  if (action === 'BUY') {
    if (netMomentum1m <= 0) reason = 'NET_NOT_BULLISH';
    else if (netMomentum1m < minThreshold) reason = 'NET_TOO_WEAK';
    else if (bullishCandles < 2) reason = 'DIRECTION_INCONSISTENT';
    else if (strongBullishCandles < 2) reason = 'RANGE_TOO_WEAK';
    else ready = true;
  } else if (action === 'SELL') {
    if (netMomentum1m >= 0) reason = 'NET_NOT_BEARISH';
    else if (Math.abs(netMomentum1m) < minThreshold) reason = 'NET_TOO_WEAK';
    else if (bearishCandles < 2) reason = 'DIRECTION_INCONSISTENT';
    else if (strongBearishCandles < 2) reason = 'RANGE_TOO_WEAK';
    else ready = true;
  } else {
    reason = 'UNSUPPORTED_ACTION';
  }

  return {
    ready,
    reason,
    netMomentum1m: Number(netMomentum1m.toFixed(4)),
    minThreshold: Number(minThreshold.toFixed(4)),
    bullishCandles,
    bearishCandles,
    strongBullishCandles,
    strongBearishCandles,
  };
}

async function fetchWorkingOrders(session) {
  try {
    const { baseUrl, cst, securityToken } = session;
    const res = await fetchWithTimeout(`${baseUrl}/api/v1/workingorders`, {
      headers: {
        'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
        'CST': cst,
        'X-SECURITY-TOKEN': securityToken,
      },
    });

    if (res.status === 404) {
      return {
        supported: false,
        count: null,
        orders: [],
        reason: 'ENDPOINT_NOT_AVAILABLE',
      };
    }

    if (!res.ok) {
      return {
        supported: true,
        count: null,
        orders: [],
        reason: `HTTP_${res.status}`,
      };
    }

    const data = await res.json();
    const rawOrders = data.workingOrders || data.orders || [];
    const orders = rawOrders.filter((order) =>
      (order.marketData?.epic && order.marketData.epic.includes('GOLD')) ||
      (order.market?.epic && order.market.epic.includes('GOLD')) ||
      (order.workingOrderData?.epic && order.workingOrderData.epic.includes('GOLD'))
    );

    return {
      supported: true,
      count: orders.length,
      orders,
      reason: null,
    };
  } catch (err) {
    return {
      supported: false,
      count: null,
      orders: [],
      reason: err.message,
    };
  }
}

async function fetchGoldTransactions(session) {
  const { baseUrl, cst, securityToken } = session;
  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('.')[0];
  const to = new Date().toISOString().split('.')[0];
  const historyUrl = `${baseUrl}/api/v1/history/transactions?from=${from}&to=${to}`;

  const res = await fetchWithTimeout(historyUrl, {
    headers: {
      'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
      'CST': cst,
      'X-SECURITY-TOKEN': securityToken,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`History fetch failed (HTTP ${res.status}): ${body}`);
  }

  const data = await res.json();
  const transactions = Array.isArray(data.transactions) ? data.transactions : [];
  return transactions
    .filter((tx) => tx.instrumentName?.includes('GOLD'))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

function isClosedTradeTransaction(tx) {
  const note = String(tx?.note || '').toLowerCase();
  const pnl = Number(tx?.profitAndLoss);
  const hasNumericPnl = Number.isFinite(pnl);
  const looksLikeClosure =
    note.includes('closed') ||
    note.includes('stop') ||
    note.includes('limit') ||
    note.includes('liquid');
  const looksLikeOpen = note.includes('open') || note.includes('accepted');

  return hasNumericPnl && (looksLikeClosure || !looksLikeOpen);
}

function deriveOutcomesFromTransactions(transactions) {
  const seen = new Set();
  const outcomes = [];

  for (const tx of transactions) {
    if (!isClosedTradeTransaction(tx)) continue;

    const pnl = Number(tx.profitAndLoss);
    const dealId = tx.dealId ? String(tx.dealId) : null;
    const ref = tx.reference ? String(tx.reference) : null;
    const uniqueKey = dealId || `${tx.date}:${pnl}:${ref || 'no-ref'}`;
    if (seen.has(uniqueKey)) continue;
    seen.add(uniqueKey);

    outcomes.push({
      pnl: Number(pnl.toFixed(2)),
      action: null,
      closedAt: new Date(tx.date).getTime(),
      ref,
      dealId,
    });
  }

  return outcomes.sort((a, b) => a.closedAt - b.closedAt);
}

function deriveOutcomesFromBrokerStatsPnls(pnls) {
  if (!Array.isArray(pnls)) return [];

  return pnls
    .filter((pnl) => typeof pnl === 'number' && Number.isFinite(pnl))
    .map((pnl, index) => ({
      pnl: Number(pnl.toFixed(2)),
      action: null,
      closedAt: index + 1,
      ref: null,
      dealId: `broker_pnl_${index + 1}`,
    }));
}

function computeRollingMetrics(outcomes) {
  const numericOutcomes = (Array.isArray(outcomes) ? outcomes : [])
    .filter((item) => typeof item?.pnl === 'number' && Number.isFinite(item.pnl))
    .sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));

  const last10 = numericOutcomes.slice(-10);
  const last15 = numericOutcomes.slice(-15);

  const winRate10 = last10.length === 10
    ? Number(((last10.filter((item) => item.pnl > 0).length / 10) * 100).toFixed(2))
    : null;

  let grossProfit15 = null;
  let grossLoss15 = null;
  let profitFactor15 = null;
  if (last15.length === 15) {
    grossProfit15 = Number(last15
      .filter((item) => item.pnl > 0)
      .reduce((sum, item) => sum + item.pnl, 0)
      .toFixed(2));
    grossLoss15 = Number(Math.abs(last15
      .filter((item) => item.pnl < 0)
      .reduce((sum, item) => sum + item.pnl, 0))
      .toFixed(2));
    profitFactor15 = grossLoss15 === 0
      ? (grossProfit15 > 0 ? 999 : 0)
      : Number((grossProfit15 / grossLoss15).toFixed(2));
  }

  return {
    sourceCount: numericOutcomes.length,
    enoughForWR10: last10.length === 10,
    enoughForPF15: last15.length === 15,
    winRate10,
    profitFactor15,
    grossProfit15,
    grossLoss15,
    lastOutcomeAt: numericOutcomes.length > 0
      ? new Date(numericOutcomes[numericOutcomes.length - 1].closedAt).toISOString()
      : null,
  };
}

function computePerformanceReview(metrics) {
  const reasons = [];
  if (metrics.winRate10 != null && metrics.winRate10 < 50) {
    reasons.push(`Win Rate 10=${metrics.winRate10.toFixed(2)}% < 50%`);
  }
  if (metrics.profitFactor15 != null && metrics.profitFactor15 < 1) {
    reasons.push(`PF 15=${metrics.profitFactor15.toFixed(2)} < 1.00`);
  }

  return {
    performanceReviewNeeded: reasons.length > 0,
    performanceReviewReason: reasons.join(' | '),
  };
}

function diffTradeIds(localTrades, brokerPositions) {
  const localIds = new Set(
    (Array.isArray(localTrades) ? localTrades : [])
      .map((trade) => trade?.dealId ? String(trade.dealId) : null)
      .filter(Boolean)
  );
  const brokerIds = new Set(
    (Array.isArray(brokerPositions) ? brokerPositions : [])
      .map((position) => position?.position?.dealId ? String(position.position.dealId) : null)
      .filter(Boolean)
  );

  return {
    localOnly: [...localIds].filter((id) => !brokerIds.has(id)),
    brokerOnly: [...brokerIds].filter((id) => !localIds.has(id)),
  };
}

async function runReadinessAudit() {
  loadEnvLocal();
  await loadRuntimeModules();

  const fixes = [];
  const notes = [];

  const envSnapshot = buildEnvSnapshot();
  const redisReachable = await pingRedis();
  const botState = await loadState();
  const stateIntegrityOk = validateStateIntegrity(botState, 'pre-market-readiness-audit');

  if (process.env.CAPITAL_ENV === 'live' && process.env.LIVE_TRADING_MODE !== LIVE_CONFIRMATION) {
    const changed = upsertEnvVar(ENV_FILE, 'LIVE_TRADING_MODE', LIVE_CONFIRMATION);
    process.env.LIVE_TRADING_MODE = LIVE_CONFIRMATION;
    fixes.push({
      type: 'env',
      key: 'LIVE_TRADING_MODE',
      changed,
      newValue: LIVE_CONFIRMATION,
    });
  }

  if (process.env.MAX_SPREAD !== CANONICAL_MAX_SPREAD) {
    const changed = upsertEnvVar(ENV_FILE, 'MAX_SPREAD', CANONICAL_MAX_SPREAD);
    process.env.MAX_SPREAD = CANONICAL_MAX_SPREAD;
    fixes.push({
      type: 'env',
      key: 'MAX_SPREAD',
      changed,
      newValue: CANONICAL_MAX_SPREAD,
    });
  }

  const sltp = (() => {
    const strategy = extractStrategyMultipliers();
    const execution = extractExecutionMultipliers();
    const aligned =
      strategy.stopLossAtr === execution.stopLossAtr &&
      strategy.takeProfitAtr === execution.takeProfitAtr;

    return {
      aligned,
      strategy,
      execution,
      expected: { stopLossAtr: 1.5, takeProfitAtr: 2.25 },
      details: `Strategy SL=${strategy.stopLossAtr}, TP=${strategy.takeProfitAtr}; Execution SL=${execution.stopLossAtr}, TP=${execution.takeProfitAtr}`,
    };
  })();

  const spread = (() => {
    const extracted = extractSpreadFallbacks();
    const envValue = Number.isFinite(extracted.envValue) ? extracted.envValue : null;
    const canonical = Number(CANONICAL_MAX_SPREAD);
    const sourceFallbacksMatch = extracted.riskFallback === extracted.executionFallback;
    const envMatchesCanonical = envValue === canonical;
    const effectiveRisk = envValue ?? extracted.riskFallback;
    const effectiveExecution = envValue ?? extracted.executionFallback;

    return {
      sourceFallbacksMatch,
      envMatchesCanonical,
      effectiveMatch: effectiveRisk === effectiveExecution,
      canonical,
      riskFallback: extracted.riskFallback,
      executionFallback: extracted.executionFallback,
      envValue,
      details: `Risk fallback=${extracted.riskFallback}, Execution fallback=${extracted.executionFallback}, Env MAX_SPREAD=${envValue}`,
    };
  })();

  let session = null;
  let sessionError = null;
  let brokerPositions = [];
  let brokerStats = null;
  let workingOrders = {
    supported: false,
    count: null,
    orders: [],
    reason: 'NOT_ATTEMPTED',
  };
  let certainty = {
    ok: false,
    reason: 'NOT_ATTEMPTED',
  };
  let transactions = [];

  try {
    session = await getCapitalSession();
    brokerPositions = await fetchBrokerPositions(session) || [];
    brokerStats = await fetchBrokerTradeStats(session);
    workingOrders = await fetchWorkingOrders(session);
    certainty = await verifyExecutionCertainty(session, botState);
    transactions = await fetchGoldTransactions(session);
  } catch (err) {
    sessionError = err.message;
  }

  let outcomeSource = Array.isArray(botState.recentOutcomes) ? botState.recentOutcomes : [];
  let recentOutcomesChanged = false;
  let derivedOutcomes = deriveOutcomesFromTransactions(transactions);
  if (derivedOutcomes.length === 0 && Array.isArray(brokerStats?.pnls) && brokerStats.pnls.length > 0) {
    derivedOutcomes = deriveOutcomesFromBrokerStatsPnls(brokerStats.pnls);
    notes.push('Rolling metrics were derived from broker P&L history because closed-trade transaction parsing returned no discrete outcomes.');
  }
  if (derivedOutcomes.length > outcomeSource.filter((item) => typeof item?.pnl === 'number').length) {
    outcomeSource = derivedOutcomes;
    botState.recentOutcomes = derivedOutcomes.slice(-20);
    recentOutcomesChanged = true;
    fixes.push({
      type: 'state',
      key: 'recentOutcomes',
      changed: true,
      count: botState.recentOutcomes.length,
      source: 'broker_history',
    });
  }

  const rollingMetrics = computeRollingMetrics(outcomeSource);
  const rollingReview = computePerformanceReview(rollingMetrics);
  let rollingChanged = false;

  if (rollingMetrics.winRate10 !== botState.rollingWinRate10) {
    botState.rollingWinRate10 = rollingMetrics.winRate10;
    rollingChanged = true;
  }
  if (rollingMetrics.profitFactor15 !== botState.rollingProfitFactor15) {
    botState.rollingProfitFactor15 = rollingMetrics.profitFactor15;
    rollingChanged = true;
  }
  if (rollingMetrics.grossProfit15 !== botState.rollingGrossProfit15) {
    botState.rollingGrossProfit15 = rollingMetrics.grossProfit15 ?? 0;
    rollingChanged = true;
  }
  if (rollingMetrics.grossLoss15 !== botState.rollingGrossLoss15) {
    botState.rollingGrossLoss15 = rollingMetrics.grossLoss15 ?? 0;
    rollingChanged = true;
  }
  if (botState.performanceReviewNeeded !== rollingReview.performanceReviewNeeded) {
    botState.performanceReviewNeeded = rollingReview.performanceReviewNeeded;
    rollingChanged = true;
  }
  if (botState.performanceReviewReason !== rollingReview.performanceReviewReason) {
    botState.performanceReviewReason = rollingReview.performanceReviewReason;
    rollingChanged = true;
  }

  if (rollingChanged || recentOutcomesChanged) {
    await saveState(botState);
    if (rollingChanged) {
      fixes.push({
        type: 'state',
        key: 'rolling_metrics',
        changed: true,
        values: {
          rollingWinRate10: botState.rollingWinRate10,
          rollingProfitFactor15: botState.rollingProfitFactor15,
        },
      });
    }
  }

  let marketData = null;
  let indicators = null;
  let signal = null;
  let signalDebug = null;
  let momentumGate = null;
  let emaCrossover = null;
  let latestCandle = null;
  let candleTiming = {
    stale: null,
    secondsSinceClose: null,
    closeTime: null,
    reason: null,
  };

  if (session) {
    marketData = await getMarketData(session, {
      ...botState,
      lastProcessedCandle: 0,
    });

    if (marketData?.candles5m && marketData?.candles1h) {
      indicators = calculateIndicators(marketData.candles5m, marketData.candles1h);
      indicators.spread = marketData.spread ?? null;
      latestCandle = marketData.candles5m[marketData.candles5m.length - 1] || null;
      emaCrossover = computeEmaCrossover(indicators);

      const generated = summarizeSignal(indicators, marketData.candles1m);
      signal = generated.signal;
      signalDebug = generated.debug;
      const candidateAction = signal?.action || signalDebug?.dbgAction || emaCrossover?.direction || null;
      momentumGate = computeMomentumGate(indicators, marketData.candles1m, candidateAction);

      if (latestCandle) {
        const closeTime = latestCandle.time + (5 * 60 * 1000);
        const secondsSinceClose = (Date.now() - closeTime) / 1000;
        candleTiming = {
          stale: secondsSinceClose > 90,
          secondsSinceClose: Number(secondsSinceClose.toFixed(1)),
          closeTime: new Date(closeTime).toISOString(),
          reason: marketData.reason || indicators.reason || null,
        };
      }
    } else if (marketData?.reason) {
      candleTiming.reason = marketData.reason;
    }
  }

  const positionDiff = diffTradeIds(botState.openTrades, brokerPositions);
  const hasLocalPendingOrder = !!(botState.pendingOrder && botState.pendingOrder.status !== 'cleared');
  const hasBrokerWorkingOrders = typeof workingOrders.count === 'number' && workingOrders.count > 0;

  const passes = [];
  const blockers = [];

  if (envSnapshot.missingRequired.length === 0) passes.push('Required environment variables loaded');
  else blockers.push(`Missing required env vars: ${envSnapshot.missingRequired.join(', ')}`);

  if (redisReachable) passes.push('Redis reachable');
  else blockers.push('Redis unreachable');

  if (session) passes.push('Capital.com session established');
  else blockers.push(`Capital.com session unavailable: ${sessionError}`);

  if (process.env.CAPITAL_ENV !== 'live' || process.env.LIVE_TRADING_MODE === LIVE_CONFIRMATION) {
    passes.push('Live trading mode confirmation is valid');
  } else {
    blockers.push('LIVE_TRADING_MODE is not CONFIRMED_REAL_MONEY while CAPITAL_ENV=live');
  }

  if (sltp.aligned) passes.push('Strategy and execution SL/TP ATR multipliers are aligned');
  else blockers.push('SL/TP ATR multiplier mismatch');

  if (spread.sourceFallbacksMatch && spread.effectiveMatch && spread.envMatchesCanonical) {
    passes.push('Spread fallbacks and MAX_SPREAD are aligned');
  } else {
    blockers.push('Spread fallback / MAX_SPREAD mismatch');
  }

  if (rollingMetrics.enoughForWR10 && rollingMetrics.winRate10 != null) {
    passes.push('WR10 computed');
  } else {
    blockers.push('WR10 unavailable - insufficient or missing historical outcomes');
  }

  if (rollingMetrics.enoughForPF15 && rollingMetrics.profitFactor15 != null) {
    passes.push('PF15 computed');
  } else {
    blockers.push('PF15 unavailable - insufficient or missing historical outcomes');
  }

  if (stateIntegrityOk) passes.push('Local state integrity check passed');
  else blockers.push('Local state integrity failed');

  if (certainty.ok) passes.push('Local open trades match broker positions');
  else if (session) blockers.push(`Execution certainty failed: ${certainty.reason}`);

  if (!hasLocalPendingOrder && !hasBrokerWorkingOrders) {
    passes.push('No unresolved pending orders');
  } else {
    blockers.push('Pending orders or working orders are still active');
  }

  if (indicators && !indicators.skip && latestCandle) {
    passes.push('Latest 5m candle and indicators loaded');
    if (candleTiming.stale) blockers.push(`Latest 5m candle is stale (${candleTiming.secondsSinceClose}s since close)`);
    else passes.push('Latest 5m candle is fresh enough for execution timing');
  } else if (marketData?.reason || indicators?.reason) {
    blockers.push(`Indicator readiness failed: ${marketData?.reason || indicators?.reason}`);
  }

  const liveSpread = typeof marketData?.spread === 'number' ? marketData.spread : null;
  const maxSpread = Number(process.env.MAX_SPREAD);
  if (liveSpread != null && Number.isFinite(maxSpread)) {
    if (liveSpread <= maxSpread) {
      passes.push('Current live spread is within MAX_SPREAD');
    } else {
      blockers.push(`Current live spread ${liveSpread.toFixed(2)} exceeds MAX_SPREAD ${maxSpread.toFixed(2)}`);
    }
  }

  if (positionDiff.localOnly.length === 0 && positionDiff.brokerOnly.length === 0) {
    passes.push('Local/broker position IDs are in sync');
  } else {
    blockers.push('Local and broker position IDs differ');
  }

  if (workingOrders.reason && workingOrders.reason !== 'ENDPOINT_NOT_AVAILABLE' && workingOrders.reason !== 'NOT_ATTEMPTED' && workingOrders.count == null) {
    notes.push(`Broker working-order check returned: ${workingOrders.reason}`);
  }

  const ready = blockers.length === 0;
  const report = {
    generatedAt: new Date().toISOString(),
    targetTradingDate: TARGET_TRADING_DATE,
    ready,
    blockersRemaining: blockers,
    passes,
    environment: buildEnvSnapshot(),
    redis: {
      reachable: redisReachable,
      stateKey: 'bot_state',
    },
    sltpAlignment: sltp,
    rollingMetricsStatus: {
      sourceCount: rollingMetrics.sourceCount,
      enoughForWR10: rollingMetrics.enoughForWR10,
      enoughForPF15: rollingMetrics.enoughForPF15,
      rollingWinRate10: rollingMetrics.winRate10,
      rollingProfitFactor15: rollingMetrics.profitFactor15,
      rollingGrossProfit15: rollingMetrics.grossProfit15,
      rollingGrossLoss15: rollingMetrics.grossLoss15,
      performanceReviewNeeded: botState.performanceReviewNeeded,
      performanceReviewReason: botState.performanceReviewReason,
      source: derivedOutcomes.length > 0 ? 'broker_history_or_recent_outcomes' : 'state_only',
    },
    indicatorReadiness: {
      marketDataSkip: marketData?.skip ?? null,
      marketDataReason: marketData?.reason ?? null,
      latest5mCandleTime: latestCandle ? new Date(latestCandle.time).toISOString() : null,
      latest5mCloseTime: candleTiming.closeTime,
      candleStale: candleTiming.stale,
      secondsSinceClose: candleTiming.secondsSinceClose,
      atr: indicators?.atr ?? null,
      rsi: indicators?.rsi ?? null,
      ema20: indicators?.currEMA20 ?? null,
      ema50: indicators?.currEMA50 ?? null,
      emaCrossover,
      signalCandidate: signal ? {
        action: signal.action,
        entryType: signal.entryType,
        score: signal.score,
      } : null,
      momentumGate,
      pullbackSlope: indicators ? {
        slopePercent: indicators.slopePercent,
        threshold: PULLBACK_SLOPE_THRESHOLD,
        buyReady: indicators.slopePercent >= PULLBACK_SLOPE_THRESHOLD,
        sellReady: indicators.slopePercent <= -PULLBACK_SLOPE_THRESHOLD,
      } : null,
      debugRejectReason: signalDebug?.dbgRejectReason ?? null,
      spread: marketData?.spread ?? null,
    },
    spreadCheck: spread,
    positionsAndStateIntegrity: {
      stateIntegrityOk,
      executionCertaintyOk: certainty.ok,
      executionCertaintyReason: certainty.reason,
      localOpenTradesCount: Array.isArray(botState.openTrades) ? botState.openTrades.length : 0,
      brokerPositionsCount: brokerPositions.length,
      localOnlyDealIds: positionDiff.localOnly,
      brokerOnlyDealIds: positionDiff.brokerOnly,
      localPendingOrder: botState.pendingOrder,
      brokerWorkingOrdersSupported: workingOrders.supported,
      brokerWorkingOrdersCount: workingOrders.count,
    },
    executionDefaults: {
      capitalEnv: process.env.CAPITAL_ENV || null,
      liveTradingMode: process.env.LIVE_TRADING_MODE || null,
      maxSpread: process.env.MAX_SPREAD || null,
      strategyStopLossAtr: sltp.strategy.stopLossAtr,
      strategyTakeProfitAtr: sltp.strategy.takeProfitAtr,
      executionStopLossAtr: sltp.execution.stopLossAtr,
      executionTakeProfitAtr: sltp.execution.takeProfitAtr,
    },
    brokerSummary: brokerStats ? {
      totalTrades30d: brokerStats.totalTrades,
      totalPnl30d: brokerStats.totalPnl,
      grossProfit30d: brokerStats.grossProfit,
      grossLoss30d: brokerStats.grossLoss,
      todayTrades: brokerStats.todayTrades,
      todayNetPnl: brokerStats.todayNetPnl,
      todayWinRate: brokerStats.todayWinRate,
    } : null,
    detailedNotes: notes,
    fixesAppliedAutomatically: fixes,
  };

  const outputPath = `tmp/pre_market_readiness_${TARGET_TRADING_DATE}.json`;
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${outputPath}`);

  if (!ready) {
    process.exitCode = 1;
  }
}

runReadinessAudit().catch((err) => {
  console.error(JSON.stringify({
    ready: false,
    blockersRemaining: [`Audit failed: ${err.message}`],
  }, null, 2));
  process.exitCode = 1;
});
