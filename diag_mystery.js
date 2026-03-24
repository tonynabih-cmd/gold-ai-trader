import { checkRisk } from './lib/risk.js';

process.env.BOT_ENABLED = 'true';


// Mock data from logs_dump.json line 55 (Trade executed at 12:10 PM UAE)
const signal = {
    id: "1774339806356_BUY_v1.1",
    action: "BUY",
    entryPrice: 4412.51,
    stopLoss: 4393.67318952846,
    takeProfit: 4437.625747295388,
    score: 6
};

const botState = {
    botEnabled: true,
    dailyTrades: 0,
    dailyLoss: 0,
    balance: 4362.02,
    totalDrawdown: 0,
    openTrades: [],
    lastOrderTimestamp: 0,
    availableMargin: 2000 // guessed, not in log entry but shouldn't matter for Rule 11
};

const indicators = {
    spread: 0.5,
    atr: 12.557873647693514,
    atrAverage: 16.247842857142825,
    lastCandle: { close: 4412.51 }
};

console.log("Testing Rule 11 with spread 0.5 and limit 0.40...");
const result = checkRisk(signal, botState, indicators);

console.log("Result:", result);

if (result === 'APPROVED') {
    console.log("BUG REPRODUCED! checkRisk returned APPROVED despite spread > 0.40");
} else {
    console.log("Result was:", result);
    console.log("If this says SKIP, then why did the real bot execute? Perhaps indicators.spread was not 0.5 during the actual check?");
}
