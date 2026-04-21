import { getCapitalSession }               from '../lib/session.js';
import { getMarketData }                   from '../lib/market_data.js';
import { calculateIndicators }             from '../lib/indicators.js';
import { generateSignal, STRATEGY_VERSION } from '../lib/strategy.js';
import { checkRisk, calculateDrawdown, getAdaptiveSpreadLimit }              from '../lib/risk.js';
import { placeTrade, syncBalance, fetchClosedTradePnl, fetchBrokerTradeStats, fetchBrokerPositions, verifyExecutionCertainty, SYNC_WINDOW_MS, fetchCurrentGoldPrice, USD_AED_PEG, modifyTradeStopLoss } from '../lib/execution.js';
import { saveLog, getLogs }                from '../lib/logger.js';
import { loadState, saveState, saveStateWithOptions, saveStateCritical, dailyReset, acquireCandleLock, validateStateIntegrity, createLockOwnerToken, verifyCandleLockOwnership, renewCandleLock, releaseCandleLock, pingRedis, CANDLE_LOCK_TTL_SECONDS } from '../lib/state.js';
import { sendAlert, checkPerformance }     from '../lib/monitor.js';
import { fetchWithTimeout }                from '../lib/fetch.js';

// How long to suppress repeated Telegram alerts for persistent disabled/critical states.
// Prevents flooding Telegram every 5 minutes while the bot awaits manual intervention.
const ALERT_THROTTLE_MS = 60 * 60 * 1000; // 1 hour
const DEBUG_SYNC_RECON = process.env.DEBUG_SYNC_RECON === 'true';


/**
 * Reconciles local openTrades with broker's actual open positions.
 * 
 * DESIGN PRINCIPLES:
 * 1. Broker is the source of truth — if it's not on the broker, it's closed.
 * 2. If a position exists on broker but NOT locally, ADOPT it (not "discover" it).
 *    This means rebuilding local state from broker data so it's properly tracked.
 * 3. Every state change (close detected, position adopted) triggers an immediate save.
 * 4. All transitions are logged with structured [SYNC] prefix.
 */
