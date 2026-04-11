import { generateSignal } from './lib/strategy.js';

// Test signal logic with real data from logs (mocked for verification)
const mockIndicators = {
  currEMA20: 4500.50,
  currEMA50: 4495.20,
  prevEMA20: 4494.80,
  prevEMA50: 4495.10,
  slopePercent: 0.20,
  atr: 2.50,
  atrAverage: 2.00,
  rsi: 55,
  resistance: 4510.00,
  support: 4480.00,
  trend1h: 'UP',
  lastCandle: { close: 4501.00, open: 4500.00, time: Date.now() },
  ema20arr: [4494.80, 4500.50],
  ema50arr: [4495.10, 4495.20]
};

const mockCandles1m = [
  { open: 4500.00, close: 4500.20 },
  { open: 4500.20, close: 4500.50 },
  { open: 4500.50, close: 4501.00 }
];

console.log('--- SIGNAL ACCURACY VERIFICATION ---');
const { signal, debug } = generateSignal(mockIndicators, mockCandles1m);

if (signal && signal.action === 'BUY' && signal.entryType === 'crossover') {
    console.log('PASS: Crossover Long Signal triggered correctly.');
} else {
    console.log('FAIL: Crossover Long Signal logic error.');
    console.log('Debug:', debug);
}

// Test rejection (No crossover)
const mockRejected = { ...mockIndicators, prevEMA20: 4496.00 }; // Already crossed
const { signal: signalR, debug: debugR } = generateSignal(mockRejected, mockCandles1m);

if (!signalR) {
    console.log(`PASS: Signal rejected as expected. Reason: ${debugR.dbgRejectReason}`);
} else {
    console.log('FAIL: Bot should have rejected signal (duplicate/stale crossover).');
}

console.log('--- END OF ACCURACY VERIFICATION ---');
