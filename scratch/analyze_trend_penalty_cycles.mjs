import fs from 'node:fs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg.startsWith('--')) {
    args.set(arg.slice(2), process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true');
  }
}

const file = args.get('file') || 'C:/tmp/gold_logs_monitor_initial.json';
const after = args.get('after') || '2026-05-01T17:13:34Z';
const limit = Number(args.get('limit') || 300);

const logs = JSON.parse(fs.readFileSync(file, 'utf8'));
const afterMs = Date.parse(after);

function pct(n, d) {
  return d > 0 ? Number(((n / d) * 100).toFixed(1)) : 0;
}

function reasonOf(log) {
  return String(log.dbgRejectReason || log.reason || '');
}

function isOldTrendHardReject(log) {
  return reasonOf(log).startsWith('Regime: 1h trend conflict');
}

function isTrendPenaltyCase(log) {
  return (
    log.dbgTrendConflict === true ||
    log.trendConflict === true ||
    log.setupConfidence?.trendConflict === true ||
    Number(log.dbgTrendConflictPenalty) < 0 ||
    Number(log.trendConflictPenalty) < 0 ||
    Number(log.setupConfidence?.trendConflictPenalty) < 0
  );
}

function isNoPriorExpansionReject(log) {
  return reasonOf(log).includes('No prior EMA expansion detected leading into pullback');
}

function isRealSignal(log) {
  return log.signalDetected === 'BUY' || log.signalDetected === 'SELL';
}

function setupConfidenceScore(log) {
  const n = Number(log.setupConfidenceScore ?? log.dbgSetupConfidenceScore ?? log.score ?? log.dbgScore);
  return Number.isFinite(n) ? n : null;
}

function initialRewardRisk(log) {
  const n = Number(log.initialRewardRisk ?? log.dbgInitialRewardRisk);
  return Number.isFinite(n) ? n : null;
}

function passesConfidenceAndReward(log) {
  const score = setupConfidenceScore(log);
  const rr = initialRewardRisk(log);
  return score !== null && score >= 75 && rr !== null && rr >= 2.5;
}

const riskRejectPrefixes = [
  'SKIP: Initial reward/risk',
  'SKIP: Setup confidence score',
  'STOP:',
  'DISABLE:',
  'PAUSE:',
];

const executionGatePrefixes = [
  'SKIP: Missing execution lock handle',
  'SKIP: Lock ownership lost',
  'SKIP: Lock renewal failed',
  'SKIP: Race condition detected during execution gate',
];

function isExecutionAttempt(log) {
  if (!isRealSignal(log)) return false;
  if (log.tradeExecuted === true || log.brokerResponse) return true;
  const reason = String(log.reason || '');
  if (riskRejectPrefixes.some((prefix) => reason.startsWith(prefix))) return false;
  if (executionGatePrefixes.some((prefix) => reason.startsWith(prefix))) return false;
  return (
    reason.startsWith('ERROR:') ||
    reason.startsWith('REJECTED:') ||
    reason.startsWith('SKIPPED:') ||
    reason.startsWith('CRITICAL_FAILURE')
  );
}

const sample = logs
  .filter((log) => Date.parse(log.time) >= afterMs)
  .slice(0, limit);

const setupCandidates = sample.filter((log) => log.dbgSetupReady === true || isRealSignal(log));
const rejected = sample.filter((log) => !log.tradeExecuted && reasonOf(log));

const rejectCounts = new Map();
for (const log of rejected) {
  const reason = reasonOf(log);
  rejectCounts.set(reason, (rejectCounts.get(reason) || 0) + 1);
}

const topRejects = [...rejectCounts.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8)
  .map(([reason, count]) => ({
    reason,
    count,
    pctCycles: pct(count, sample.length),
    pctSetupCandidates: pct(count, setupCandidates.length),
  }));

const counts = {
  cycles: sample.length,
  setupCandidates: setupCandidates.length,
  old1hHardRejects: sample.filter(isOldTrendHardReject).length,
  trendConflictPenaltyCases: sample.filter(isTrendPenaltyCase).length,
  noPriorEmaExpansionRejects: sample.filter(isNoPriorExpansionReject).length,
  realBuySellSignals: sample.filter(isRealSignal).length,
  setupsPassingConfidenceAnd2_5R: setupCandidates.filter(passesConfidenceAndReward).length,
  executionAttempts: sample.filter(isExecutionAttempt).length,
  trades: sample.filter((log) => log.tradeExecuted === true).length,
};

const percentages = {
  old1hHardRejectsPctCycles: pct(counts.old1hHardRejects, counts.cycles),
  trendConflictPenaltyPctCycles: pct(counts.trendConflictPenaltyCases, counts.cycles),
  noPriorEmaExpansionPctCycles: pct(counts.noPriorEmaExpansionRejects, counts.cycles),
  noPriorEmaExpansionPctSetupCandidates: pct(counts.noPriorEmaExpansionRejects, counts.setupCandidates),
  realSignalPctCycles: pct(counts.realBuySellSignals, counts.cycles),
  qualityPassPctSetupCandidates: pct(counts.setupsPassingConfidenceAnd2_5R, counts.setupCandidates),
  executionAttemptPctSignals: pct(counts.executionAttempts, counts.realBuySellSignals),
  tradePctSignals: pct(counts.trades, counts.realBuySellSignals),
};

const dominant = topRejects.find((item) => item.pctCycles >= 40 || item.pctSetupCandidates >= 60) || null;

console.log(JSON.stringify({
  sourceFile: file,
  after,
  firstCycle: sample[0]?.time || null,
  lastCycle: sample.at(-1)?.time || null,
  counts,
  percentages,
  topRejects,
  nextBottleneck: dominant
    ? {
        reason: dominant.reason,
        pctCycles: dominant.pctCycles,
        pctSetupCandidates: dominant.pctSetupCandidates,
        thresholdMet: dominant.pctCycles >= 40 ? '>=40% of cycles' : '>=60% of setup candidates',
      }
    : null,
  strategyChangeAllowedByRule: Boolean(dominant),
}, null, 2));
