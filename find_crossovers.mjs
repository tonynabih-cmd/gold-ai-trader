import fs from 'fs';
const logs = JSON.parse(fs.readFileSync('today_logs.json', 'utf-8'));
const crossovers = logs.filter(l => l.dbgBuyCrossover === true || l.dbgSellCrossover === true);
crossovers.forEach(l => {
    console.log(`[${l.timeUAE}] ${l.dbgBuyCrossover ? 'BUY' : 'SELL'} Crossover | Price: ${l.goldPrice} | Reason: ${l.reason}`);
});
if (crossovers.length === 0) console.log("No crossovers detected today.");