async function reconcilePositions(session, botState) {
  try {
    const livePositions = await fetchBrokerPositions(session);

    if (livePositions === null) {
      return { botState, haltReason: 'BROKER_STATE_UNAVAILABLE' };
    }

    // Build lookup of live positions STRICTLY by dealId
    const liveByDealId = new Map();
    for (const pos of livePositions) {
      const dealId = pos.position?.dealId;
      if (dealId) {
        liveByDealId.set(String(dealId), pos);
      } else {
        console.error('[SYNC] Broker position missing dealId', pos.position);
      }
    }

    const localTrades = Array.isArray(botState.openTrades) ? botState.openTrades : [];
    const stillOpen = [];
    const justClosed = [];

    // --- Phase 1: Reconcile existing local trades ---
    for (const trade of localTrades) {
      const dealId = trade.dealId ? String(trade.dealId) : null;
      
      if (!dealId) {
        console.error('[SYNC] Local trade missing dealId — this is a critical state error', trade);
        return {
          botState,
          haltReason: `LOCAL_TRADE_MISSING_DEAL_ID:${trade.tradeId || 'unknown'}`,
        };
      }

      const livePos = liveByDealId.get(dealId);

      if (livePos) {
        // Trade is still open on broker — reset sync-tracking fields
        trade.missingCount  = 0;
        trade.firstMissingAt = null;
        stillOpen.push(trade);
        // Remove from lookup to mark as "already tracked"
        liveByDealId.delete(dealId);
      } else {
        // Trade not found in live positions — check transaction history.
        // Set firstMissingAt on the very first cycle it disappears so we can
        // track elapsed time (wall-clock, not cycle count) for the sync window.
        if (!trade.firstMissingAt) {
          trade.firstMissingAt = Date.now();
          console.warn(`[SYNC] Trade ${dealId} first disappeared from active positions at ${new Date(trade.firstMissingAt).toISOString()}.`);
          await saveLog({
            signal: { id: trade.tradeId, action: trade.action, entryType: 'sync_event', entryPrice: null, strategyVersion: trade.strategyVersion || STRATEGY_VERSION },
            indicators: null,
            botState: { ...botState },
            tradeExecuted: false,
            reason: `SYNC_DISAPPEAR: dealId=${dealId} not found in active positions. firstMissingAt=${new Date(trade.firstMissingAt).toISOString()} | entry=${trade.entry}`,
            result: null,
          }).catch(() => {});
        }

        const elapsedMs  = Date.now() - trade.firstMissingAt;
        const elapsedMin = Math.floor(elapsedMs / 60000);

        // Check transaction history (internal retry handles transient API delays).
        // Capital.com closure history can surface under either the live position dealId
        // or the original order dealReference, so try both identifiers before entering
        // the cross-cycle retry window.
        if (DEBUG_SYNC_RECON) {
          console.log('[SYNC_DEBUG] Missing trade lookup start', {
            dealId,
            dealReference: trade.dealReference ?? null,
            openedAt: trade.openedAt ?? null,
            openedAtIso: trade.openedAt ? new Date(trade.openedAt).toISOString() : null,
            firstMissingAt: trade.firstMissingAt ?? null,
          });
        }
        let realizedPnl = await fetchClosedTradePnl(session, dealId, trade.openedAt);
        if (DEBUG_SYNC_RECON) {
          console.log('[SYNC_DEBUG] Lookup by dealId complete', {
            targetId: dealId,
            attempted: true,
            resolved: realizedPnl !== null,
            realizedPnl,
          });
        }
        if (
          realizedPnl === null &&
          trade.dealReference &&
          String(trade.dealReference) !== String(dealId)
        ) {
          if (DEBUG_SYNC_RECON) {
            console.log('[SYNC_DEBUG] Lookup by dealReference start', {
              targetId: trade.dealReference,
              attempted: true,
            });
          }
          realizedPnl = await fetchClosedTradePnl(session, trade.dealReference, trade.openedAt);
          if (DEBUG_SYNC_RECON) {
            console.log('[SYNC_DEBUG] Lookup by dealReference complete', {
              targetId: trade.dealReference,
              attempted: true,
              resolved: realizedPnl !== null,
              realizedPnl,
            });
          }
        } else if (DEBUG_SYNC_RECON) {
          console.log('[SYNC_DEBUG] Lookup by dealReference skipped', {
            dealReference: trade.dealReference ?? null,
            sameAsDealId: String(trade.dealReference) === String(dealId),
            missingDealReference: !trade.dealReference,
          });
        }

        if (realizedPnl !== null) {
          trade.realizedPnl = realizedPnl;
          justClosed.push(trade);
          console.log(`[SYNC] ✅ Confirmed closure for dealId ${dealId} | P&L ${realizedPnl} | elapsed ${elapsedMin}m`);
        } else if (elapsedMs < SYNC_WINDOW_MS) {
          // Within sync window — keep tracked, do NOT block new trades
          console.warn(`[SYNC] Trade ${dealId} still missing from history (${elapsedMin}m / ${Math.floor(SYNC_WINDOW_MS / 60000)}m). Awaiting broker sync.`);
          await saveLog({
            signal: { id: trade.tradeId, action: trade.action, entryType: 'sync_event', entryPrice: null, strategyVersion: trade.strategyVersion || STRATEGY_VERSION },
            indicators: null,
            botState: { ...botState },
            tradeExecuted: false,
            reason: `SYNC_RETRY: dealId=${dealId} still missing at ${elapsedMin}m. Awaiting transaction history (window: ${Math.floor(SYNC_WINDOW_MS / 60000)}m).`,
            result: null,
          }).catch(() => {});
          stillOpen.push(trade);
        } else {
          // Sync window exceeded — force-resolve as closed.
          // Attempt P&L estimation using a live GOLD price snapshot.
          // If estimation is impossible, realizedPnl is set to null (not $0) so that
          // anti-chop streak logic is NOT corrupted by a fake zero-P&L entry.
          let estimatedPnl = null;
          try {
            const priceSnapshot = await fetchCurrentGoldPrice(session);
            if (
              priceSnapshot &&
              Number.isFinite(trade.entry) && trade.entry > 0 &&
              Number.isFinite(trade.size)  && trade.size  > 0 &&
              (trade.action === 'BUY' || trade.action === 'SELL')
            ) {
              const currentPrice = trade.action === 'BUY' ? priceSnapshot.bid : priceSnapshot.offer;
              if (Number.isFinite(currentPrice) && currentPrice > 0) {
                estimatedPnl = parseFloat(
                  ((currentPrice - trade.entry) * (trade.action === 'BUY' ? 1 : -1) * trade.size).toFixed(2)
                );
              }
            }
          } catch (_) { /* estimatedPnl remains null */ }

          trade.isMIA        = true;
          trade.fallbackUsed = true;
          justClosed.push(trade);

          // P&L Estimation AED conversion: Gold price is in USD, so estimatedPnl is in USD.
          // Convert to AED before storing/logging so it matches account currency.
          let pnlLogStr = 'unknown (null — excluded from performance metrics)';
          if (typeof estimatedPnl === 'number') {
            const estimatedPnlAED = parseFloat((estimatedPnl * USD_AED_PEG).toFixed(2));
            trade.realizedPnl = estimatedPnlAED;
            pnlLogStr = `estimated AED ${estimatedPnlAED.toFixed(2)} (approx $${estimatedPnl.toFixed(2)})`;
          } else {
            trade.realizedPnl = null;
          }

          console.log(`[SYNC] Fallback triggered after 8m for dealId=${dealId}. Transaction history lookup failed.`);
          console.error(`[SYNC] ⚠️ FALLBACK_RESOLUTION_USED: dealId=${dealId} missing after ${elapsedMin}m. Forcing closure. P&L: ${pnlLogStr}`);
          
          if (Array.isArray(botState.openTrades)) {
            const _idx = botState.openTrades.findIndex(t => String(t?.dealId) === String(dealId));
            if (_idx !== -1) botState.openTrades.splice(_idx, 1);
          }
          await saveState(botState);
          await sendAlert(
            `⚠️ FALLBACK RESOLUTION: Trade ${dealId} (${trade.action}) disappeared after ${elapsedMin}m without history.\n` +
            `P&L: ${pnlLogStr}\nEntry: $${trade.entry?.toFixed(2) ?? '?'} | Size: ${trade.size}oz\n` +
            `Check broker for manual closure or liquidation.`
          ).catch(() => {});
        }
      }
    }

    // --- Phase 2: Process confirmed closures ---
    for (const closedTrade of justClosed) {
      const dealId      = closedTrade.dealId;
      const realizedPnl = closedTrade.realizedPnl;
      const pnlStr      = realizedPnl != null ? `$${realizedPnl.toFixed(2)}` : 'null (unknown)';
      const closureTag  = closedTrade.fallbackUsed ? 'FALLBACK_RESOLUTION_USED' : 'CONFIRMED';

      console.log(`[SYNC] ❌ TRADE CLOSED [${closureTag}]: ${closedTrade.action} ${closedTrade.size}oz GOLD | dealId=${dealId} | entry=${closedTrade.entry} | P&L=${pnlStr}`);

      await saveLog({
        signal: {
          id: closedTrade.tradeId,
          action: closedTrade.action === 'BUY' ? 'SELL' : 'BUY',
          entryType: 'closure',
          entryPrice: null,
          strategyVersion: closedTrade.strategyVersion || STRATEGY_VERSION
        },
        indicators: null,
        botState: { ...botState },
        tradeExecuted: false,
        reason: `CLOSED: ${closureTag} | Realized P&L: ${pnlStr} | entry=${closedTrade.entry} | dealId=${dealId}`,
        result: { realizedPnl, fallbackUsed: closedTrade.fallbackUsed || false }
      });

      // Only send a closure alert for confirmed closures — fallback closures already
      // sent an alert during Phase 1 when force-resolution was triggered.
      if (!closedTrade.fallbackUsed && realizedPnl != null) {
        await sendAlert(
          `📉 Trade CLOSED: ${closedTrade.action} Gold\n` +
          `Entry: $${closedTrade.entry?.toFixed(2) ?? '?'}\n` +
          `P&L: ${pnlStr}\n` +
          `dealId: ${dealId}`
        );
      }
    }

    // --- Phase 3: Adopt remaining broker positions ---
    // Any broker positions left in liveByDealId are NOT tracked locally.
    for (const [dealId, pos] of liveByDealId) {
      const brokerSize = Number(pos.position?.size ?? pos.position?.dealSize);
      const brokerDirection = String(pos.position?.direction || '').toUpperCase();
      const brokerEpic = pos.market?.epic || pos.position?.instrumentName || 'GOLD';

      if (!Number.isFinite(brokerSize) || brokerSize <= 0 || (brokerDirection !== 'BUY' && brokerDirection !== 'SELL')) {
        console.error(`[SYNC] Invalid broker position data for ${dealId}`, pos);
        continue;
      }

      // STRICT ANTI-DUPLICATION
      const alreadyTracked = stillOpen.some(t => String(t.dealId) === String(dealId));
      if (alreadyTracked) {
        console.warn(`[SYNC] Anti-duplication: Skipping adoption of ${dealId} as it is already tracked.`);
        continue;
      }

      const adoptedTrade = {
        tradeId:         `adopted_${dealId}`,
        dealId:          dealId,
        dealReference:   pos.position?.dealReference || null,
        pair:            brokerEpic,
        action:          brokerDirection,
        entry:           Number(pos.position?.openLevel ?? pos.position?.level ?? 0),
        size:            brokerSize,
        stopLoss:        Number(pos.position?.stopLevel ?? 0) || null,
        takeProfit:      Number(pos.position?.limitLevel ?? 0) || null,
        notionalValue:   null,
        marginRequired:  null,
        actualRiskDollars: null,
        openedAt:        pos.position?.createdDateUTC ? new Date(pos.position.createdDateUTC).getTime() : Date.now(),
        strategyVersion: 'adopted',
        missingCount:    0,
      };

      stillOpen.push(adoptedTrade);
      console.warn(`[SYNC] ⚠️ ADOPTED untracked broker position: ${brokerDirection} ${brokerSize}oz ${brokerEpic} | dealId=${dealId}`);
      await sendAlert(`⚠️ Bot adopted untracked broker position: ${brokerDirection} ${brokerSize}oz ${brokerEpic} | dealId=${dealId}`).catch(() => {});
    }

    botState.openTrades = [...stillOpen];
    botState.lastStateSyncAt = Date.now();

    if (justClosed.length > 0) {
      // Track ALL outcomes (wins AND losses) so that a win resets the anti-chop streak.
      // Previously only losses were pushed, which meant the anti-chop could never be
      // cleared once 2 consecutive losses accumulated — effectively disabling the bot
      // permanently after 2 losses until a manual Redis state reset.
      //
      // Idempotency: use dealId to prevent duplicate entries if the same trade is
      // processed more than once (e.g. after a retry cycle).
      // Null P&L (fallback-resolved MIA trades) is intentionally excluded so that a
      // forced $0 closure cannot corrupt the anti-chop loss-streak counter.
      botState.recentOutcomes = Array.isArray(botState.recentOutcomes) ? botState.recentOutcomes : [];
      const existingDealIds   = new Set(botState.recentOutcomes.map(o => o.dealId).filter(Boolean));
      const outcomes = justClosed
        .filter(t => typeof t.realizedPnl === 'number' && !existingDealIds.has(t.dealId))
        .map(t => ({
          pnl:      t.realizedPnl,
          action:   t.action,
          entryType: t.entryType || 'pullback',
          closedAt: Date.now(),
          ref:      t.dealReference,
          dealId:   t.dealId,
        }));
      if (outcomes.length > 0) {
        botState.recentOutcomes.push(...outcomes);
        botState.recentOutcomes = botState.recentOutcomes.slice(-20);
      }

      const saved = await saveStateCritical(botState, `reconcile:closed=${justClosed.length}`);
      if (!saved) {
        return {
          botState,
          haltReason: 'CRITICAL_FAILURE:RECONCILIATION_SAVE_FAILED',
        };
      }
    }

    return { botState, haltReason: null };
  } catch (err) {
    return {
      botState,
      haltReason: `RECONCILIATION_ERROR:${err.message}`,
    };
  }
}

function shouldFinalizeRiskOutcome(botState, signal) {
  // If strategy generated no signal, do NOT finalize yet. Allow retries within the window.
  if (!signal) return false;

  // Do not finalize on manual/infrastructure/uncertain state failures.
  if (botState.botEnabled === false) return false;
  if (botState.stateIntegrityOk === false) return false;
  if (botState.criticalFailure === true) return false;
  if (botState.riskDataFresh !== true) return false;

  const riskSyncAgeMs = Date.now() - (parseInt(botState.lastRiskSyncAt) || 0);
  if (riskSyncAgeMs > 6 * 60 * 1000) return false;

  // Remaining risk rejections are business-final decisions for this candle.
  return true;
}

