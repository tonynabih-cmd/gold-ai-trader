import fs from 'fs';
import { fileURLToPath } from 'url';

import { getCapitalSession } from '../lib/session.js';
import { getMarketData } from '../lib/market_data.js';
import { calculateIndicators } from '../lib/indicators.js';
import { loadState } from '../lib/state.js';

function loadEnvLocal(filepath = '.env.local') {
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

function readText(path) {
  return fs.readFileSync(path, 'utf8');
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

function buildSltpAudit() {
  const strategy = extractStrategyMultipliers();
  const execution = extractExecutionMultipliers();

  const slAligned = strategy.stopLossAtr === execution.stopLossAtr;
  const tpAligned = strategy.takeProfitAtr === execution.takeProfitAtr;

  return {
    ok: slAligned && tpAligned,
    strategy,
    execution,
    expected: { stopLossAtr: 1.5, takeProfitAtr: 2.25 },
    details: `Strategy SL=${strategy.stopLossAtr}, TP=${strategy.takeProfitAtr}; Execution SL=${execution.stopLossAtr}, TP=${execution.takeProfitAtr}`,
  };
}

function buildRollingAudit(botState) {
  return {
    rollingWR_OK: botState.rollingWinRate10 !== null,
    rollingPF_OK: botState.rollingProfitFactor15 !== null,
    details: `WR10=${botState.rollingWinRate10}, PF15=${botState.rollingProfitFactor15}`,
  };
}

function buildPositionAudit(botState) {
  const openTrades = Array.isArray(botState.openTrades) ? botState.openTrades : [];
  const hasPendingOrder = botState.pendingOrder && botState.pendingOrder.status !== 'cleared';

  return {
    openTradesCount: openTrades.length,
    pendingOrderStatus: hasPendingOrder ? botState.pendingOrder.status : null,
    ready: openTrades.length === 0 && !hasPendingOrder,
  };
}

async function buildIndicatorAudit(botState) {
  try {
    const session = await getCapitalSession();
    const marketData = await getMarketData(session, {
      ...botState,
      lastProcessedCandle: 0,
    });

    if (marketData.skip) {
      return {
        ok: false,
        details: marketData.reason,
      };
    }

    const indicators = calculateIndicators(marketData.candles5m, marketData.candles1h);
    if (indicators.skip) {
      return {
        ok: false,
        details: indicators.reason,
      };
    }

    return {
      ok: true,
      ATR: indicators.atr,
      EMA20: indicators.currEMA20,
      EMA50: indicators.currEMA50,
      RSI: indicators.rsi,
      spread: marketData.spread,
      details: `ATR=${indicators.atr?.toFixed?.(2) ?? indicators.atr}, EMA20=${indicators.currEMA20?.toFixed?.(2) ?? indicators.currEMA20}, EMA50=${indicators.currEMA50?.toFixed?.(2) ?? indicators.currEMA50}, RSI=${indicators.rsi?.toFixed?.(2) ?? indicators.rsi}, spread=${marketData.spread}`,
    };
  } catch (err) {
    return {
      ok: false,
      details: `Indicator audit failed: ${err.message}`,
    };
  }
}

function buildSpreadAudit() {
  const spread = extractSpreadFallbacks();
  const effective = Number.isFinite(spread.envValue) ? spread.envValue : null;
  const effectiveRisk = effective ?? spread.riskFallback;
  const effectiveExecution = effective ?? spread.executionFallback;

  return {
    sourceFallbacksMatch: spread.riskFallback === spread.executionFallback,
    effectiveMatch: effectiveRisk === effectiveExecution,
    riskFallback: spread.riskFallback,
    executionFallback: spread.executionFallback,
    envValue: effective,
    details: `Risk fallback=${spread.riskFallback}, Execution fallback=${spread.executionFallback}, Env MAX_SPREAD=${effective}`,
  };
}

export async function runPreMarketAudit() {
  loadEnvLocal();

  const botState = await loadState();
  const sltp = buildSltpAudit();
  const rolling = buildRollingAudit(botState);
  const positions = buildPositionAudit(botState);
  const indicators = await buildIndicatorAudit(botState);
  const spread = buildSpreadAudit();

  const ready =
    sltp.ok &&
    rolling.rollingWR_OK &&
    rolling.rollingPF_OK &&
    positions.ready &&
    indicators.ok &&
    spread.effectiveMatch;

  const report = {
    generatedAt: new Date().toISOString(),
    ready,
    sltp,
    rolling,
    positions,
    indicators,
    spread,
  };

  console.log('Pre-Market Readiness Audit (Gold Bot)');
  console.log(JSON.stringify(report, null, 2));

  if (!spread.sourceFallbacksMatch) {
    console.warn('WARNING: Source defaults differ between risk and execution spread checks.');
  }

  console.log(`\nBot Pre-Market Status: ${ready ? 'READY' : 'NOT READY'}`);
  return report;
}

const isDirectRun =
  process.argv[1] &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (isDirectRun) {
  runPreMarketAudit().catch((err) => {
    console.error('Audit failed:', err.message);
    process.exitCode = 1;
  });
}
