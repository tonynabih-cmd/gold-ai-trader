import { getCapitalSession } from './lib/session.js';
import { getMarketData } from './lib/market_data.js';
import { calculateIndicators } from './lib/indicators.js';
import { generateSignal } from './lib/strategy.js';
import { checkRisk } from './lib/risk.js';
import { loadState } from './lib/state.js';

async function main() {
  try {
    const session = await getCapitalSession();
    const botState = await loadState();
    const marketData = await getMarketData(session, botState);

    if (marketData.skip) {
      console.log('--- MARKET DATA SKIP ---');
      console.log('Reason:', marketData.reason);
      return;
    }

    const { candles5m, candles1h, candles1m, spread } = marketData;
    const indicators = calculateIndicators(candles5m, candles1h);
    indicators.spread = spread;

    console.log('--- CURRENT INDICATORS ---');
    console.log('EMA20:', indicators.currEMA20.toFixed(2));
    console.log('EMA50:', indicators.currEMA50.toFixed(2));
    console.log('Slope:', (indicators.slopePercent * 100).toFixed(4) + '%');
    console.log('ATR:', indicators.atr.toFixed(2));
    console.log('RSI:', indicators.rsi.toFixed(2));
    console.log('Spread:', spread.toFixed(2));

    const { signal, debug: signalDebug } = generateSignal(indicators, candles1m);

    console.log('--- STRATEGY SIGNAL ---');
    if (signal) {
      console.log('Type:', signal.entryType);
      console.log('Action:', signal.action);
      console.log('Price:', signal.entryPrice);
      console.log('Score:', signal.score);
    } else {
      console.log('Result: NO SIGNAL');
      console.log('Debug Reject Reason:', signalDebug.dbgRejectReason || 'Unknown');
    }

    const riskResult = checkRisk(signal, botState, indicators);
    console.log('--- RISK CHECK ---');
    console.log('Result:', riskResult);

  } catch (err) {
    console.error('Fatal error:', err.message);
  }
}

main();
