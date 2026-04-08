import { getCapitalSession }               from '../lib/session.js';
import { getMarketData }                   from '../lib/market_data.js';
import { calculateIndicators }             from '../lib/indicators.js';
import { generateSignal }                  from '../lib/strategy.js';
import { checkRisk, calculateDrawdown }              from '../lib/risk.js';
import { placeTrade, syncBalance, fetchClosedTradePnl, fetchBrokerTradeStats, fetchBrokerPositions, verifyExecutionCertainty, SYNC_WINDOW_MS, fetchCurrentGoldPrice, USD_AED_PEG, modifyTradeStopLoss } from '../lib/execution.js';
import { saveLog, getLogs }                from '../lib/logger.js';
import { loadState, saveState, saveStateWithOptions, saveStateCritical, dailyReset, acquireCandleLock, validateStateIntegrity, createLockOwnerToken, verifyCandleLockOwnership, renewCandleLock, releaseCandleLock, pingRedis } from '../lib/state.js';
import { sendAlert, checkPerformance }     from '../lib/monitor.js';
import { fetchWithTimeout }                from '../lib/fetch.js';


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
            signal: { id: trade.tradeId, action: trade.action, entryType: 'sync_event', entryPrice: null, strategyVersion: trade.strategyVersion || 'v1.4' },
            indicators: null,
            botState: { ...botState },
            tradeExecuted: false,
            reason: `SYNC_DISAPPEAR: dealId=${dealId} not found in active positions. firstMissingAt=${new Date(trade.firstMissingAt).toISOString()} | entry=${trade.entry}`,
            result: null,
          }).catch(() => {});
        }

        const elapsedMs  = Date.now() - trade.firstMissingAt;
        const elapsedMin = Math.floor(elapsedMs / 60000);

        // Check transaction history (internal retry handles transient API delays)
        const realizedPnl = await fetchClosedTradePnl(session, dealId, trade.openedAt);

        if (realizedPnl !== null) {
          trade.realizedPnl = realizedPnl;
          justClosed.push(trade);
          console.log(`[SYNC] ✅ Confirmed closure for dealId ${dealId} | P&L ${realizedPnl} | elapsed ${elapsedMin}m`);
        } else if (elapsedMs < SYNC_WINDOW_MS) {
          // Within sync window — keep tracked, do NOT block new trades
          console.warn(`[SYNC] Trade ${dealId} still missing from history (${elapsedMin}m / ${Math.floor(SYNC_WINDOW_MS / 60000)}m). Awaiting broker sync.`);
          await saveLog({
            signal: { id: trade.tradeId, action: trade.action, entryType: 'sync_event', entryPrice: null, strategyVersion: trade.strategyVersion || 'v1.4' },
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
          strategyVersion: closedTrade.strategyVersion || 'v1.4'
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

export default async function handler(req, res) {
  // ── Authorization ─────────────────────────────────────────────────────────
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  const providedAuth = req.headers['authorization'] || req.headers['Authorization'];
  if (process.env.CRON_SECRET && providedAuth !== expectedAuth) {
    console.warn('Unauthorized cron trigger attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let botState;
  let lockHandle = null;
  let invocationStateVersion = 0;

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

  // ── Step 0: Redis health check ────────────────────────────────────────────
  // Must run before loadState() so a missing/expired KV_REST_API_URL or
  // KV_REST_API_TOKEN is caught here and reported clearly — instead of
  // propagating silently and making acquireCandleLock() return null, which
  // the cron handler incorrectly interprets as a concurrency lock conflict and
  // blocks all trading indefinitely.
  const redisReachable = await pingRedis();
  if (!redisReachable) {
    const msg = 'Redis unreachable — verify KV_REST_API_URL and KV_REST_API_TOKEN are set in Vercel environment variables';
    console.error(`[CRON] ⚠️ ${msg}`);
    await sendAlert(`🚨 Bot blocked: ${msg}`).catch(() => {});
    return res.status(503).json({ error: msg });
  }

  try {
    // ── Step 1: Load state + daily reset ─────────────────────────────────────
    botState = await loadState();
    
    // Performance Tracking: Output summary every 24h (before daily reset)
    const uaeDate = new Date(new Date().getTime() + (4 * 60 * 60 * 1000));
    const today = uaeDate.toISOString().slice(0, 10);
    if (botState.lastTradingDay && botState.lastTradingDay !== today) {
        console.log(`[STATE] 24h summary trigger: day changed from ${botState.lastTradingDay} to ${today}`);
        try {
            const logs = await getLogs();
            const stats = checkPerformance(logs, botState); // This triggers alerts if needed
            
            // Daily Summary Alert
            const outcomes = Array.isArray(botState.recentOutcomes) ? botState.recentOutcomes : [];
            const dayOutcomes = outcomes.filter(o => {
                const oDay = new Date(o.closedAt + (4 * 60 * 60 * 1000)).toISOString().slice(0, 10);
                return oDay === botState.lastTradingDay;
            });
            
            const dayPnl = dayOutcomes.reduce((sum, o) => sum + (o.pnl || 0), 0);
            const dayWins = dayOutcomes.filter(o => o.pnl > 0).length;
            const dayLosses = dayOutcomes.filter(o => o.pnl < 0).length;
            const dayWR = dayOutcomes.length > 0 ? (dayWins / dayOutcomes.length * 100).toFixed(1) : '0';
            
            const breakoutTrades = dayOutcomes.filter(o => o.entryType === 'breakout');
            const trendTrades = dayOutcomes.filter(o => o.entryType !== 'breakout'); // pullback, crossover, momentum
            
            const breakoutWR = breakoutTrades.length > 0 ? (breakoutTrades.filter(o => o.pnl > 0).length / breakoutTrades.length * 100).toFixed(1) : '0';
            const trendWR = trendTrades.length > 0 ? (trendTrades.filter(o => o.pnl > 0).length / trendTrades.length * 100).toFixed(1) : '0';

            await sendAlert(
                `📊 24h PERFORMANCE SUMMARY (${botState.lastTradingDay})\n` +
                `Total Trades: ${dayOutcomes.length}\n` +
                `Daily P&L: AED ${dayPnl.toFixed(2)}\n` +
                `Win Rate: ${dayWR}% (${dayWins}W / ${dayLosses}L)\n` +
                `Drawdown: ${botState.totalDrawdown}%\n\n` +
                `Breakout Performance: ${breakoutTrades.length} trades (${breakoutWR}% WR)\n` +
                `Pullback/Trend Performance: ${trendTrades.length} trades (${trendWR}% WR)\n` +
                `Profit Factor: ${botState.rollingProfitFactor15 || 'N/A'}`
            );
        } catch (summErr) {
            console.error('[CRON] Summary generation failed:', summErr.message);
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
      return res.json({ skipped: 'Bot disabled via state (drawdown or performance threshold)' });
    }

    if (botState.criticalFailure === true) {
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
      return res.json({ skipped: reason });
    }

    // ── STEP 4b: Trade Management (Break-Even & Trailing Stop) ────────────────
    if (Array.isArray(botState.openTrades) && botState.openTrades.length > 0) {
      const livePrice = await fetchCurrentGoldPrice(session);
      if (livePrice) {
        for (let i = 0; i < botState.openTrades.length; i++) {
          const t = botState.openTrades[i];
          if (!t.entry || !t.stopLoss) continue;

          // Compute R (Risk) = distance between entry and initial stop loss
          // If initialStopLoss is not stored, we use the current stopLoss as a proxy if it hasn't moved yet.
          const initialSL = t.initialStopLoss || t.stopLoss;
          const riskAmount = Math.abs(t.entry - initialSL);
          if (riskAmount <= 0) continue;

          const liveBid   = livePrice.bid;
          const liveOffer = livePrice.offer;
          const currentProfit = t.action === 'BUY' ? liveBid - t.entry : t.entry - liveOffer;
          const currentR = currentProfit / riskAmount;

          let newStopLevel = null;
          let label = '';

          // 1. Trailing Stop Rule: activate after +1.5R
          if (currentR >= 1.5) {
            // Trail using 1.2x ATR (matching original risk distance)
            const atr = t.atr || 2.0;
            const trailDist = atr * 1.2;
            const trailSL = t.action === 'BUY' ? liveBid - trailDist : liveOffer + trailDist;
            
            // For trailing, we only move if it IMPROVES the stop
            if (t.action === 'BUY') {
              if (trailSL > (t.stopLoss || 0)) {
                newStopLevel = trailSL;
                label = 'Trailing stop active';
              }
            } else {
              if (trailSL < (t.stopLoss || 999999)) {
                newStopLevel = trailSL;
                label = 'Trailing stop active';
              }
            }
          } 
          // 2. Break-Even Rule: reaches +1R
          else if (currentR >= 1.0 && !t.breakEvenMoved) {
            newStopLevel = t.entry;
            label = 'BE activated';
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
              console.log(`[SYNC] ${label}: Trade ${t.dealId} profit ${currentR.toFixed(2)}R. New SL: $${newStopLevel.toFixed(2)}.`);

              const mod = await modifyTradeStopLoss(session, t.dealId, {
                stopLevel:   parseFloat(newStopLevel.toFixed(2)),
                profitLevel: t.takeProfit ? parseFloat(t.takeProfit.toFixed(2)) : null
              });

              if (mod.success) {
                t.breakEvenMoved = true;
                if (!t.initialStopLoss) t.initialStopLoss = initialSL;
                t.stopLoss = newStopLevel;
                
                await saveLog({
                  signal: { id: t.tradeId, action: t.action, entryType: 'sync_event' },
                  indicators: null,
                  botState: { ...botState },
                  tradeExecuted: false,
                  reason: label,
                  result: { dbgNewStop: newStopLevel, dbgCurrentR: currentR }
                });

                await sendAlert(`🛡️ ${label}: ${t.action} Gold dealId ${t.dealId}\nNew SL: $${newStopLevel.toFixed(2)}`);
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
           console.warn(`[CRON]    → This prevents duplicate trades on the same signal`);
           marketData.skip = true;
           marketData.reason = `SKIP: Concurrency lock blocked this invocation (candle ${marketData.latestCandleTime} already being processed by another instance)`;
        } else {
           botState.lastProcessedCandle = marketData.latestCandleTime;
           console.log(`[CRON] ✓ Candle lock acquired for ${marketData.latestCandleTime} — this invocation will process signals`);
        }
      }

      // Calculate indicators even on skips for dashboard live values
      indicators = calculateIndicators(marketData.candles5m, marketData.candles1h);
      indicators.spread = marketData.spread ?? null;
    }

    // If market data skipped OR indicators skipped:
    if (marketData.skip || (indicators && indicators.skip)) {
      const reason = marketData.skip ? marketData.reason : indicators.reason;
      
      let signalDebug = undefined;
      // Evaluate strategy purely for debug telemetry even if this cycle is skipping
      if (indicators && !indicators.skip && marketData.candles1m) {
        const generated = generateSignal(indicators, marketData.candles1m);
        signalDebug = generated.debug;
      }

      botState.lastHeartbeat = Date.now();
      await saveLog({ signal: null, indicators, botState, tradeExecuted: false, reason, signalDebug });
      await saveStateWithOptions(botState, { expectedVersion: invocationStateVersion });
      return res.json({ skipped: reason });
    }

    // ── Step 7: Generate signal ───────────────────────────────────────────────
    indicators.lastOrderTimestamp = botState.lastOrderTimestamp;
    let { signal, debug: signalDebug } = generateSignal(indicators, marketData.candles1m);

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
              takeProfit: entry + (atr * 2.25),
              atr,
              score: 5,
              strategyVersion: 'forced_v1.0',
              timestamp: Date.now()
          };
          signalDebug = { dbgRejectReason: null, dbgAction: action, dbgEntryType: 'forced_test' };
          console.warn(`[FORCE] Created test signal: ${action} @ ${entry}`);
      }
    }

    // ── Step 8: Risk checks ───────────────────────────────────────────────────
    const riskResult = (process.env.FORCE_TRADE === 'true' && signal?.entryType === 'forced_test') 
      ? 'APPROVED' 
      : checkRisk(signal, botState, indicators);

    if (riskResult !== 'APPROVED') {
      if (riskResult.startsWith('STOP:') || riskResult.startsWith('DISABLE:')) {
        await sendAlert(`🚨 ${riskResult}`).catch(() => {});
      }
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: riskResult, signalDebug });
      await saveState(botState);
      return res.json({ skipped: riskResult });
    }

    if (!lockHandle) {
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: 'SKIP: Missing execution lock handle', signalDebug });
      await saveStateWithOptions(botState, { expectedVersion: invocationStateVersion });
      return res.json({ skipped: 'SKIP: Missing execution lock handle' });
    }

    const lockOwnedBeforeExecution = await verifyCandleLockOwnership(lockHandle);
    if (!lockOwnedBeforeExecution) {
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: 'SKIP: Lock ownership lost before execution', signalDebug });
      await saveStateWithOptions(botState, { expectedVersion: invocationStateVersion });
      return res.json({ skipped: 'SKIP: Lock ownership lost before execution' });
    }

    const lockRenewedBeforeExecution = await renewCandleLock(lockHandle, 120);
    if (!lockRenewedBeforeExecution) {
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: 'SKIP: Lock renewal failed before execution', signalDebug });
      await saveStateWithOptions(botState, { expectedVersion: invocationStateVersion });
      return res.json({ skipped: 'SKIP: Lock renewal failed before execution' });
    }

    const certainty = await verifyExecutionCertainty(session, botState);
    if (!certainty.ok) {
      if (certainty.reason.includes('LOCAL_NOT_ON_BROKER') || certainty.reason.includes('BROKER_NOT_LOCAL')) {
        const skipReason = `SKIP: Race condition detected during execution gate (${certainty.reason})`;
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
      await saveStateCritical(botState, `execution_barrier:${certainty.reason}`);
      return res.json({ skipped: certainty.reason });
    }

    const lockOwnedAtExecution = await verifyCandleLockOwnership(lockHandle);
    if (!lockOwnedAtExecution) {
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: 'SKIP: Lock ownership lost at execution gate', signalDebug });
      await saveStateWithOptions(botState, { expectedVersion: invocationStateVersion });
      return res.json({ skipped: 'SKIP: Lock ownership lost at execution gate' });
    }

    const lockRenewedAtExecution = await renewCandleLock(lockHandle, 120);
    if (!lockRenewedAtExecution) {
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: 'SKIP: Lock renewal failed at execution gate', signalDebug });
      await saveStateWithOptions(botState, { expectedVersion: invocationStateVersion });
      return res.json({ skipped: 'SKIP: Lock renewal failed at execution gate' });
    }

    // ── Step 9: Place trade ───────────────────────────────────────────────────
    const tradeResult = await placeTrade(session, signal, botState);

    if (!tradeResult.success) {
      if (String(tradeResult.reason || '').startsWith('CRITICAL_FAILURE')) {
        botState.botEnabled = false;
        botState.stateIntegrityOk = false;
        botState.criticalFailure = true;
        botState.criticalFailureReason = tradeResult.reason;
      }
      botState.lastHeartbeat = Date.now();
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: tradeResult.reason, signalDebug });
      await saveState(botState);
      return res.json({ skipped: tradeResult.reason });
    }

    // ── Step 10: Log success ──────────────────────────────────────────────────
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
    console.error('[CRON] Pipeline error:', err.message, err.stack);
    if (botState) {
      if (err?.code === 'FETCH_TIMEOUT') {
        botState.botEnabled = false;
        botState.stateIntegrityOk = false;
        botState.criticalFailure = true;
        botState.criticalFailureReason = 'CRITICAL_TIMEOUT';
      }
      try { await saveState(botState); } catch (_) {}
    }
    await sendAlert(`🚨 Bot pipeline error: ${err.message}`).catch(() => {});
    return res.status(500).json({ error: err.message });
  } finally {
    if (lockHandle) {
      await releaseCandleLock(lockHandle).catch(() => {});
    }
  }
}
