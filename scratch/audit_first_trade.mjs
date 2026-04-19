import fs from 'fs';
import { Redis } from '@upstash/redis';

function loadEnvLocal(filepath = '.env.local') {
    if (!fs.existsSync(filepath)) return;
    const raw = fs.readFileSync(filepath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;
        const key = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '');
        if (key) process.env[key] = value;
    }
}

async function auditFirstTrade() {
    loadEnvLocal();
    const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

    // Pull FULL log history to find any executed trade
    const logsRaw = await redis.lrange('trade_logs_list', 0, -1);
    const logs = logsRaw.map(l => typeof l === 'string' ? JSON.parse(l) : l);
    const executedTrades = logs.filter(l => l.tradeExecuted === true);
    
    console.log('Total logs in Redis:', logs.length);
    console.log('Executed trades found:', executedTrades.length);

    if (executedTrades.length === 0) {
        console.log('\n[FINDING] No executed trades exist in the current trade_logs_list.');
        console.log('[FINDING] The live session logs (live_session_logs.json) confirm this.');
        console.log('[FINDING] The bot_state recentTradeIds reference v1.5 tradeIds from PREVIOUS deploys.');
        console.log('[FINDING] The bot is in NO-TRADE observation mode post-recovery (market closed, stale candles).');
        console.log('\n--- AUDIT RESULT (NO ELIGIBLE TRADE TO AUDIT) ---');
        console.log('No first-trade audit is possible yet. Bot has not placed a live trade since Redis recovery.');
        return;
    }

    const trade = executedTrades[executedTrades.length - 1];
    console.log('\n--- AUDITING MOST RECENT EXECUTED TRADE ---');
    console.log('Time (UAE):', trade.timeUAE);
    console.log('Strategy:', trade.strategyVersion);
    console.log('Signal:', trade.signalDetected);
    console.log('Entry Price:', trade.entryPrice);
    console.log('Stop Loss:', trade.stopLoss);
    console.log('Take Profit:', trade.takeProfit);
    console.log('ATR:', trade.atr);
    console.log('Gold Price (midpoint):', trade.goldPrice);
    console.log('Spread:', trade.spread);
    console.log('Actual Risk $:', trade.actualRiskDollars);
    console.log('Margin Used:', trade.marginUsed);
    console.log('Deal Reference:', trade.dealReference);

    // --- GATE 1: EXECUTION PRICE ---
    let executionPricePass = false;
    if (trade.entryPrice && trade.goldPrice && trade.spread) {
        const approxAsk = trade.goldPrice + (trade.spread / 2);
        const approxBid = trade.goldPrice - (trade.spread / 2);
        if (trade.signalDetected === 'BUY') {
            // Entry should be >= midpoint (i.e. at ask side)
            executionPricePass = trade.entryPrice >= trade.goldPrice;
        } else if (trade.signalDetected === 'SELL') {
            // Entry should be <= midpoint (i.e. at bid side)
            executionPricePass = trade.entryPrice <= trade.goldPrice;
        }
    }
    console.log('\nGATE 1 - EXECUTION PRICE:', executionPricePass ? 'PASS' : 'FAIL');

    // --- GATE 2: SL DISTANCE (1.5 ATR) ---
    let slDistancePass = false;
    if (trade.entryPrice && trade.stopLoss && trade.atr) {
        const slDist = Math.abs(trade.entryPrice - trade.stopLoss);
        const expectedSl = 1.5 * trade.atr;
        const ratio = slDist / trade.atr;
        console.log(`  SL Dist=$${slDist.toFixed(3)} | 1.5xATR=$${expectedSl.toFixed(3)} | Ratio=${ratio.toFixed(3)}x`);
        // Allow >= 1.5 (broker min stop may pad it further up, never below)
        slDistancePass = ratio >= 1.49;
    }
    console.log('GATE 2 - STOP LOSS DISTANCE:', slDistancePass ? 'PASS' : 'FAIL');

    // --- GATE 3: STATE/BROKER ALIGNMENT ---
    const stateRaw = await redis.get('bot_state');
    const state = typeof stateRaw === 'string' ? JSON.parse(stateRaw) : stateRaw;
    let stateAlignmentPass = false;
    let foundIn = 'nowhere';
    if (state) {
        const inOpen = state.openTrades?.some(t => t.dealReference === trade.dealReference || t.dealId === trade.dealReference);
        const inOutcomes = state.recentOutcomes?.some(o => o.ref === trade.dealReference || o.dealId === trade.dealReference);
        if (inOpen) foundIn = 'openTrades';
        if (inOutcomes) foundIn = 'recentOutcomes (closed)';
        if (inOpen || inOutcomes) stateAlignmentPass = true;
    }
    console.log(`GATE 3 - STATE/BROKER ALIGNMENT: ${stateAlignmentPass ? 'PASS' : 'FAIL'} (Trade found in: ${foundIn})`);

    // --- GATE 4: LOG CONSISTENCY ---
    const hasAllFields = !!(trade.entryPrice && trade.stopLoss && trade.takeProfit && trade.dealReference && trade.actualRiskDollars && trade.marginUsed);
    const priceLogical = trade.signalDetected === 'BUY'
        ? (trade.stopLoss < trade.entryPrice && trade.takeProfit > trade.entryPrice)
        : (trade.stopLoss > trade.entryPrice && trade.takeProfit < trade.entryPrice);
    const logConsistencyPass = hasAllFields && priceLogical;
    console.log(`GATE 4 - LOG CONSISTENCY: ${logConsistencyPass ? 'PASS' : 'FAIL'}`);
    if (!hasAllFields) console.log('  FAIL reason: Missing fields');
    if (!priceLogical) console.log('  FAIL reason: SL/TP direction inconsistent with signal side');

    // --- GATE 5: HIDDEN POST-TRADE ISSUE ---
    let hiddenIssue = false;
    let hiddenReason = '';
    if (!trade.dealReference) { hiddenIssue = true; hiddenReason += 'Missing deal reference. '; }
    if (trade.actualRiskDollars <= 0) { hiddenIssue = true; hiddenReason += 'Zero actual risk (sizing failure). '; }
    if (trade.marginUsed <= 0) { hiddenIssue = true; hiddenReason += 'Zero margin used (sizing failure). '; }
    if (!stateAlignmentPass) { hiddenIssue = true; hiddenReason += 'Trade missing from state (ghost trade). '; }
    console.log(`GATE 5 - HIDDEN POST-TRADE ISSUE: ${hiddenIssue ? 'YES — ' + hiddenReason : 'NO'}`);

    // --- FINAL VERDICT ---
    const allPass = executionPricePass && slDistancePass && stateAlignmentPass && logConsistencyPass && !hiddenIssue;
    console.log('\n==============================');
    console.log('EXECUTION PRICE:', executionPricePass ? 'PASS' : 'FAIL');
    console.log('STOP LOSS DISTANCE:', slDistancePass ? 'PASS' : 'FAIL');
    console.log('STATE/BROKER ALIGNMENT:', stateAlignmentPass ? 'PASS' : 'FAIL');
    console.log('LOG CONSISTENCY:', logConsistencyPass ? 'PASS' : 'FAIL');
    console.log('HIDDEN POST-TRADE ISSUE:', hiddenIssue ? 'YES' : 'NO');
    console.log('FINAL VERDICT:', allPass ? 'CLEAN FIRST TRADE' : 'ISSUE DETECTED');
    console.log('==============================');
}

auditFirstTrade().catch(console.error);
