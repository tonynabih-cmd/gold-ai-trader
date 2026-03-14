export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const KV_URL = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;

  const defaultState = {
    balance: 10000, position: 0, avgBuyPrice: 0,
    trades: [], priceHistory: [], strategy: 'conservative'
  };

  try {
    const stateRes = await fetch(`${KV_URL}/get/trading_state`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const stateData = await stateRes.json();
    if (!stateData.result) return res.json(defaultState);
    let parsed = stateData.result;
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    return res.json(parsed);
  } catch (err) {
    return res.json(defaultState);
  }
}