function shouldFinalizeTradeFailure(tradeResult) {
  const reason = String(tradeResult?.reason || '');
  if (!reason) return false;

  // Do not finalize on uncertain/transient execution failures.
  if (reason.startsWith('CRITICAL_FAILURE')) return false;
  if (reason.startsWith('ERROR:')) return false;
  if (reason.startsWith('REJECTED: Market snapshot unavailable')) return false;
  if (reason === 'REJECTED: Invalid live bid/ask snapshot') return false;

  // Transient market microstructure conditions — slippage and spread can improve
  // within the same 5m candle window. Do not finalize; allow retry on next GHA cycle
  // within the 295s stale ceiling. The Redis candle lock (released in finally block)
  // and verifyExecutionCertainty() prevent double-execution if retry succeeds.
  if (reason.startsWith('REJECTED: Slippage too high')) return false;
  if (reason.startsWith('REJECTED: Spread too wide')) return false;
  if (reason === 'SKIPPED: slippage too high') return false;

  // Remaining placeTrade() failures are definitive no-trade outcomes for this candle.
  return true;
}

function formatTrendStatus(indicators) {
  if (!indicators) return 'N/A (not evaluated)';

  const trend = indicators.trend1h ?? 'N/A';
  const reason = indicators.trendReason || (
    trend === 'UP' ? 'EMA20 above EMA50'
    : trend === 'DOWN' ? 'EMA20 below EMA50'
    : 'missing or invalid 1h EMA data'
  );

  return `${trend} (${reason})`;
}

function logDecisionStep(step, passed, detail) {
  console.log(`[DECISION] ${step}: ${passed ? 'PASS' : 'FAIL'}${detail ? ` | ${detail}` : ''}`);
}

function logSignalAndRiskSteps({ signal, indicators, signalDebug }) {
  const spreadLimit = getAdaptiveSpreadLimit(process.env.MAX_SPREAD, indicators?.atr);
  console.log(`[RISK] Adaptive spread limit: ${spreadLimit.toFixed(2)}`);
  const spreadValue = indicators?.spread;
  const spreadPass = Number.isFinite(spreadValue) && spreadValue <= spreadLimit;
  logDecisionStep('Spread check', spreadPass, `spread=${Number.isFinite(spreadValue) ? spreadValue.toFixed(2) : 'N/A'} limit=${spreadLimit.toFixed(2)}`);

  const minAtr = 0.50;
  const atrValue = indicators?.atr;
  const atrPass = Number.isFinite(atrValue) && atrValue >= minAtr;
  logDecisionStep('ATR check', atrPass, `atr=${Number.isFinite(atrValue) ? atrValue.toFixed(2) : 'N/A'} minimum=${minAtr.toFixed(2)}`);

  const now = new Date();
  const timeFloat = now.getUTCHours() + (now.getUTCMinutes() / 60);
  const reducedRisk = timeFloat < 7 || timeFloat > 18.08;
  logDecisionStep('Session check', true, reducedRisk ? 'Asia/off-peak session -> reduced risk multiplier' : 'London/NY session -> normal risk multiplier');

  const trendStatus = indicators?.trend1h;
  const trendReason = indicators?.trendReason || 'not available';
  const trendPass = signal ? (
    (signal.action === 'BUY' && trendStatus === 'UP') ||
    (signal.action === 'SELL' && trendStatus === 'DOWN')
  ) : (trendStatus === 'UP' || trendStatus === 'DOWN');
  logDecisionStep('1h trend filter', trendPass, `trend=${trendStatus ?? 'N/A'} reason=${trendReason}`);

  const setupPass = Boolean(signal);
  const setupReason = setupPass
    ? `${signal.action} ${signal.entryType}`
    : (signalDebug?.dbgRejectReason || 'strategy rejected setup');
  logDecisionStep('EMA crossover / pullback logic', setupPass, setupReason);
}

function logCycleStatus(cycleStatus) {
  console.log('[FINAL] Cycle Status');
  console.log(`[FINAL] DATA: ${cycleStatus.data}`);
  console.log(`[FINAL] 1H TREND: ${cycleStatus.trend}`);
  console.log(`[FINAL] SETUP: ${cycleStatus.setup}`);
  console.log(`[FINAL] TRADE: ${cycleStatus.trade}`);
}

function detectSchedulerSource(req) {
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase();
  const vercelId = req.headers['x-vercel-id'];
  const cronHeader = req.headers['x-vercel-cron'];

  if (cronHeader || vercelId) return 'vercel';
  if (userAgent.includes('github-actions') || userAgent.includes('github')) return 'github-actions';
  if (userAgent.includes('cron-job')) return 'cron-job';
  if (userAgent.includes('curl')) return 'manual-curl';
  return 'unknown';
}

function buildDashboardChartSnapshot(candles, indicators) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  const ema20arr = Array.isArray(indicators?.ema20arr) ? indicators.ema20arr : [];
  const ema50arr = Array.isArray(indicators?.ema50arr) ? indicators.ema50arr : [];

  return candles.slice(-60).map((candle, index, slice) => {
    const absoluteIndex = candles.length - slice.length + index;
    return {
      time: candle.time,
      price: candle.close,
      ema20: Number.isFinite(ema20arr[absoluteIndex]) ? ema20arr[absoluteIndex] : null,
      ema50: Number.isFinite(ema50arr[absoluteIndex]) ? ema50arr[absoluteIndex] : null,
    };
  });
}


// ── LOCAL RULE-BASED DAILY AUDIT ─────────────────────────────────────────────
// Replaces the disabled Claude-based daily audit.
// Reads the last 24h of trade_logs_list from Redis and computes all metrics.
// Sends a structured summary + anomaly alert (when anomalies exist) to Telegram.

