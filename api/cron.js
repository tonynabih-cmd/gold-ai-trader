import { getCapitalSession } from '../lib/session.js';
import { getMarketData } from '../lib/market_data.js';
import { calculateIndicators } from '../lib/indicators.js';
import { generateSignal } from '../lib/strategy.js';
import { checkRisk } from '../lib/risk.js';
import { placeTrade, syncBalance } from '../lib/execution.js';
import { saveLog, getLogs } from '../lib/logger.js';
import { loadState, saveState, dailyReset } from '../lib/state.js';
import { heartbeat, sendAlert, checkPerformance } from '../lib/monitor.js';

async function syncOpenTrades(session, botState) {
  try {
    if (!botState.openTrades || botState.openTrades.length === 0) return botState;

    const { baseUrl, cst, securityToken } = session;
    const res = await fetch(`${baseUrl}/api/v1/positions`, {
      headers: {
        'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
        'CST': cst,
        'X-SECURITY-TOKEN': securityToken,
      },
    });

    if (!res.ok) return botState;

    const data          = await res.json();
    const livePositions = data.positions || [];
    const liveDealRefs  = new Set(livePositions.map(p => p.position?.dealReference));

    const before = botState.openTrades.length;
    botState.openTrades = botState.openTrades.filter(t =>
      t.dealReference && liveDealRefs.has(t.dealReference)
    );
    const closed = before - botState.openTrades.length;
    if (closed > 0) console.log(`Synced open trades: removed ${closed} closed position(s)`);

    return botState;
  } catch (err) {
    console.error('syncOpenTrades error:', err.message);
    return botState;
  }
}

export default async function handler(req, res) {
  let botState;

  try {
    botState = await loadState();
    botState  = dailyReset(botState);

    let session;
    try {
      session = await getCapitalSession();
    } catch (err) {
      await saveLog({ signal: null, indicators: null, botState, tradeExecuted: false, reason: `SKIP: Auth failed - ${err.message}` });
      return res.json({ skipped: `Auth failed - ${err.message}` });
    }

    botState = await syncBalance(session, botState);
    botState = await syncOpenTrades(session, botState);

    const marketData = await getMarketData(session, botState);

    if (marketData.skip) {
      await heartbeat(botState);
      await saveLog({ signal: null, indicators: null, botState, tradeExecuted: false, reason: marketData.reason });
      await saveState(botState);
      return res.json({ skipped: marketData.reason });
    }

    botState.candles5m           = marketData.candles5m;
    botState.lastProcessedCandle = marketData.latestCandleTime;

    const indicators = calculateIndicators(marketData.candles5m, marketData.candles1h);

    if (indicators.skip) {
      await saveLog({ signal: null, indicators, botState, tradeExecuted: false, reason: indicators.reason });
      await saveState(botState);
      await heartbeat(botState);
      return res.json({ skipped: indicators.reason });
    }

    const signal     = generateSignal(indicators, marketData.candles1m);
    const riskResult = checkRisk(signal, botState, indicators);

    if (riskResult !== 'APPROVED') {
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: riskResult });
      await saveState(botState);
      await heartbeat(botState);
      return res.json({ skipped: riskResult });
    }

    const tradeResult = await placeTrade(session, signal, botState);

    if (!tradeResult.success) {
      await saveLog({ signal, indicators, botState, tradeExecuted: false, reason: tradeResult.reason });
      await saveState(botState);
      await heartbeat(botState);
      return res.json({ skipped: tradeResult.reason });
    }

    await saveLog({ signal, indicators, botState, tradeExecuted: true, result: tradeResult, reason: null });
    await saveState(botState);
    await heartbeat(botState);

    const logs = await getLogs();
    await checkPerformance(logs, botState);

    await sendAlert(
      `✅ ${signal.action} GOLD\n` +
      `Entry: $${signal.entryPrice.toFixed(2)}\n` +
      `SL: $${signal.stopLoss.toFixed(2)}\n` +
      `TP: $${signal.takeProfit.toFixed(2)}\n` +
      `Size: ${tradeResult.size}oz | Score: ${signal.score}`
    );

    return res.json({
      success:  true,
      action:   signal.action,
      entry:    signal.entryPrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      size:     tradeResult.size,
      score:    signal.score,
    });

  } catch (err) {
    console.error('Cron error:', err.message);
    if (botState) try { await saveState(botState); } catch (_) {}
    await sendAlert(`🚨 Bot error: ${err.message}`).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
}
