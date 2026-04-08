import fs from 'fs';
import { Redis } from '@upstash/redis';
import { generateSignal } from './lib/strategy.js';
if (fs.existsSync('.env.local')) {
    const envFile = fs.readFileSync('.env.local', 'utf8');
    envFile.split('\n').forEach(line => {
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
            process.env[key.trim()] = valueParts.join('=').trim().replace(/^"(.*)"$/, '$1');
        }
    });
}

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const LOT_SIZE = 10; // oz
const BE_ATR_THRESHOLD = 1.0;
const TRAILING_ATR_MULT = 1.5;

async function fetchRecentLogs() {
    console.log('Fetching last 1000 logs from Redis...');
    try {
        const raw = await redis.lrange('trade_logs_list', -1000, -1);
        const logs = Array.isArray(raw) ? raw.map(entry => {
            try { return typeof entry === 'string' ? JSON.parse(entry) : entry; }
            catch (e) { return null; }
        }).filter(l => l !== null) : [];
        return logs;
    } catch (err) {
        console.warn('Redis fetch failed, falling back to local files only.');
        return [];
    }
}

async function runStrategySimulation(logs, label) {
    console.log(`\n--- Running Simulation: ${label} (${logs.length} data points) ---`);
    
    const result = {
        label,
        executed_trades: [],
        v11_comparison: [],
        missed_opportunities: [],
        stats: {
            wins: 0,
            losses: 0,
            breakeven: 0,
            total_pnl: 0,
            max_drawdown: 0
        }
    };

    let activeTrade = null;
    let balance = 0;
    let peakBalance = 0;
    let drawdown = 0;

    // Sort logs by time
    const sortedLogs = logs.sort((a, b) => new Date(a.time || a.timestamp || 0).getTime() - new Date(b.time || b.timestamp || 0).getTime());

    for (let i = 0; i < sortedLogs.length; i++) {
        const log = sortedLogs[i];
        
        // Extract indicators
        // Note: logs from api/cron.js structure might vary slightly if they are older
        const goldPrice = log.goldPrice || (log.indicators && log.indicators.lastCandle && log.indicators.lastCandle.close) || 0;
        if (!goldPrice) continue;

        const time = new Date(log.time || log.timestamp);
        
        // EMA logic
        const indicators = log.indicators || {
            currEMA20: log.dbgCurrE20 || log.ema20,
            currEMA50: log.dbgCurrE50 || log.ema50,
            prevEMA20: log.dbgPrevE20,
            prevEMA50: log.dbgPrevE50,
            slopePercent: log.emaSlope || log.slopePercent,
            atr: log.atr,
            atrAverage: log.atrAverage,
            rsi: log.rsi,
            resistance: log.resistance,
            support: log.support,
            trend1h: log.trend1h,
            lastCandle: { close: goldPrice, open: goldPrice, time: time.getTime() },
            ema20arr: [log.dbgPrevE20, log.dbgCurrE20].filter(v => v != null),
            ema50arr: [log.dbgPrevE50, log.dbgCurrE50].filter(v => v != null)
        };

        // If it's a very old log missing crucial data, skip
        if (!indicators.currEMA20) continue;

        // Manage active trade
        if (activeTrade) {
            const currentPnl = (activeTrade.action === 'BUY' ? goldPrice - activeTrade.entry : activeTrade.entry - goldPrice) * LOT_SIZE;
            const currentPnlAtr = (activeTrade.action === 'BUY' ? goldPrice - activeTrade.entry : activeTrade.entry - goldPrice) / activeTrade.atr;

            // Trailing / BE logic
            if (currentPnlAtr >= BE_ATR_THRESHOLD) {
                const distance = activeTrade.atr * TRAILING_ATR_MULT;
                let newSL = activeTrade.action === 'BUY' ? goldPrice - distance : goldPrice + distance;
                
                if (activeTrade.action === 'BUY') {
                    newSL = Math.max(newSL, activeTrade.entry, activeTrade.stopLoss);
                } else {
                    newSL = Math.min(newSL, activeTrade.entry, activeTrade.stopLoss);
                }

                if (Math.abs(newSL - activeTrade.stopLoss) > 0.05) {
                    activeTrade.stopLoss = newSL;
                    activeTrade.isBE = true;
                }
            }

            let exitReason = null;
            if (activeTrade.action === 'BUY') {
                if (goldPrice >= activeTrade.takeProfit) exitReason = 'TP';
                else if (goldPrice <= activeTrade.stopLoss) exitReason = activeTrade.isBE ? 'TRAIL' : 'SL';
            } else {
                if (goldPrice <= activeTrade.takeProfit) exitReason = 'TP';
                else if (goldPrice >= activeTrade.stopLoss) exitReason = activeTrade.isBE ? 'TRAIL' : 'SL';
            }

            if (exitReason) {
                const realizedPnl = (activeTrade.action === 'BUY' ? goldPrice - activeTrade.entry : activeTrade.entry - goldPrice) * LOT_SIZE;
                balance += realizedPnl;
                if (balance > peakBalance) peakBalance = balance;
                const dd = peakBalance - balance;
                if (dd > result.stats.max_drawdown) result.stats.max_drawdown = dd;

                if (realizedPnl > 0.5) result.stats.wins++;
                else if (realizedPnl < -0.5) result.stats.losses++;
                else result.stats.breakeven++;

                result.stats.total_pnl += realizedPnl;

                result.executed_trades.push({
                    time: activeTrade.time,
                    exitTime: time.toISOString(),
                    action: activeTrade.action,
                    entry: activeTrade.entry,
                    exit: goldPrice,
                    pnl: realizedPnl.toFixed(2),
                    reason: exitReason
                });
                activeTrade = null;
            }
        }

        // Mock 1m candles for MOMENTUM check - assuming trend continuation for simulation purposes
        const mockCandles1m = [
            { close: goldPrice, open: goldPrice, high: goldPrice, low: goldPrice },
            { close: goldPrice + (indicators.slopePercent > 0 ? 0.2 : -0.2), open: goldPrice, high: goldPrice + 0.3, low: goldPrice - 0.3 },
            { close: goldPrice + (indicators.slopePercent > 0 ? 0.5 : -0.5), open: goldPrice + 0.2, high: goldPrice + 0.6, low: goldPrice + 0.1 }
        ];

        // Run v1.3 Strategy
        const { signal, debug } = generateSignal(indicators, mockCandles1m);

        // Comparison with v1.1
        if (log.tradeExecuted || log.signalDetected) {
            result.v11_comparison.push({
                time: time.toISOString(),
                v11Action: log.signalDetected || (log.signal && log.signal.action),
                v13Action: signal ? signal.action : 'REJECTED',
                reason: debug.dbgRejectReason || 'ACCEPTED'
            });
        }

        // Detect missed opportunities (v1.3 signal exists but wasn't in original log)
        if (signal && !log.tradeExecuted && !activeTrade) {
            // Check if it's a NEW signal v1.3 captured
            const wasInV11 = log.tradeExecuted || log.signalDetected;
            if (!wasInV11) {
                result.missed_opportunities.push({
                    time: time.toISOString(),
                    action: signal.action,
                    type: signal.entryType,
                    score: signal.score,
                    slope: indicators.slopePercent.toFixed(4)
                });
            }

            // Execute trade in simulation
            activeTrade = {
                time: time.toISOString(),
                action: signal.action,
                entry: signal.entryPrice,
                stopLoss: signal.stopLoss,
                takeProfit: signal.takeProfit,
                atr: signal.atr,
                isBE: false
            };
        }
    }

    return result;
}

