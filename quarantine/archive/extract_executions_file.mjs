import fs from 'fs';

async function validateExecutions() {
  const content = fs.readFileSync('logs_dump.json', 'utf-8');
  const logs = JSON.parse(content);
  const executed = logs.filter(l => l.tradeExecuted);
  let output = `Executed trades in logs_dump.json: ${executed.length}\n`;
  executed.forEach(l => {
    output += `- Time: ${l.time} | Signal: ${l.signalDetected} | Entry: ${l.entryPrice} | SL: ${l.stopLoss} | TP: ${l.takeProfit} | Ref: ${l.dealReference}\n`;
  });
  fs.writeFileSync('execution_extract.txt', output);
  console.log('Results saved to execution_extract.txt');
}

validateExecutions().catch(console.error);
