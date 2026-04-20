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
        const value = trimmed.slice(eqIndex + 1).trim().replace(/^"(.*)"$/, '$1');
        if (key && (process.env[key] == null || process.env[key] === '')) {
            process.env[key] = value;
        }
    }
}

async function main() {
    loadEnvLocal();
    const redis = new Redis({
        url:   process.env.KV_REST_API_URL,
        token: process.env.KV_REST_API_TOKEN,
    });

    try {
        const raw = await redis.lrange('trade_logs_list', -1000, -1);
        const logs = Array.isArray(raw) ? raw.map(entry => {
            if (typeof entry === 'string') return JSON.parse(entry);
            return entry;
        }) : [];
        fs.writeFileSync('scratch/live_session_logs_v2.json', JSON.stringify(logs, null, 2), 'utf8');
        console.log(`Successfully fetched ${logs.length} logs to scratch/live_session_logs_v2.json`);
    } catch (err) {
        console.error('Error fetching logs:', err.message);
    }
}

main();
