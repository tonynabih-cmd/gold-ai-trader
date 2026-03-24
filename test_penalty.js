import { generateSignal } from './lib/strategy.js';

const mockIndicators = {
  currEMA20: 2001,
  currEMA50: 2000,
  prevEMA20: 1999,
  prevEMA50: 2000,
  slopePercent: -0.15, // Downtrend slope
  atr: 5,
  atrAverage: 5,
  rsi: 50,
  resistance: 2050,
  support: 1950,
  trend1h: 'DOWN', // 1h trend is DOWN
  lastCandle: { open: 2000, close: 2002 }, // Bullish candle
  ema20arr: [1999, 2001],
  ema50arr: [2000, 2000]
};

const mockCandles1m = [
  { open: 2000, close: 2001 },
  { open: 2001, close: 2002 },
  { open: 2002, close: 2003 }
];

// This is a BUY crossover (20 cross ABOVE 50) while 1h trend is DOWN.
// It should get:
// +2 for crossover
// +1 for candle matches
// +1 for ATR > 2
// -1 for counter-trend (trend1h is DOWN)
// Total: 3. (Should pass since score >= 2)

const result = generateSignal(mockIndicators, mockCandles1m);

console.log("Result:", JSON.stringify(result, null, 2));

if (result && result.signal && result.signal.score === 3) {
  console.log("SUCCESS: Signal generated with -1 penalty for counter-trend!");
} else {
  console.log("FAILURE: Unexpected result.");
}
