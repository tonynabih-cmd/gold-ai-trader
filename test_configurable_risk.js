import { checkRisk } from './lib/risk.js';

process.env.BOT_ENABLED = 'true';

const signal = { id: "test", action: "BUY", entryPrice: 100, stopLoss: 90, takeProfit: 120, score: 5 };
const botState = { botEnabled: true, balance: 1000, dailyTrades: 0, dailyLoss: 0, openTrades: [] };
const indicatorsBase = { atr: 10, atrAverage: 10, lastCandle: { close: 100 } };

async function runTests() {
    console.log("--- Testing Configurable Spread Limit (Rule 11) ---");

    // Case 1: Default (0.50) - 0.50 spread should PASS, 0.51 should SKIP
    delete process.env.MAX_SPREAD;
    const resDefault050 = checkRisk(signal, botState, { ...indicatorsBase, spread: 0.50 });
    const resDefault051 = checkRisk(signal, botState, { ...indicatorsBase, spread: 0.51 });
    console.log("Default (0.50 limit): 0.50 spread ->", resDefault050);
    console.log("Default (0.50 limit): 0.51 spread ->", resDefault051);

    // Case 2: Custom limit (0.80) - 0.70 spread should PASS
    process.env.MAX_SPREAD = "0.80";
    const resCustom080_070 = checkRisk(signal, botState, { ...indicatorsBase, spread: 0.70 });
    console.log("Custom (0.80 limit): 0.70 spread ->", resCustom080_070);

    // Case 3: Custom limit (0.20) - 0.30 spread should SKIP
    process.env.MAX_SPREAD = "0.20";
    const resCustom020_030 = checkRisk(signal, botState, { ...indicatorsBase, spread: 0.30 });
    console.log("Custom (0.20 limit): 0.30 spread ->", resCustom020_030);

    // Case 4: Zero spread should always PASS (if limit > 0)
    process.env.MAX_SPREAD = "0.50";
    const resZero = checkRisk(signal, botState, { ...indicatorsBase, spread: 0 });
    console.log("Zero spread ->", resZero);

    // Verification
    const success = 
        resDefault050 === 'APPROVED' && 
        resDefault051.startsWith('SKIP') && 
        resCustom080_070 === 'APPROVED' && 
        resCustom020_030.startsWith('SKIP') &&
        resZero === 'APPROVED';

    if (success) {
        console.log("\nALL TESTS PASSED! Configuration is working correctly.");
    } else {
        console.log("\nTEST FAILED! checkRisk logic anomaly.");
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});
