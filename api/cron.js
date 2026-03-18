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
    // 1. Load + daily reset
    botState = await loadState();
    botState  = dailyReset(botState);
    botState  = await syncBalance(botState);

    // 2. Fetch market data
    const marketData = await getMarketData(botState);

    if (marketData.skip) {
      // ✅ FIX: Always save state so heartbeat stays fresh even on skips
      await heartbeat(botState);
      await saveLog({
        signal: null, indicators: null,
        botState, tradeExecuted: false,
        reason: marketData.reason,
      });
      return res.json({ skipped: marketData.reason });
    }

    // 3. Update candle cache
    botState.candles5m = marketData.candles5m;

    // ✅ FIX: Update lastProcessedCandle HERE (not only on trade approval)
    // This prevents every subsequent run from hitting "Duplicate candle"
    botState.lastProcessedCandle = marketData.latestCandleTime;

    // 4. Calculate indicators
    const indicators = calculateIndicators(
      marketData.candles5m,
      marketData.candles1h
    );

    if (indicators.skip) {
      await saveLog({
        signal: null, indicators,
        botState, tradeExecuted: false,
        reason: indicators.reason,
      });
      await saveState(botState);
      await heartbeat(botState);
      return res.json({ skipped: indicators.reason });
    }

    // 5. Generate signal
    const signal = generateSignal(indicators, marketData.candles1m);

    // 6. Risk check
    const riskResult = checkRisk(signal, botState, indicators);

    if (riskResult !== 'APPROVED') {
      await saveLog({
        signal, indicators,
        botState, tradeExecuted: false,
        reason: riskResult,
      });
      await saveState(botState);
      await heartbeat(botState);
      return res.json({ skipped: riskResult });
    }

    // 7. Place trade
    const tradeResult = await placeTrade(signal, botState);

    if (!tradeResult.success) {
      await saveLog({
        signal, indicators,
        botState, tradeExecuted: false,
        reason: tradeResult.reason,
      });
      await saveState(botState);
      await heartbeat(botState);
      return res.json({ skipped: tradeResult.reason });
    }

    // 8. Log success
    await saveLog({
      signal, indicators,
      botState, tradeExecuted: true,
      result: tradeResult, reason: null,
    });

    // 9. Save state + heartbeat
    await saveState(botState);
    await heartbeat(botState);

    // 10. Performance check
    const logs = await getLogs();
    await checkPerformance(logs, botState);

    // 11. Alert
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
    if (botState) {
      try { await saveState(botState); } catch (_) {}
    }
    await sendAlert(`🚨 Bot error: ${err.message}`).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
}
