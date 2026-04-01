
import { generateSignal } from '../lib/strategy.js';
const indicatorsFakeCrossover = {
  ema20arr: [2000, 2010, 2010],
  ema50arr: [2005, 2005, 2005],
  currEMA20: 2010, currEMA50: 2005, prevEMA20: 2010, prevEMA50: 2005,
  slopePercent: 0.2,
  atr: 3,
  atrAverage: 3,
  rsi: 50,
  resistance: 2050,
  support: 1950,
  trend1h: 'UP',
  lastCandle: { open: 2008, close: 2020, time: 1000 } // dist: 10 > 4.5
};
const candles1mBuy = [
  { open: 2000, close: 2005 },
  { open: 2005, close: 2010 },
  { open: 2010, close: 2020 }
];
const resFake = generateSignal(indicatorsFakeCrossover, candles1mBuy);
console.log('Fake (old crossover) Signal with no EMA touch:', resFake.signal ? resFake.signal.action : 'None', resFake.debug.dbgRejectReason || '');

