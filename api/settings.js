export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const KV_URL = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;

  try {
    const { strategy } = req.body;

    const stateRes = await fetch(`${KV_URL}/get/trading_state`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const stateData = await stateRes.json();
    let state = stateData.result ? JSON.parse(stateData.result) : {
      balance: 10000, position: 0, avgBuyPrice: 0,
      trades: [], priceHistory: [], strategy: 'conservative'
    };

    state.strategy = strategy;

    await fetch(`${KV_URL}/set/trading_state`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });

    return res.json({ success: true, strategy });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
