import fs from 'fs';
import path from 'path';

const file = path.resolve('lib/market_data.js');
let content = fs.readFileSync(file, 'utf8');

// 1. Fix fetchCandles
content = content.replace(
`    const time = new Date(p.snapshotTime).getTime();
    if (!Number.isFinite(time)) {
      console.warn(\`Skipping candle with invalid timestamp: \${p.snapshotTime}\`);
      continue;
    }

    candles.push({
      time,
      rawTime: p.snapshotTime,
      open,
      high,
      low,
      close,
    });
  }`,
`    let timeStr = String(p.snapshotTime);
    if (timeStr.includes('T') && !timeStr.endsWith('Z') && !timeStr.match(/[+-]\\d{2}:?\\d{2}$/)) {
      timeStr += 'Z';
    }

    const time = new Date(timeStr).getTime();
    if (!Number.isFinite(time)) {
      console.warn(\`Skipping candle with invalid timestamp: \${p.snapshotTime}\`);
      continue;
    }

    candles.push({
      time,
      rawTime: p.snapshotTime,
      parsedTimeStr: timeStr,
      open,
      high,
      low,
      close,
    });
  }`.replace(/\r?\n/g, '\r\n')
);

// If the previous replace failed because of exact newline mismatches, try a more regex-based approach.
const match1 = /const time = new Date\(p\.snapshotTime\)\.getTime\(\);[\s\S]*?rawTime: p\.snapshotTime,[\s\S]*?close,\s*\}\);\s*\}/;
content = content.replace(match1, 
`    let timeStr = String(p.snapshotTime);
    if (timeStr.includes('T') && !timeStr.endsWith('Z') && !timeStr.match(/[+-]\\d{2}:?\\d{2}$/)) {
      timeStr += 'Z';
    }

    const time = new Date(timeStr).getTime();
    if (!Number.isFinite(time)) {
      console.warn(\`Skipping candle with invalid timestamp: \${p.snapshotTime}\`);
      continue;
    }

    candles.push({
      time,
      rawTime: p.snapshotTime,
      parsedTimeStr: timeStr,
      open,
      high,
      low,
      close,
    });
  }`);

// 2. Remove manual offset shift and add debug logging
const match2 = /\/\/ ── Timezone Alignment \(Conservative Approach\) ────────────────────────[\s\S]*?\/\/ DIAGNOSTIC LOG\s*console\.log\(`\[DATA\] 🕰️ Time Sync: Broker Latest: \${new Date\(latestRawTime\)\.toISOString\(\)} \| System UTC: \${new Date\(\)\.toISOString\(\)} \| Drift: \${driftHours\.toFixed\(2\)}h`\);/;

const replace2 = `    // ── Diagnostic Logs (Task 5) ──────────────────────────────────────────
    // Broker timestamps are now consistently parsed as UTC via Date parsing.
    const latestCandleRaw = candles5m[candles5m.length - 1];
    
    console.log(
      \`[DATA] 🕰️ Time Sync Debug: raw timestamp='\${latestCandleRaw.rawTime}' | \` +
      \`parsed UTC timestamp='\${latestCandleRaw.parsedTimeStr}' | \` +
      \`final used timestamp=\${new Date(latestCandleRaw.time).toISOString()}\`
    );`;

content = content.replace(match2, replace2);

fs.writeFileSync(file, content);
console.log('Done!');