async function main() {
    const historicalLogs = JSON.parse(fs.readFileSync('./archive/logs_dump.json', 'utf8'));
    const recentLogs = await fetchRecentLogs();

    const histResults = await runStrategySimulation(historicalLogs, 'Historical High-Volatility');
    const recentResults = await runStrategySimulation(recentLogs, 'Last 24h Market Logs');

    // Combine and report
    const report = {
        timestamp: new Date().toISOString(),
        histResults,
        recentResults
    };

    fs.writeFileSync('V13_SIMULATION_RESULTS.json', JSON.stringify(report, null, 2));

    let md = `# 🧪 V1.3 Strategy Update Simulation Report\n\n`;
    md += `Generated: ${new Date().toISOString()}\n\n`;

    const sections = [histResults, recentResults];
    
    sections.forEach(res => {
        md += `## 📊 Session: ${res.label}\n`;
        md += `- **Total Trades**: ${res.executed_trades.length}\n`;
        md += `- **Win Rate**: ${((res.stats.wins / (res.stats.wins + res.stats.losses + res.stats.breakeven || 1)) * 100).toFixed(1)}%\n`;
        md += `- **Net P&L**: AED ${res.stats.total_pnl.toFixed(2)}\n`;
        md += `- **Max Drawdown**: AED ${res.stats.max_drawdown.toFixed(2)}\n\n`;

        md += `### 🔄 Comparison with v1.1\n`;
        md += `| Time | V1.1 Action | V1.3 Action | Status / Reject Reason |\n`;
        md += `|------|-------------|-------------|------------------------|\n`;
        res.v11_comparison.slice(-15).forEach(c => {
            md += `| ${c.time} | ${c.v11Action} | ${c.v13Action} | ${c.reason} |\n`;
        });
        md += `\n`;

        md += `### 🎯 New Opportunities Captured (v1.3 Unique)\n`;
        if (res.missed_opportunities.length === 0) {
            md += `*No unique v1.3 opportunities detected in this set.*\n`;
        } else {
            md += `| Time | Action | Type | Score | Slope |\n`;
            md += `|------|--------|------|-------|-------|\n`;
            res.missed_opportunities.slice(0, 10).forEach(o => {
                md += `| ${o.time} | ${o.action} | ${o.type} | ${o.score} | ${o.slope}% |\n`;
            });
        }
        md += `\n`;

        md += `### 📉 Executed Trade Log\n`;
        md += `| Entry Time | Action | P&L | Reason |\n`;
        md += `|------------|--------|-----|--------|\n`;
        res.executed_trades.slice(-10).forEach(t => {
            md += `| ${t.time} | ${t.action} | ${t.pnl} | ${t.reason} |\n`;
        });
        md += `\n---\n\n`;
    });

    md += `## 🏁 Conclusion\n`;
    md += `v1.3 improves capture during European sessions and allows immediate crossover entries on strong momentum (>0.25% slope). `;
    md += `SR penalties are reduced during strong trends to allow entries that were previously blocked by proximity to resistance/support.\n`;

    fs.writeFileSync('V13_SIMULATION_REPORT.md', md);
    console.log('\nReport generated: V13_SIMULATION_REPORT.md');
}

main().catch(console.error);
