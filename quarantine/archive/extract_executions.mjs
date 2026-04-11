import fs from 'fs';

async function validateExecutions() {
  const content = fs.readFileSync('today_logs.json', 'utf-8');
  const logs = JSON.parse(content);
  const executed = logs.filter(l => l.tradeExecuted);
  console.log(`Executed trades in today_logs.json: ${executed.length}`);
  executed.forEach(l => {
    console.log(`- Time: ${l.time} | Signal: ${l.signalDetected} | Entry: ${l.entryPrice} | SL: ${l.stopLoss} | TP: ${l.takeProfit} | Ref: ${l.dealReference}`);
  });
}

validateExecutions().catch(console.error);