// ── Anomaly detection — runs after the main audit ──────────────────────────
function detectAuditAnomalies(audit, dayLogs, botState) {
  const anomalies = [];
  const {
    totalCycles, trades, setups, noSignalPct,
    totalRejects, topRejects, dupSkips, staleSkips, brokerErrors,
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
    anomalies.push(`Low cycle count: ${totalCycles} (expected ~288). Bot may have been intermittent.`);
  }

  // ── 3. Zero setups in 24h ────────────────────────────────────────────────
  if (totalCycles > 0 && setups === 0) {
    anomalies.push('No setups detected in 24h. This may reflect strict filters or quiet market conditions.');
  }

  // ── 4. Setups present but no trades ──────────────────────────────────────
  if (setups > 0 && trades === 0) {
    const topRej = topRejects.length > 0 ? topRejects[0][0] : 'unknown';
    anomalies.push(`${setups} setup(s) detected but 0 trades executed — blocked mainly by: ${topRej}.`);
  }

  // ── 5. NO_SIGNAL rate above 95% ──────────────────────────────────────────
  if (totalCycles > 0 && parseFloat(noSignalPct) > 95) {
    anomalies.push(`NO_SIGNAL rate extremely high: ${noSignalPct}% — strategy is rarely generating signals.`);
  }

  // ── 6. Single rejection reason dominates (>70% of all logged rejections) ─
  if (topRejects.length > 0 && totalRejects > 0) {
    const [topName, topCount] = topRejects[0];
    const domPct = (topCount / totalRejects) * 100;
    if (domPct > 70) {
      anomalies.push(`One rejection dominates: "${topName}" accounts for ${domPct.toFixed(0)}% of all blocked setups.`);
    }
  }

  // ── 7. Duplicate candle skips elevated (>20% of cycles) ─────────────────
  if (totalCycles > 0 && dupSkips / totalCycles > 0.20) {
    anomalies.push(`Duplicate candle skips elevated: ${dupSkips} (${((dupSkips / totalCycles) * 100).toFixed(1)}% of cycles) — possible cron scheduling issue.`);
  }

  // ── 8. Stale candle skips elevated (>15% of cycles) ─────────────────────
  if (totalCycles > 0 && staleSkips / totalCycles > 0.15) {
    anomalies.push(`Stale candle skips elevated: ${staleSkips} (${((staleSkips / totalCycles) * 100).toFixed(1)}% of cycles) — infrastructure latency may be reducing valid entries.`);
  }

  // ── 9. Broker/account errors ─────────────────────────────────────────────
  if (brokerErrors > 0) {
    anomalies.push(`Broker errors detected: ${brokerErrors} log(s) contain a brokerResponse error object.`);
  }

  // ── 10. Missing EMA/ATR telemetry in many logs ───────────────────────────
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
    anomalies.push(`High missing indicator rate: ${missingIndicatorPct.toFixed(0)}% of cycles had no valid EMA/ATR data — market data may be failing frequently.`);
  }

  // ── 11. ATR much higher than ATR average (volatile spike) ────────────────
  if (avgATR !== null && avgATRav !== null && avgATR > avgATRav * 1.8) {
    anomalies.push(`ATR spike detected: avg ATR ${avgATR.toFixed(2)} is ${((avgATR / avgATRav) * 100 - 100).toFixed(0)}% above its own average (${avgATRav.toFixed(2)}) — market was unusually volatile.`);
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
  let totalRejects = 0;
  for (const l of dayLogs) {
    if (l.dbgRejectReason) {
      rejectMap[l.dbgRejectReason] = (rejectMap[l.dbgRejectReason] || 0) + 1;
      totalRejects++;
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
      ? `Active (${avgATR.toFixed(2)} >= avg ${avgATRav.toFixed(2)})`
      : `Dead (${avgATR.toFixed(2)} < avg ${avgATRav.toFixed(2)})`;
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
    conclusion = `Trades executed normally from confirmed setups. Main filter for the rest: "${topRej[0]}".`;
  } else if (trades > 0) {
    conclusion = 'Trades executed from all detected setups.';
  } else if (totalCycles > 0 && (staleSkips / totalCycles) > 0.10) {
    conclusion = `High stale skip rate (${((staleSkips / totalCycles) * 100).toFixed(1)}%) may have reduced valid entries.`;
  } else if (setups > 0 && topRej) {
    const topRejPct = totalRejects > 0
      ? ((topRej[1] / totalRejects) * 100).toFixed(0)
      : '?';
    conclusion = `Setups were blocked mainly by "${topRej[0]}" (${topRejPct}% of rejections).`;
  } else if (setups > 0) {
    conclusion = 'Setups detected but no trades placed — risk or session filters intervened.';
  } else {
    conclusion = 'No setups detected in 24h. This may reflect strict filters or quiet market conditions.';
  }

  // ── Build structured audit object (used by anomaly detector) ─────────────
  const audit = {
    totalCycles, trades, setups, setupPct, noSignalPct,
    sigBuy, sigSell, sigNone,
    totalRejects, topRejects, entryCounts,
    brokerErrors, dupSkips, staleSkips,
    avgATR, avgATRav, atrStatus, trendBias,
    pfStr, conclusion, date,
  };

  // ── Format and send daily audit message ──────────────────────────────────
  const rejLines = topRejects.length > 0
    ? topRejects.map(([r, n]) => `  • ${r}: ${n}`).join('\n')
    : '  None';

  const entryLines = Object.entries(entryCounts)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `  ${t}: ${n}`)
    .join('\n') || '  None';

  const msg =
    `📊 DAILY AUDIT (${date})\n` +
    `Cycles: ${totalCycles}\n` +
    `Trades: ${trades}\n` +
    `Setups: ${setups} (${setupPct}%)\n` +
    `Profit Factor: ${pfStr}\n\n` +
    `Signals:\n  BUY: ${sigBuy} | SELL: ${sigSell} | NONE: ${sigNone} (${noSignalPct}%)\n\n` +
    `Top Rejections:\n${rejLines}\n\n` +
    `Entry Types:\n${entryLines}\n\n` +
    `Infra:\n  Broker Errors: ${brokerErrors}\n  Duplicate Skips: ${dupSkips}\n  Stale Skips: ${staleSkips}\n\n` +
    `Market:\n  ATR: ${atrStatus}\n  Trend: ${trendBias}\n\n` +
    `Conclusion:\n${conclusion}`;

  console.log('[AUDIT] Sending daily rule-based audit to Telegram');
  await sendAlert(msg);

  // ── Anomaly detection — fires one extra alert only when anomalies exist ───
  const anomalies = detectAuditAnomalies(audit, dayLogs, botState);
  if (anomalies.length > 0) {
    const anomalyMsg =
      `🚨 AUDIT ANOMALIES (${date})\n` +
      anomalies.map(a => `- ${a}`).join('\n');
    console.log(`[AUDIT] ${anomalies.length} anomalie(s) detected — sending alert`);
    await sendAlert(anomalyMsg);
  } else {
    console.log('[AUDIT] No anomalies detected.');
  }
}

// ── REAL-TIME ANOMALY DETECTION ──────────────────────────────────────────────
async function detectRealtimeIssues(recentLogs, botState) {
  try {
    // Session filter: only run alerts during active market hours (07:00 - 18:05 UTC)
    const currentDate = new Date();
    const utcDay = currentDate.getUTCDay();
    const timeFloat = currentDate.getUTCHours() + currentDate.getUTCMinutes() / 60;
    
    const isWeekend = utcDay === 0 || utcDay === 6;
    const isFridayClose = utcDay === 5 && timeFloat >= 18.083;
    
    if (isWeekend || timeFloat < 7 || timeFloat >= 18.083 || isFridayClose) {
      return false;
    }

    if (!recentLogs || !Array.isArray(recentLogs) || recentLogs.length === 0) return false;

    const totalCycles = recentLogs.length;
    if (totalCycles < 20) return false;

    const issues = [];
    
    // Track counts
    const trades = recentLogs.filter(l => l.tradeExecuted === true).length;
    const setups = recentLogs.filter(l => l.dbgSetupReady === true).length;
    const sigNone = recentLogs.filter(l => !l.signalDetected || l.signalDetected === 'NONE').length;
    
    const dupSkips = recentLogs.filter(l =>
      typeof l.reason === 'string' && (
        l.reason.startsWith('SKIP: Duplicate candle') ||
        l.reason.startsWith('SKIP: Signal from already processed candle') ||
        l.reason.startsWith('SKIP: No new candle')
      )
    ).length;

    const staleSkips = recentLogs.filter(l =>
      typeof l.reason === 'string' && l.reason.toLowerCase().includes('stale')
    ).length;

    const brokerErrors = recentLogs.filter(l =>
      l.brokerResponse && typeof l.brokerResponse === 'object'
    ).length;

    const indicatorLogs = recentLogs.filter(l => 
      typeof l.ema20 === 'number' &&
      typeof l.ema50 === 'number' &&
      typeof l.atr === 'number' &&
      typeof l.atrAverage === 'number'
    );

    // Use conservative thresholds to avoid noise at startup or during sparse cycles
    if (setups === 0) {
      issues.push({ id: 'no_setups', msg: '⚠️ No setups detected in last 30 cycles.' });
    }
    
    if (setups > 0 && trades === 0) {
      issues.push({ id: 'no_trades', msg: '⚠️ Setups detected but no trades executed recently.' });
    }

    if ((sigNone / totalCycles) > 0.95) {
      issues.push({ id: 'high_no_signal', msg: '⚠️ NO_SIGNAL rate extremely high in recent cycles.' });
    }

    if ((dupSkips / totalCycles) > 0.25) {
      issues.push({ id: 'high_dups', msg: '⚠️ High duplicate candle skips — check lastProcessedCandle logic.' });
    }

    if ((staleSkips / totalCycles) > 0.20) {
      issues.push({ id: 'high_stale', msg: '⚠️ High stale rate — check scheduler timing.' });
    }

    const missingIndicatorPct = (totalCycles - indicatorLogs.length) / totalCycles;
    if (missingIndicatorPct > 0.50) {
      issues.push({ id: 'missing_indicators', msg: '⚠️ Missing indicator data in many recent cycles.' });
    }

    if (brokerErrors > 0) {
      issues.push({ id: 'broker_errors', msg: '⚠️ Broker errors detected in recent cycles.' });
    }

    if (issues.length === 0) return false;

    // Enforce cooldowns
    const now = Date.now();
    const COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes
    if (!botState.lastRealtimeAlertAtByType) {
      botState.lastRealtimeAlertAtByType = {};
    }

    const activeIssues = [];
    let stateModified = false;

    for (const issue of issues) {
      const lastAlertAt = botState.lastRealtimeAlertAtByType[issue.id] || 0;
      if (now - lastAlertAt > COOLDOWN_MS) {
        activeIssues.push(issue.msg);
        botState.lastRealtimeAlertAtByType[issue.id] = now;
        stateModified = true;
      }
    }

    if (activeIssues.length > 0) {
      const msg = `🚨 REALTIME ALERT\n\n` + activeIssues.join('\n');
      console.log(`[REALTIME] Triggering alert with ${activeIssues.length} issues.`);
      await sendAlert(msg).catch(() => {});
    }

    return stateModified;
  } catch (err) {
    console.error('[REALTIME] detectRealtimeIssues execution error:', err.message, err.stack);
    return false;
  }
}

