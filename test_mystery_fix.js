import { checkRisk } from './lib/risk.js';

process.env.BOT_ENABLED = 'true';

const signal = { id: "test", action: "BUY", entryPrice: 100, stopLoss: 90, takeProfit: 120, score: 5 };
const botState = { botEnabled: true, balance: 1000, dailyTrades: 0, dailyLoss: 0, openTrades: [] };
const indicatorsBase = { atr: 10, atrAverage: 10, lastCandle: { close: 100 } };

console.log("--- Testing Mystery Fix (Rule 11) ---");

// Case 1: Spread is null
const resNull = checkRisk(signal, botState, { ...indicatorsBase, spread: null });
console.log("Spread null result:", resNull);

// Case 2: Spread is undefined
const resUndef = checkRisk(signal, botState, { ...indicatorsBase, spread: undefined });
console.log("Spread undefined result:", resUndef);

// Case 3: Spread is 0.5 (should still skip)
const resHigh = checkRisk(signal, botState, { ...indicatorsBase, spread: 0.5 });
console.log("Spread 0.5 Result:", resHigh);

// Case 4: Spread is 0.3 (should approve)
const resOk = checkRisk(signal, botState, { ...indicatorsBase, spread: 0.3 });
console.log("Spread 0.3 Result:", resOk);

if (resNull.startsWith('SKIP') && resUndef.startsWith('SKIP') && resHigh.startsWith('SKIP') && resOk === 'APPROVED') {
    console.log("\nALL TESTS PASSED! Safety fix is working.");
} else {
    console.log("\nTEST FAILED! checkRisk logic anomaly.");
}
