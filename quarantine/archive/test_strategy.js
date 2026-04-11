import { generateSignal } from '../lib/strategy.js';

const mockIndicators = {
  currEMA20: 1999,
  currEMA50: 2000,
  prevEMA20: 2001,
  prevEMA50: 2000,
  slopePercent: 0.15, // Uptrend slope (positive)
  atr: 5,
  atrAverage: 5,
  rsi: 50,
  resistance: 2050,
  support: 1950,
  trend1h: 'UP',
  lastCandle: { open: 2000, close: 1998 }, // Bearish candle
  ema20arr: [2001, 1999],
  ema50arr: [2000, 2000]
};

const mockCandles1m = [
  { open: 2000, close: 1999 },
  { open: 1999, close: 1998 },
  { open: 1998, close: 1997 }
];

// This is a SELL crossover (20 cross below 50) while slope is still positive (0.15)
// Previously this would be rejected due to weak Slope (for SELL) and Override failing (separation too small).

const result = generateSignal(mockIndicators, mockCandles1m);

console.log("Result:", JSON.stringify(result, null, 2));

if (result && result.signal && result.signal.action === 'SELL') {
  console.log("SUCCESS: SELL signal generated despite positive EMA50 slope!");
} else {
  console.log("FAILURE: SELL signal not generated or rejected.");
}