export default async function handler(req, res) {
  // ── Authorization ─────────────────────────────────────────────────────────
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  const providedAuth = req.headers['authorization'] || req.headers['Authorization'];
  const schedulerSource = detectSchedulerSource(req);
  console.log(`[CRON] Scheduler source: ${schedulerSource}`);
  if (process.env.CRON_SECRET && providedAuth !== expectedAuth) {
    console.warn('Unauthorized cron trigger attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let botState;
  let lockHandle = null;
  let invocationStateVersion = 0;
  const cycleStatus = {
    data: 'FAIL',
    trend: 'N/A (not evaluated)',
    setup: 'NO',
    trade: 'SKIPPED (not evaluated)',
  };

  // ── Security: Validate CRON_SECRET strength ───────────────────────────────
  if (process.env.CRON_SECRET) {
    if (process.env.CRON_SECRET.length < 10) {
      const msg = '⚠️ CRON_SECRET is too weak (less than 10 chars). Use 32+ random characters.';
      console.error(msg);
      return res.status(500).json({ error: msg });
    }
    // Check if it looks like a predictably short string (e.g., 'goldbot2026', 'password123')
    if (/^[a-z0-9]{1,8}$/i.test(process.env.CRON_SECRET)) {
      const msg = '⚠️ CRON_SECRET looks too simple (too short/alphanumeric only). Use complex random string.';
      console.error(msg);
      return res.status(500).json({ error: msg });
    }
  }

  // ── CRITICAL: Enforce live trading safety flag ──────────────────────────
  const isLiveMode = process.env.CAPITAL_ENV === 'live';
  const liveTradeConfirmed = process.env.LIVE_TRADING_MODE === 'CONFIRMED_REAL_MONEY';
  
  if (isLiveMode && !liveTradeConfirmed) {
    const msg = '⚠️ LIVE MODE DISABLED: Set LIVE_TRADING_MODE=CONFIRMED_REAL_MONEY to enable live trading. Set CAPITAL_ENV=demo to use paper trading.';
    console.error(msg);
    return res.status(403).json({ error: msg });
  }

  if (isLiveMode && liveTradeConfirmed) {
    console.warn('🔴 === LIVE TRADING MODE ACTIVE === REAL MONEY AT RISK === 🔴');
  }

  // ── Kill switch (fast path) ──────────────────────────────────────────────
  if (process.env.BOT_ENABLED !== 'true') {
    return res.json({ skipped: 'Bot disabled via BOT_ENABLED env variable' });
  }

  // -- Step 0: Redis health check --
  // Must run before loadState() so a missing/expired KV_REST_API_URL or
  // KV_REST_API_TOKEN is caught here and reported clearly.
  const redisReachable = await pingRedis();
  if (!redisReachable) {
    const msg = 'Redis unreachable — verify KV_REST_API_URL and KV_REST_API_TOKEN are set in Vercel environment variables';
    console.error(`[CRON] ⚠️ ${msg}`);
    await sendAlert(`🚨 Bot blocked: ${msg}`).catch(() => {});
    return res.status(503).json({ error: msg });
  }

  try {
    // -- Step 1: Load state + daily reset --
    botState = await loadState();
    botState.currentCycleTime = Date.now();
    botState.currentCycleReason = '';
    botState.chartUpdatedThisCycle = false;
    botState.schedulerSource = schedulerSource;
    botState.dataFreshnessStatus = Number(botState.lastValidDataTime) > 0 ? 'STALE' : 'NO_VALID_DATA';

    // Performance Tracking: Local rule-based audit every 24h (before daily reset)
    // NOTE: Claude-based daily audit is DISABLED. generateLocalAudit() replaces it.
    const uaeDate = new Date(new Date().getTime() + (4 * 60 * 60 * 1000));
    const today = uaeDate.toISOString().slice(0, 10);
    if (botState.lastTradingDay && botState.lastTradingDay !== today) {
      console.log(`[STATE] 24h audit trigger: day changed from ${botState.lastTradingDay} to ${today}`);
      try {
        const auditLogs = await getLogs();
        await generateLocalAudit(auditLogs, botState);
      } catch (auditErr) {
        console.error('[CRON] Local audit generation failed:', auditErr.message);
      }
    }

    botState = dailyReset(botState);
    invocationStateVersion = Number.isFinite(Number(botState.stateVersion))
      ? Number(botState.stateVersion)
      : 0;

    // ── State integrity check ─────────────────────────────────────────────────
    if (botState.stateIntegrityOk === false) {
      const msg = 'State integrity compromised — manual review required';
      console.error(`[CRON] ⚠️ ${msg}`);
      
      // Still log a heartbeat so the user knows why it's silent in the dashboard
      await saveLog({ 
        signal: null, 
        indicators: null, 
        botState, 
        tradeExecuted: false, 
        reason: `HALTED: ${botState.criticalFailureReason || msg}` 
      }).catch(() => {});

      await sendAlert(`🚨 Bot halted: State integrity compromised. Check Upstash and reset stateIntegrityOk=true after review.`).catch(() => {});
      return res.json({ skipped: msg });
    }

    // ── State kill switch (fast path) ────────────────────────────────────────
    if (botState.botEnabled === false) {
      const now = Date.now();
      if (!botState.lastDisabledAlert || (now - botState.lastDisabledAlert) > ALERT_THROTTLE_MS) {
        botState.lastDisabledAlert = now;
        await saveState(botState);
        await sendAlert('⚠️ Bot is disabled (botEnabled=false) — manual reset required in Redis').catch(() => {});
      }
      return res.json({ skipped: 'Bot disabled via state (drawdown or performance threshold)' });
    }

    if (botState.criticalFailure === true) {
      const now = Date.now();
      if (!botState.lastCriticalAlert || (now - botState.lastCriticalAlert) > ALERT_THROTTLE_MS) {
        botState.lastCriticalAlert = now;
        await saveState(botState);
        await sendAlert(`🚨 Bot is in critical failure state: ${botState.criticalFailureReason || 'unknown'} — manual reset required`).catch(() => {});
      }
      return res.json({ skipped: `Critical failure active: ${botState.criticalFailureReason || 'manual review required'}` });
    }

    // ── Step 2: Authenticate with Capital.com ─────────────────────────────────
    let session;
    try {
      session = await getCapitalSession();
    } catch (err) {
      const reason = `SKIP: Capital.com auth failed - ${err.message}`;
      await saveLog({ signal: null, indicators: null, botState, tradeExecuted: false, reason });
      await saveState(botState);
      await sendAlert(`🚨 Capital.com auth failed — bot halted until credentials fixed: ${err.message}`).catch(() => {});
      return res.json({ skipped: reason });
    }

    // ── Step 3: Sync real balance AND equity from Capital.com ─────────────────
    botState = await syncBalance(session, botState);
    if (!Number.isFinite(botState.balance) || !Number.isFinite(botState.equity) || !Number.isFinite(botState.availableMargin)) {
      const reason = 'SKIP: BROKER_ACCOUNT_STATE_UNAVAILABLE';
      console.warn(`[CRON] ${reason}`);
      await saveLog({ signal: null, indicators: null, botState, tradeExecuted: false, reason });
      await saveState(botState);
      return res.json({ skipped: reason });
    }
    if (botState.balance > botState.peakBalance) {
      botState.peakBalance = botState.balance;
    }

    // ── Step 4: Reconcile positions (replaces old syncOpenTrades) ─────────────
    const reconcileResult = await reconcilePositions(session, botState);
    botState = reconcileResult.botState;
    if (reconcileResult.haltReason) {
      // Reconcile errors (e.g. network timeout) should be SKIPS, not permanent HALTS
      // to avoid manual resets on every minor broker lag.
      const reason = `SKIP: RECONCILIATION_FAILED:${reconcileResult.haltReason}`;
      console.warn(`[CRON] ${reason}`);
      await saveLog({ signal: null, indicators: null, botState, tradeExecuted: false, reason });
      await saveState(botState);
      await sendAlert(`🚨 Reconciliation failed — bot halted: ${reconcileResult.haltReason}`).catch(() => {});
      return res.json({ skipped: reason });
    }

    // ── STEP 4b: Trade Management (v1.5 — Partial Close + Delayed BE + Trailing) ──
    // FIX 2 & 3: The old logic moved BE at +1R to entry, choking winners at 0.1–0.5R.
    // New logic:
    //   +1.0R → Partial close 50% (lock in profit, let rest run)
    //   +1.5R → Move SL to entry + 0.3R (never a scratch trade)
    //   +2.0R → Trailing stop with 1.0 ATR distance (tighter trail in deep profit)
    if (Array.isArray(botState.openTrades) && botState.openTrades.length > 0) {
      const livePrice = await fetchCurrentGoldPrice(session);
      if (livePrice) {
        for (let i = 0; i < botState.openTrades.length; i++) {
          const t = botState.openTrades[i];
          if (!t.entry || !t.stopLoss) continue;

          // Compute R (Risk) = distance between entry and initial stop loss
          const initialSL = t.initialStopLoss || t.stopLoss;
          const riskAmount = Math.abs(t.entry - initialSL);
          if (riskAmount <= 0) continue;

          const liveBid   = livePrice.bid;
          const liveOffer = livePrice.offer;
          const currentProfit = t.action === 'BUY' ? liveBid - t.entry : t.entry - liveOffer;
          const currentR = currentProfit / riskAmount;

          // ── Phase 0: Partial Close at +1.0R ──────────────────────────────────
          // Close 50% of the position to lock in profit. The remaining 50% runs to TP.
          // This only fires once (tracked by t.partialClosed flag).
          if (currentR >= 1.0 && !t.partialClosed && t.size > 0.02) {
            const closeSize = parseFloat((t.size * 0.5).toFixed(2));
            // Minimum closeable size on Capital.com is 0.01 oz
            if (closeSize >= 0.01) {
              try {
                const { baseUrl, cst, securityToken } = session;
                const closeDirection = t.action === 'BUY' ? 'SELL' : 'BUY';
                const closeRes = await fetchWithTimeout(`${baseUrl}/api/v1/positions/${t.dealId}`, {
                  method: 'DELETE',
                  headers: {
                    'X-CAP-API-KEY':    process.env.CAPITAL_API_KEY,
                    'CST':              cst,
                    'X-SECURITY-TOKEN': securityToken,
                    'Content-Type':     'application/json',
                    '_method':          'DELETE',
                  },
                  body: JSON.stringify({
                    direction: closeDirection,
                    size:      closeSize,
                  }),
                });

                if (closeRes.ok) {
                  t.partialClosed = true;
                  t.partialCloseSize = closeSize;
                  t.partialCloseR = parseFloat(currentR.toFixed(2));
                  t.size = parseFloat((t.size - closeSize).toFixed(2));
                  
                  console.log(`[TRADE_MGMT] ✅ Partial close: ${closeSize}oz of ${t.dealId} at +${currentR.toFixed(2)}R. Remaining: ${t.size}oz`);
                  await sendAlert(
                    `💰 PARTIAL CLOSE (+${currentR.toFixed(1)}R): ${t.action} Gold\n` +
                    `Closed: ${closeSize}oz | Remaining: ${t.size}oz\n` +
                    `dealId: ${t.dealId}`
                  );
                  await saveLog({
                    signal: { id: t.tradeId, action: t.action, entryType: 'partial_close' },
                    indicators: null,
                    botState: { ...botState },
                    tradeExecuted: false,
                    reason: `PARTIAL_CLOSE: ${closeSize}oz at +${currentR.toFixed(2)}R`,
                    result: { dbgPartialSize: closeSize, dbgRemainingSize: t.size, dbgCurrentR: currentR }
                  });
                  await saveStateCritical(botState, `partial_close:${t.dealId}`);
                } else {
                  const errBody = await closeRes.text().catch(() => '(unreadable)');
                  console.warn(`[TRADE_MGMT] Partial close failed for ${t.dealId} (HTTP ${closeRes.status}): ${errBody}`);
                }
              } catch (partialErr) {
                console.warn(`[TRADE_MGMT] Partial close error for ${t.dealId}: ${partialErr.message}`);
              }
            }
          }

          let newStopLevel = null;
          let label = '';

          // ── Phase 1: Trailing Stop — activate after +2.0R ────────────────────
          // v1.5: was +1.5R. Delayed to let winners run further before trailing.
          // Trail distance tightened to 1.0 ATR (was 1.2) for better profit lock.
          if (currentR >= 2.0) {
            const atr = t.atr || 2.0;
            const trailDist = atr * 1.0;  // v1.5: was 1.2 — tighter trail in deep profit
            const trailSL = t.action === 'BUY' ? liveBid - trailDist : liveOffer + trailDist;
            
            if (t.action === 'BUY') {
              if (trailSL > (t.stopLoss || 0)) {
                newStopLevel = trailSL;
                label = 'Trailing stop active (+2R)';
              }
            } else {
              if (trailSL < (t.stopLoss || 999999)) {
                newStopLevel = trailSL;
                label = 'Trailing stop active (+2R)';
              }
            }
          } 
          // ── Phase 2: Break-Even — activate after +1.5R ───────────────────────
          // v1.5: was +1.0R at entry. Now +1.5R at entry + 0.3R.
          // This ensures: (a) trade has real profit before BE, (b) BE itself locks in 0.3R.
          else if (currentR >= 1.5 && !t.breakEvenMoved) {
            // Move SL to entry + 0.3R (not just entry) to guarantee small profit if stopped
            const beProfitBuffer = riskAmount * 0.3;
            newStopLevel = t.action === 'BUY' 
              ? t.entry + beProfitBuffer 
              : t.entry - beProfitBuffer;
            label = 'BE activated (+1.5R → entry+0.3R)';
          }

          if (newStopLevel !== null) {
            // Ensure we never move the stop WORSE than the current stop
            if (t.action === 'BUY') {
              newStopLevel = Math.max(newStopLevel, t.stopLoss || 0);
            } else {
              newStopLevel = Math.min(newStopLevel, t.stopLoss || 999999);
            }

            const stopDist = Math.abs(newStopLevel - (t.stopLoss || 0));
            if (stopDist > 0.20) {
              console.log(`[TRADE_MGMT] ${label}: Trade ${t.dealId} profit ${currentR.toFixed(2)}R. New SL: $${newStopLevel.toFixed(2)}.`);

              const mod = await modifyTradeStopLoss(session, t.dealId, {
                stopLevel:   parseFloat(newStopLevel.toFixed(2)),
                profitLevel: t.takeProfit ? parseFloat(t.takeProfit.toFixed(2)) : null
              });

              if (mod.success) {
                t.breakEvenMoved = true;
                if (!t.initialStopLoss) t.initialStopLoss = initialSL;
                t.stopLoss = newStopLevel;
                
                await saveLog({
                  signal: { id: t.tradeId, action: t.action, entryType: 'trade_management' },
                  indicators: null,
                  botState: { ...botState },
                  tradeExecuted: false,
                  reason: label,
                  result: { dbgNewStop: newStopLevel, dbgCurrentR: currentR }
                });

                await sendAlert(`🛡️ ${label}: ${t.action} Gold dealId ${t.dealId}\nNew SL: $${newStopLevel.toFixed(2)} | Profit: +${currentR.toFixed(2)}R`);
                await saveStateCritical(botState, `stop_move:${t.dealId}`);
              }
            }
          }
        }
      }
    }

    // ── STATE INTEGRITY CHECK: Validate after reconciliation ──────────────────
    if (!validateStateIntegrity(botState, 'post-reconciliation')) {
      console.error('[CRON] ⚠️ State integrity compromised after reconciliation — halting');
      await saveState(botState); // Save the corrupted state flag
      await sendAlert('🚨 Bot halted: State integrity check failed after position reconciliation. Manual review required.').catch(() => {});
      return res.json({ error: 'State integrity failed after reconciliation' });
    }

    // ── Sync actual trade stats from broker ─────────────────────────────────
    const brokerStats = await fetchBrokerTradeStats(session);
    if (!brokerStats) {
      botState.riskDataFresh = false;
      botState.lastRiskSyncAt = 0;
      await saveState(botState);
      await saveLog({ signal: null, indicators: null, botState, tradeExecuted: false, reason: 'SKIP: BROKER_STATS_UNAVAILABLE' }).catch(() => {});
      await sendAlert('🚨 Broker stats unavailable — bot halted this cycle. Will retry next cycle.').catch(() => {});
      return res.json({ skipped: 'BROKER_STATS_UNAVAILABLE' });
    }

    console.log(`[CRON] Broker Sync: Today ${brokerStats.todayTrades}, Win rate ${brokerStats.todayWinRate}%`);
    // CRITICAL: Use Math.max to prevent counter regression due to broker API latency/missing records.
    // The count will be reset to 0 by dailyReset() at the start of a new UAE day.
    botState.dailyTrades        = Math.max(parseInt(botState.dailyTrades) || 0, brokerStats.todayTrades);
    botState.todayTrades        = botState.dailyTrades;
    botState.todayBuys          = brokerStats.todayBuys;
    botState.todaySells         = brokerStats.todaySells;
    botState.todayWinRate       = brokerStats.todayWinRate;
    botState.todayBest          = brokerStats.todayBest;
    botState.todayWorst         = brokerStats.todayWorst;

    botState.brokerTotalTrades  = brokerStats.totalTrades;
    botState.brokerTotalPnl     = brokerStats.totalPnl;
    botState.brokerWins         = brokerStats.wins;
    botState.brokerLosses       = brokerStats.losses;
    botState.brokerWinRate      = brokerStats.winRate;
    botState.brokerBestTrade    = brokerStats.bestTrade;
    botState.brokerWorstTrade   = brokerStats.worstTrade;
    botState.brokerGrossProfit  = brokerStats.grossProfit;
    botState.brokerGrossLoss    = brokerStats.grossLoss;
    botState.lastBrokerSync     = brokerStats.syncedAt;

    // ── Broker-Based Risk Metrics ────────────────────────────────────────────
    const todayPnlAED = brokerStats.todayNetPnl;
    const realizedLossToday = todayPnlAED < 0 ? Math.abs(todayPnlAED) : 0;
    // CRITICAL: Never let dailyLoss drop within the same day to prevent bypassing loss limits
    // during broker API sync gaps.
    botState.dailyLoss = Math.max(parseFloat(botState.dailyLoss) || 0, realizedLossToday);

    const currentTotalPnl = brokerStats.totalPnl;
    const peakPnl = parseFloat(botState.peakBrokerPnl) || 0;
    if (currentTotalPnl > peakPnl) botState.peakBrokerPnl = currentTotalPnl;
    
    const equityDrawdown = calculateDrawdown(botState.peakBalance, botState.equity || botState.balance);
    botState.totalDrawdown = parseFloat(equityDrawdown.toFixed(2));
    botState.riskDataFresh = true;
    botState.lastRiskSyncAt = Date.now();
    
    console.log(`[CRON] Risk Sync: DailyLoss AED ${botState.dailyLoss.toFixed(2)}, TotalDrawdown ${botState.totalDrawdown}%`);

    // DIAGNOSTIC CORE START
    const cronStart = Date.now();
    console.log(`[DIAG] Cron Trigger: ${new Date().toISOString()}`);
    // DIAGNOSTIC CORE END

    // ── Step 5 & 6: Fetch market data and Indicators ─────────────────────────
    const marketData = await getMarketData(session, botState);
    cycleStatus.data = marketData.dataStatus ?? (marketData.skip ? 'FAIL' : 'OK');
    botState.currentCycleTime = Date.now();
    botState.currentCycleReason = marketData.reason || '';
    if (Array.isArray(marketData.candles5m) && marketData.candles5m.length > 0 && !marketData.skip) {
      botState.lastValidDataTime = marketData.latestCandleTime;
      botState.dataFreshnessStatus = 'FRESH';
    }

    let indicators = null;
    if (marketData.candles5m && marketData.candles1h) {
      botState.candles5m = marketData.candles5m;
      // Only advance the processed candle time if we are not skipping due to duplicate
      if (!marketData.skip) {
        const ownerToken = createLockOwnerToken();
        lockHandle = await acquireCandleLock(marketData.latestCandleTime, ownerToken);
        if (!lockHandle) {
           console.warn(`[CRON] ⚠️ Concurrency lock FAILED for candle ${marketData.latestCandleTime}`);
           console.warn(`[CRON]    → Another invocation is already processing this candle`);
           console.warn(`[CRON]    → Lock TTL is ${CANDLE_LOCK_TTL_SECONDS}s; if this repeats, check for overlapping cron sources`);
           console.warn(`[CRON]    → Repo contains a scheduled GitHub workflow hitting /api/cron and deploy workflow can trigger it manually`);
           marketData.skip = true;
           marketData.reason = `SKIP: Concurrency lock blocked this invocation (candle ${marketData.latestCandleTime} already being processed by another instance)`;
        } else {
           console.log(`[CRON] ✓ Candle lock acquired for ${marketData.latestCandleTime} — this invocation will process signals`);
        }
      }

      // Calculate indicators even on skips for dashboard live values
      indicators = calculateIndicators(marketData.candles5m, marketData.candles1h);
      indicators.spread = marketData.spread ?? null;
      cycleStatus.trend = formatTrendStatus(indicators);
      if (!indicators.skip) {
        botState.lastValidDataTime = marketData.latestCandleTime;
        botState.dataFreshnessStatus = 'FRESH';
        botState.dashboardChart = buildDashboardChartSnapshot(marketData.candles5m, indicators);
        botState.chartUpdatedThisCycle = true;
      }
    }

    // If market data skipped OR indicators skipped:
    if (marketData.skip || (indicators && indicators.skip)) {
      const reason = marketData.skip ? marketData.reason : indicators.reason;
      botState.currentCycleReason = reason;
      botState.dataFreshnessStatus = Number(botState.lastValidDataTime) > 0 ? 'STALE' : 'NO_VALID_DATA';
      cycleStatus.setup = 'NO';
      cycleStatus.trade = `SKIPPED (${reason})`;
      if (!marketData.skip && indicators) {
        cycleStatus.trend = formatTrendStatus(indicators);
      }
      
      let signalDebug = undefined;
      // Evaluate strategy purely for debug telemetry even if this cycle is skipping
      if (indicators && !indicators.skip && marketData.candles1m) {
        const generated = generateSignal(indicators, marketData.candles1m);
        signalDebug = generated.debug;
        logSignalAndRiskSteps({ signal: generated.signal, indicators, signalDebug });
      }

      botState.lastHeartbeat = Date.now();
      await saveLog({ signal: null, indicators, botState, tradeExecuted: false, reason, signalDebug });
      await saveStateWithOptions(botState, { expectedVersion: invocationStateVersion });
      return res.json({ skipped: reason });
    }

    // ── Step 7: Generate signal ───────────────────────────────────────────────
    indicators.lastOrderTimestamp = botState.lastOrderTimestamp;
    indicators.recentOutcomes = botState.recentOutcomes;
    let { signal, debug: signalDebug } = generateSignal(indicators, marketData.candles1m);
    cycleStatus.setup = signal ? 'YES' : 'NO';
    logSignalAndRiskSteps({ signal, indicators, signalDebug });

    // ── STEP 7.5: FORCE_TRADE MODE ───────────────────────────────────────────
    if (process.env.FORCE_TRADE === 'true') {
      console.warn('⚠️ FORCE_TRADE active: Bypassing strategy and risk filters');
      const livePrice = await fetchCurrentGoldPrice(session);
      if (livePrice) {
          const action = 'BUY'; // Test with small BUY
          const entry = livePrice.offer;
          const atr = indicators.atr || 5.0;
          signal = {
              id: `forced_${Date.now()}`,
              pair: 'GOLD',
              action,
              entryType: 'forced_test',
              entryPrice: entry,
              stopLoss: entry - (atr * 1.5),
              takeProfit: entry + (atr * 2.5),
              atr,
              score: 5,
              strategyVersion: 'forced_v1.0',
              timestamp: Date.now()
          };
          signalDebug = { dbgRejectReason: null, dbgAction: action, dbgEntryType: 'forced_test' };
          cycleStatus.setup = 'YES';
          console.warn(`[FORCE] Created test signal: ${action} @ ${entry}`);
      }
    }

    // ── Step 8: Risk checks ───────────────────────────────────────────────────
    const riskResult = (process.env.FORCE_TRADE === 'true' && signal?.entryType === 'forced_test') 
      ? 'APPROVED' 
      : checkRisk(signal, botState, indicators);

    if (riskResult !== 'APPROVED') {
      botState.currentCycleReason = riskResult;
      cycleStatus.trade = `SKIPPED (${riskResult})`;
      if (riskResult.startsWith('STOP:') || riskResult.startsWith('DISABLE:')) {
        await sendAlert(`🚨 ${riskResult}`).catch(() => {});
      }
      if (lockHandle && shouldFinalizeRiskOutcome(botState, signal)) {
        botState.lastProcessedCandle = marketData.latestCandleTime;
      }
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: riskResult, signalDebug });
      await saveState(botState);
      return res.json({ skipped: riskResult });
    }

    if (!lockHandle) {
      botState.currentCycleReason = 'SKIP: Missing execution lock handle';
      cycleStatus.trade = 'SKIPPED (Missing execution lock handle)';
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: 'SKIP: Missing execution lock handle', signalDebug });
      await saveStateWithOptions(botState, { expectedVersion: invocationStateVersion });
      return res.json({ skipped: 'SKIP: Missing execution lock handle' });
    }

    const lockOwnedBeforeExecution = await verifyCandleLockOwnership(lockHandle);
    if (!lockOwnedBeforeExecution) {
      botState.currentCycleReason = 'SKIP: Lock ownership lost before execution';
      cycleStatus.trade = 'SKIPPED (Lock ownership lost before execution)';
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: 'SKIP: Lock ownership lost before execution', signalDebug });
      await saveStateWithOptions(botState, { expectedVersion: invocationStateVersion });
      return res.json({ skipped: 'SKIP: Lock ownership lost before execution' });
    }

    const lockRenewedBeforeExecution = await renewCandleLock(lockHandle, CANDLE_LOCK_TTL_SECONDS);
    if (!lockRenewedBeforeExecution) {
      botState.currentCycleReason = 'SKIP: Lock renewal failed before execution';
      cycleStatus.trade = 'SKIPPED (Lock renewal failed before execution)';
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: 'SKIP: Lock renewal failed before execution', signalDebug });
      await saveStateWithOptions(botState, { expectedVersion: invocationStateVersion });
      return res.json({ skipped: 'SKIP: Lock renewal failed before execution' });
    }

    const certainty = await verifyExecutionCertainty(session, botState);
    if (!certainty.ok) {
      if (certainty.reason.includes('LOCAL_NOT_ON_BROKER') || certainty.reason.includes('BROKER_NOT_LOCAL')) {
        const skipReason = `SKIP: Race condition detected during execution gate (${certainty.reason})`;
        botState.currentCycleReason = skipReason;
        cycleStatus.trade = `SKIPPED (${skipReason})`;
        console.warn(`[CRON] ${skipReason}`);
        botState.lastHeartbeat = Date.now();
        await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: skipReason, signalDebug });
        await saveStateWithOptions(botState, { expectedVersion: invocationStateVersion });
        return res.json({ skipped: skipReason });
      }

      botState.botEnabled = false;
      botState.stateIntegrityOk = false;
      botState.criticalFailure = true;
      botState.criticalFailureReason = certainty.reason;
      botState.currentCycleReason = certainty.reason;
      cycleStatus.trade = `SKIPPED (${certainty.reason})`;
      await saveStateCritical(botState, `execution_barrier:${certainty.reason}`);
      return res.json({ skipped: certainty.reason });
    }

    const lockOwnedAtExecution = await verifyCandleLockOwnership(lockHandle);
    if (!lockOwnedAtExecution) {
      botState.currentCycleReason = 'SKIP: Lock ownership lost at execution gate';
      cycleStatus.trade = 'SKIPPED (Lock ownership lost at execution gate)';
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: 'SKIP: Lock ownership lost at execution gate', signalDebug });
      await saveStateWithOptions(botState, { expectedVersion: invocationStateVersion });
      return res.json({ skipped: 'SKIP: Lock ownership lost at execution gate' });
    }

    const lockRenewedAtExecution = await renewCandleLock(lockHandle, CANDLE_LOCK_TTL_SECONDS);
    if (!lockRenewedAtExecution) {
      botState.currentCycleReason = 'SKIP: Lock renewal failed at execution gate';
      cycleStatus.trade = 'SKIPPED (Lock renewal failed at execution gate)';
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: 'SKIP: Lock renewal failed at execution gate', signalDebug });
      await saveStateWithOptions(botState, { expectedVersion: invocationStateVersion });
      return res.json({ skipped: 'SKIP: Lock renewal failed at execution gate' });
    }

    // ── Step 9: Place trade ───────────────────────────────────────────────────
    const tradeResult = await placeTrade(session, signal, botState);

    if (!tradeResult.success) {
      botState.currentCycleReason = tradeResult.reason;
      cycleStatus.trade = `SKIPPED (${tradeResult.reason})`;
      if (String(tradeResult.reason || '').startsWith('CRITICAL_FAILURE')) {
        botState.botEnabled = false;
        botState.stateIntegrityOk = false;
        botState.criticalFailure = true;
        botState.criticalFailureReason = tradeResult.reason;
      }
      if (lockHandle && shouldFinalizeTradeFailure(tradeResult)) {
        botState.lastProcessedCandle = marketData.latestCandleTime;
      }
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: tradeResult.reason, brokerResponse: tradeResult.brokerResponse ?? null, signalDebug });
      await saveState(botState);
      return res.json({ skipped: tradeResult.reason });
    }

    // ── Step 10: Log success ──────────────────────────────────────────────────
    if (lockHandle) {
      botState.lastProcessedCandle = marketData.latestCandleTime;
    }
    botState.currentCycleReason = 'TRADE_EXECUTED';
    cycleStatus.trade = `EXECUTED (${signal.action} ${signal.entryType})`;
    botState.lastHeartbeat = Date.now();
    await saveLog({ signal, indicators, botState, tradeExecuted: true, result: tradeResult, reason: null, signalDebug });
    await saveState(botState);

    // ── Step 11: Performance check (fires every 50 executed trades) ───────────
    const logs = await getLogs();
    await checkPerformance(logs, botState);

    // ── Step 12: Trade alert ──────────────────────────────────────────────────
    await sendAlert(
      `✅ ${signal.action} GOLD [${signal.entryType}]\n` +
      `Entry: $${tradeResult.entry.toFixed(2)}\n` +
      `SL: $${tradeResult.stopLoss.toFixed(2)} | TP: $${tradeResult.takeProfit.toFixed(2)}\n` +
      `Size: ${tradeResult.size}oz | Score: ${signal.score} | ATR: ${signal.atr.toFixed(2)}\n` +
      `Balance: AED ${parseFloat(botState.balance).toFixed(2)} | Equity: AED ${parseFloat(botState.equity || botState.balance).toFixed(2)} | Daily trades: ${botState.dailyTrades}/10`
    );

    return res.json({
      success:      true,
      action:       signal.action,
      entryType:    signal.entryType,
      entry:        tradeResult.entry,
      stopLoss:     tradeResult.stopLoss,
      takeProfit:   tradeResult.takeProfit,
      size:         tradeResult.size,
      score:        signal.score,
      dealId:        tradeResult.dealId,
      dealReference: tradeResult.dealReference,
      summary: {
          cyclesExecuted: 1, // Current cycle
          signalsDetected: signal ? 1 : 0,
          tradesAttempted: 1,
          tradesExecuted: 1,
          mainBlockingReason: null
      }
    });

  } catch (err) {
    // Catastrophic error — log, alert, save state if possible
    if (botState) {
      botState.currentCycleTime = Date.now();
      botState.currentCycleReason = err.message;
      botState.dataFreshnessStatus = Number(botState.lastValidDataTime) > 0 ? 'STALE' : 'NO_VALID_DATA';
      botState.schedulerSource = schedulerSource;
    }
    cycleStatus.trade = `SKIPPED (ERROR: ${err.message})`;
    console.error('[CRON] Pipeline error:', err.message, err.stack);
    if (botState) {
      if (err?.code === 'FETCH_TIMEOUT') {
        botState.stateIntegrityOk = false;
        console.warn('[CRON] Fetch timeout — skipping this cycle, bot remains enabled');
      }
      try { await saveState(botState); } catch (_) {}
    }
    await sendAlert(`🚨 Bot pipeline error: ${err.message}`).catch(() => {});
    return res.status(500).json({ error: err.message });
  } finally {
    try {
      if (typeof botState !== 'undefined' && botState) {
        const recentLogs = await getLogs(30);
        const stateModified = await detectRealtimeIssues(recentLogs, botState);
        if (stateModified) {
          await saveState(botState);
        }
      }
    } catch (realtimeErr) {
      console.error('[CRON] Real-time anomaly check failed:', realtimeErr.message);
    }

    if (lockHandle) {
      await releaseCandleLock(lockHandle).catch(() => {});
    }

    logCycleStatus(cycleStatus);
  }
}
