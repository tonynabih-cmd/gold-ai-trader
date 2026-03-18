import { getCapitalSession } from './session.js';
import { getMarketData } from './market_data.js';
import { calculateIndicators } from './indicators.js';
import { generateSignal } from './strategy.js';
import { checkRisk } from './risk.js';
import { placeTrade, syncBalance } from './execution.js';
import { saveLog, getLogs } from './logger.js';
import { loadState, saveState, dailyReset } from './state.js';
import { heartbeat, sendAlert, checkPerformance } from './monitor.js';

export default async function handler(req, res) {
  let botState;

  try {
    botState = await loadState();
    botState  = dailyReset(botState);

    // ONE session for all Capital.com calls this run
    let session;
    try {
      session = await getCapitalSession();
    } catch (err) {
      await saveLog({ signal: null, indicators: null, botState, tradeExecuted: false, reason: `SKIP: Auth failed - ${err.message}` });
      return res.json({ skipped: `Auth failed - ${err.message}` });
    }

    botState = await syncBalance(session, botState);

    const marketData = await getMarketData(session, botState);

    if (marketData.skip) {
      await heartbeat(botState);
      await saveLog({ signal: null, indicators: null, botState, tradeExecuted: false, reason: marketData.reason });
      await saveState(botState);
      return res.json({ skipped: marketData.reason });
    }

    botState.candles5m = marketData.candles5m;
    botState.lastProcessedCandle = marketData.latestCandleTime;

    const indicators = calculateIndicators(marketData.candles5m, marketData.candles1h);

    if (indicators.skip) {
      await saveLog({ signal: null, indicators, botState, tradeExecuted: false, reason: indicators.reason });
      await saveState(botState);
      await heartbeat(botState);
      return res.json({ skipped: indicators.reason });
    }

    const signal = generateSignal(indicators, marketData.candles1m);
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
      `✅ ${signal.action} XAUUSD\n` +
      `Entry: $${signal.entryPrice.toFixed(3)}\n` +
      `SL: $${signal.stopLoss.toFixed(3)}\n` +
      `TP: $${signal.takeProfit.toFixed(3)}\n` +
      `Size: ${tradeResult.size}oz | Score: ${signal.score}`
    );

    return res.json({
      success: true,
      action: signal.action,
      entry: signal.entryPrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      size: tradeResult.size,
      score: signal.score,
    });

  } catch (err) {
    console.error('Cron error:', err.message);
    if (botState) try { await saveState(botState); } catch (_) {}
    await sendAlert(`🚨 Bot error: ${err.message}`).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
}
