import { getMarketData } from './market_data.js';
import { calculateIndicators } from './indicators.js';
import { generateSignal } from './strategy.js';
import { checkRisk } from './risk.js';
import { placeTrade, syncBalance } from './execution.js'; // ← combined into one line
import { saveLog, getLogs } from './logger.js';
import { loadState, saveState, dailyReset } from './state.js';
import { heartbeat, sendAlert, checkPerformance } from './monitor.js';

export default async function handler(req, res) {
  try {
    // 1. Load state
    let botState = await loadState();

    // 2. Daily reset
    botState = dailyReset(botState);
botState = await syncBalance(botState);
    // 3. Fetch market data
    const marketData = await getMarketData(botState);
 if (marketData.skip) {
  await saveLog({ signal: null, indicators: null, botState, tradeExecuted: false, reason: marketData.reason });
  await saveState(botState);
  return res.json({ skipped: marketData.reason });
}

    // 4. Update candle cache in state
    botState.candles5m = marketData.candles5m;

    // 5. Calculate indicators
    const indicators = calculateIndicators(
      marketData.candles5m,
      marketData.candles1h
    );
if (indicators.skip) {
  await saveLog({ signal: null, indicators, botState, tradeExecuted: false, reason: indicators.reason });
  await saveState(botState);
  return res.json({ skipped: indicators.reason });
}

    // 6. Generate signal
    const signal = generateSignal(indicators, marketData.candles1m);

    // 7. Check all 18 risk rules
    const riskResult = checkRisk(signal, botState, indicators);

    if (riskResult !== 'APPROVED') {
      // Log the skip
      await saveLog({
        signal,
        indicators,
        botState,
        tradeExecuted: false,
        reason: riskResult,
      });

      // Update last processed candle
      botState.lastProcessedCandle = marketData.latestCandleTime;
      await saveState(botState);
      await heartbeat(botState);

      return res.json({ skipped: riskResult });
    }

    // 8. Place trade on Capital.com
    const tradeResult = await placeTrade(signal, botState);

    if (!tradeResult.success) {
      await saveLog({
        signal,
        indicators,
        botState,
        tradeExecuted: false,
        reason: tradeResult.reason,
      });
      await saveState(botState);
      return res.json({ skipped: tradeResult.reason });
    }

    // 9. Log successful trade
    await saveLog({
      signal,
      indicators,
      botState,
      tradeExecuted: true,
      result: tradeResult,
      reason: null,
    });

    // 10. Update processed candle
    botState.lastProcessedCandle = marketData.latestCandleTime;

    // 11. Save state
    await saveState(botState);

    // 12. Heartbeat
    await heartbeat(botState);

    // 13. Performance check
    const logs = await getLogs();
    await checkPerformance(logs, botState);

    // 14. Send trade alert
    await sendAlert(
      `✅ ${signal.action} XAUUSD\n` +
      `Entry: $${signal.entryPrice.toFixed(3)}\n` +
      `SL: $${signal.stopLoss.toFixed(3)}\n` +
      `TP: $${signal.takeProfit.toFixed(3)}\n` +
      `Size: ${tradeResult.size}oz\n` +
      `Score: ${signal.score}`
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
    await sendAlert(`🚨 Bot error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
}
