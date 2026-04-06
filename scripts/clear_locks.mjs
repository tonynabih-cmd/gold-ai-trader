/**
 * clear_locks.mjs — Clear stuck Redis candle locks.
 *
 * Run this script whenever the bot is stuck with:
 *   "SKIP: Concurrency lock active for candle <timestamp>"
 *
 * Usage (from repo root):
 *   KV_REST_API_URL=<url> KV_REST_API_TOKEN=<token> node scripts/clear_locks.mjs
 *
 * Or create a .env.local file in the repo root (see .env.example) and run:
 *   node scripts/clear_locks.mjs
 *
 * Candle lock keys have a 120-second TTL and normally self-expire. This script
 * is useful when you need to unblock the bot immediately without waiting.
 */

import { Redis } from '@upstash/redis';
import fs from 'fs';

// ── Load .env.local if present ────────────────────────────────────────────────
try {
  const envContent = fs.readFileSync('.env.local', 'utf-8');
  envContent.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const [k, ...vParts] = trimmed.split('=');
    const v = vParts.join('=').trim().replace(/^['"]|['"]$/g, '');
    if (k && !process.env[k]) process.env[k] = v;
  });
} catch (_) {
  // .env.local is optional — silently skip if missing
}

// ── Validate credentials ──────────────────────────────────────────────────────
if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
  console.error('❌ Missing credentials: KV_REST_API_URL and KV_REST_API_TOKEN must be set.');
  console.error('   Set them in .env.local or pass as environment variables before running this script.');
  process.exit(1);
}

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  // ── 1. Verify connectivity ────────────────────────────────────────────────
  try {
    await redis.ping();
    console.log('✅ Redis connection OK');
  } catch (err) {
    console.error('❌ Cannot reach Redis:', err.message);
    console.error('   Check that KV_REST_API_URL and KV_REST_API_TOKEN are correct.');
    process.exit(1);
  }

  // ── 2. Scan for candle lock keys ──────────────────────────────────────────
  // Upstash REST API supports SCAN via the redis.scan() method.
  // Lock key pattern: lock:candle:<candleTimestamp>
  console.log('\nScanning for stuck candle lock keys (pattern: lock:candle:*)...');

  let cursor = 0;
  const lockKeys = [];

  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: 'lock:candle:*', count: 100 });
    cursor = Number(nextCursor);
    lockKeys.push(...keys);
  } while (cursor !== 0);

  if (lockKeys.length === 0) {
    console.log('✅ No stuck candle locks found. Bot should be unblocked already.');
    return;
  }

  console.log(`\nFound ${lockKeys.length} candle lock key(s):`);
  for (const key of lockKeys) {
    const value = await redis.get(key);
    const ttl   = await redis.ttl(key);
    console.log(`  ${key}  →  owner=${value}  TTL=${ttl}s`);
  }

  // ── 3. Delete all found lock keys ─────────────────────────────────────────
  console.log(`\nDeleting ${lockKeys.length} lock key(s)...`);
  for (const key of lockKeys) {
    const deleted = await redis.del(key);
    if (deleted) {
      console.log(`  ✅ Deleted: ${key}`);
    } else {
      console.warn(`  ⚠️  Already gone (expired): ${key}`);
    }
  }

  console.log('\n✅ All stuck locks cleared. The next cron invocation will process normally.');
  console.log('   If the bot was also blocked by anti-chop or daily limits, run:');
  console.log('   node reset_state.mjs');
}

main().catch(err => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
