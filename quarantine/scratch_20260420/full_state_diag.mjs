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

async function fullDiag() {
    loadEnvLocal();
    const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

    // Pull state
    const stateRaw = await redis.get('bot_state');
    const state = typeof stateRaw === 'string' ? JSON.parse(stateRaw) : stateRaw;

    // Pull FULL log history
    const logsRaw = await redis.lrange('trade_logs_list', 0, -1);
    const logs = logsRaw.map(l => typeof l === 'string' ? JSON.parse(l) : l);

    // --- Market open context ---
    // Current UTC time
    const nowUtc = new Date();
    const nowUae = new Date(nowUtc.getTime() + 4 * 60 * 60 * 1000);
    console.log('=== AUDIT CONTEXT ===');
    console.log('Current UAE Time:', nowUae.toISOString().replace('T', ' ').slice(0, 19));
    console.log('Day of week (0=Sun,1=Mon):', nowUae.getUTCDay());

    // --- Log telemetry ---
    console.log('\n=== LOG TELEMETRY ===');
    console.log('Total logs in Redis:', logs.length);
    const executedTrades = logs.filter(l => l.tradeExecuted === true);
    console.log('Executed trades in log:', executedTrades.length);

    const lastLog = logs[logs.length - 1];
    console.log('Most recent log time (UAE):', lastLog?.timeUAE);
    console.log('Most recent log reason:', lastLog?.reason);

    // --- Skip reason breakdown for last 20 logs ---
    console.log('\n=== LAST 20 CYCLE SKIP REASONS ===');
    logs.slice(-20).forEach(l => {
        console.log(`[${l.timeUAE}] ${l.reason}`);
    });

    // --- State telemetry ---
    console.log('\n=== BOT STATE TELEMETRY ===');
    console.log('botEnabled:', state?.botEnabled);
    console.log('stateIntegrityOk:', state?.stateIntegrityOk);
    console.log('criticalFailure:', state?.criticalFailure);
    console.log('criticalFailureReason:', state?.criticalFailureReason || '(none)');
    console.log('performanceReviewNeeded:', state?.performanceReviewNeeded);
    console.log('performanceReviewReason:', state?.performanceReviewReason || '(none)');
    console.log('openTrades:', state?.openTrades?.length ?? 0);
    console.log('lastProcessedCandle:', state?.lastProcessedCandle);
    console.log('lastProcessedCandleUTC:', state?.lastProcessedCandle ? new Date(state.lastProcessedCandle).toISOString() : 'N/A');
    console.log('balance:', state?.balance);
    console.log('dailyTrades:', state?.dailyTrades);
    console.log('dailyLoss:', state?.dailyLoss);
    console.log('rollingWinRate10:', state?.rollingWinRate10);
    console.log('rollingProfitFactor15:', state?.rollingProfitFactor15);
    console.log('riskDataFresh:', state?.riskDataFresh);
    console.log('stateVersion:', state?.stateVersion);
    console.log('stateUpdatedAt:', state?.stateUpdatedAt ? new Date(state.stateUpdatedAt).toISOString() : 'N/A');
}

fullDiag().catch(console.error);
