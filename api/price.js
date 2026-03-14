export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const TWELVE_KEY = process.env.TWELVE_DATA_KEY;

  try {
    const response = await fetch(
      `https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${TWELVE_KEY}`
    );
    const data = await response.json();

    if (data.price) {
      return res.json({ price: parseFloat(data.price), source: 'live' });
    }

    throw new Error(data.message || 'No price returned');
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
