export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // Vercel cron sends GET requests - verify it's from Vercel
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const TWELVE_KEY = process.env.TWELVE_DATA_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const KV_URL = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;

  try {
    // 1. Fetch gold price
    const priceRes = await fetch(
      `https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${TWELVE_KEY}`
    );
    const priceData = await priceRes.json();
    if (!priceData.price) throw new Error('No price from Twelve Data');
    const price = parseFloat(priceData.price);

    // 2. Load current state from KV store
    const stateRes = await fetch(`${KV_URL}/get/trading_state`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const stateData = await stateRes.json();
    let parsed = stateData.result;
if (typeof parsed === 'string') parsed = JSON.parse(parsed);
if (typeof parsed === 'string') parsed = JSON.parse(parsed);
let state = parsed || {
      balance: 10000,
      position: 0,
      avgBuyPrice: 0,
      trades: [],
      priceHistory: [],
      strategy: 'conservative'
    };
if (!state.trades) state.trades = [];
if (!state.priceHistory) state.priceHistory = [];

    // 3. Update price history
    state.priceHistory.push(price);
    if (state.priceHistory.length > 50) state.priceHistory.shift();

    const recent = state.priceHistory.slice(-15);
    const avg = (recent.reduce((a, b) => a + b, 0) / recent.length).toFixed(2);
    const change = recent.length > 1
      ? ((price - recent[0]) / recent[0] * 100).toFixed(3)
      : '0.000';
    const trend = recent.length > 2
      ? (price > recent[recent.length - 2] ? 'rising' : 'falling')
      : 'neutral';

    // 4. Ask Claude to analyze
    const prompt = `You are a professional gold trader AI using a ${state.strategy} strategy on XAU/USD.

Current price: $${price}
15-point moving average: $${avg}
Recent price change: ${change}%
Current trend: ${trend}
Open position: ${state.position.toFixed(2)} oz at avg $${state.avgBuyPrice.toFixed(2)}
Cash available: $${state.balance.toFixed(2)}
Last 3 trades: ${state.trades.slice(-3).map(t => `${t.type} ${t.size}oz @$${t.price}`).join(', ') || 'none'}

Analyze in 2-3 sentences, then end with exactly one of:
DECISION: BUY
DECISION: SELL
DECISION: HOLD`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || '';

    let decision = 'HOLD';
    if (text.includes('DECISION: BUY')) decision = 'BUY';
    else if (text.includes('DECISION: SELL')) decision = 'SELL';

    const reasoning = text.replace(/DECISION:.*$/m, '').trim();
    const time = new Date().toISOString();
    const size = 1;

    // 5. Execute trade
    if (decision === 'BUY' && state.balance >= price * size) {
      state.avgBuyPrice = state.position === 0
        ? price
        : (state.avgBuyPrice * state.position + price * size) / (state.position + size);
      state.position += size;
      state.balance -= price * size;
      state.trades.push({ type: 'BUY', size, price, time, pnl: null, reasoning });
    } else if (decision === 'SELL' && state.position >= size) {
      const pnl = (price - state.avgBuyPrice) * size;
      state.balance += price * size;
      state.position = Math.max(0, state.position - size);
      if (state.position < 0.001) { state.position = 0; state.avgBuyPrice = 0; }
      state.trades.push({ type: 'SELL', size, price, time, pnl, reasoning });
    } else {
      state.trades.push({ type: 'HOLD', size: 0, price, time, pnl: null, reasoning });
    }

    // Keep only last 100 trades
    if (state.trades.length > 100) state.trades = state.trades.slice(-100);

    // 6. Save updated state back to KV
    await fetch(`${KV_URL}/set/trading_state`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(state)
    });

    return res.json({
      success: true,
      price,
      decision,
      reasoning,
      balance: state.balance,
      position: state.position
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
