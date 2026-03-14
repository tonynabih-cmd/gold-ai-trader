export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const KV_URL = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;

  try {
    const stateRes = await fetch(`${KV_URL}/get/trading_state`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const stateData = await stateRes.json();

    if (!stateData.result) {
      return res.json({
        balance: 10000,
        position: 0,
        avgBuyPrice: 0,
        trades: [],
        priceHistory: [],
        strategy: 'conservative'
      });
    }

    return res.json(JSON.parse(stateData.result));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
