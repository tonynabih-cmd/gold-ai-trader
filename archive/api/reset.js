// api/reset.js — Clears all bot state from Upstash KV.
// USE WITH CAUTION: this wipes openTrades, dailyTrades, balance history, everything.
// Only use when you want a completely fresh start (e.g. after a bug fix before demo trading).
// Does NOT clear trade_logs — historical logs are preserved.

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  const providedAuth = req.headers['authorization'] || req.headers['Authorization'];
  if (process.env.CRON_SECRET && providedAuth !== expectedAuth) {
    console.warn('Unauthorized reset trigger attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Require explicit confirmation to prevent accidental reset
    const { confirm } = req.query;
    if (confirm !== 'yes') {
      return res.status(400).json({
        error: 'Safety check: add ?confirm=yes to the URL to confirm reset',
        warning: 'This will clear ALL bot state including openTrades and balance history',
      });
    }

    await redis.del('bot_state');

    console.log('Bot state reset by /api/reset');

    return res.json({
      success: true,
      message: 'Bot state cleared. Bot will start fresh on next cron trigger.',
      note:    'Trade logs (trade_logs key) were preserved.',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
