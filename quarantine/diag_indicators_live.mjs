import { getCapitalSession } from './lib/session.js';
import { getMarketData } from './lib/market_data.js';
import { calculateIndicators } from './lib/indicators.js';
import { loadState } from './lib/state.js';

async function main() {
    const session = await getCapitalSession();
    const botState = await loadState();
    
    // Hack to ignore skip
    const marketData = await getMarketData(session, { ...botState, lastProcessedCandle: 0 });
    
    const indicators = calculateIndicators(marketData.candles5m, marketData.candles1h);
    console.log('--- Current indicators (Bypassing skip) ---');
    console.log(`Gold Price: ${indicators.lastCandle.close}`);
    console.log(`EMA20: ${indicators.currEMA20.toFixed(2)}`);
    console.log(`EMA50: ${indicators.currEMA50.toFixed(2)}`);
    console.log(`RSI: ${indicators.rsi.toFixed(2)}`);
    console.log(`Slope: ${(indicators.slopePercent * 100).toFixed(4)}%`);
    console.log(`ATR: ${indicators.atr.toFixed(2)}`);
}

main().catch(console.error);
