
import { generateSignal } from '../lib/strategy.js';

// Fast moving crossover test
const indicatorsBuy = {
  ema20arr: [2000, 2005, 2010],
  ema50arr: [2005, 2005, 2005],
  currEMA20: 2010, currEMA50: 2005, prevEMA20: 2005, prevEMA50: 2005,
  slopePercent: 0.2,
  atr: 3,
  atrAverage: 3,
  rsi: 50,
  resistance: 2050,
  support: 1950,
  trend1h: 'UP',
  lastCandle: { open: 2006, close: 2015, time: 1000 }
};
const candles1mBuy = [
  { open: 2000, close: 2005 },
  { open: 2005, close: 2010 },
  { open: 2010, close: 2015 }
];

const resBuy = generateSignal(indicatorsBuy, candles1mBuy);
console.log('Buy Signal:', resBuy.signal ? resBuy.signal.action : 'None', resBuy.debug.dbgRejectReason || '');

const indicatorsSell = {
  ema20arr: [2010, 2005, 2000],
  ema50arr: [2005, 2005, 2005],
  currEMA20: 2000, currEMA50: 2005, prevEMA20: 2005, prevEMA50: 2005,
  slopePercent: -0.2,
  atr: 3,
  atrAverage: 3,
  rsi: 50,
  resistance: 2050,
  support: 1950,
  trend1h: 'DOWN',
  lastCandle: { open: 2004, close: 1995, time: 1000 }
};
const candles1mSell = [
  { open: 2015, close: 2010 },
  { open: 2010, close: 2005 },
  { open: 2005, close: 1995 }
];

const resSell = generateSignal(indicatorsSell, candles1mSell);
console.log('Sell Signal:', resSell.signal ? resSell.signal.action : 'None', resSell.debug.dbgRejectReason || '');

const indicatorsFakeCrossover = {
  ema20arr: [2000, 2010, 2010], // Crossed at 1 (previous), but current is same
  ema50arr: [2005, 2005, 2005], // Meaning crossover was 2 bars ago (from index 0 to 1) 
  currEMA20: 2010, currEMA50: 2005, prevEMA20: 2010, prevEMA50: 2005,
  slopePercent: 0.2,
  atr: 3,
  atrAverage: 3,
  rsi: 50,
  resistance: 2050,
  support: 1950,
  trend1h: 'UP',
  lastCandle: { open: 2008, close: 2011, time: 1000 }
};
const resFake = generateSignal(indicatorsFakeCrossover, candles1mBuy);
console.log('Fake (old crossover) Signal:', resFake.signal ? resFake.signal.action : 'None', resFake.debug.dbgRejectReason || '');

console.log('TEST COMPLETE');

