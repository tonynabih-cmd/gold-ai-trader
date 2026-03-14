# Gold AI Trader

An AI-powered gold (XAU/USD) paper trading bot using Claude AI and Twelve Data live prices.

## Deploy to Vercel (5 minutes)

### 1. Install Vercel CLI
```bash
npm install -g vercel
```

### 2. Deploy
```bash
cd gold-trader
vercel
```
Follow the prompts — choose defaults for everything.

### 3. Add Environment Variables
After deploying, go to your Vercel dashboard:
- Project → Settings → Environment Variables

Add these two variables:

| Name | Value |
|------|-------|
| `TWELVE_DATA_KEY` | `c1a289b065d649929015b868d639099e` |
| `ANTHROPIC_API_KEY` | your Anthropic API key |

### 4. Redeploy
```bash
vercel --prod
```

Your bot is now live at `https://your-project.vercel.app`

---

## Project Structure
```
gold-trader/
├── api/
│   ├── price.js      ← fetches XAU/USD from Twelve Data
│   └── analyze.js    ← proxies Claude AI requests
├── public/
│   └── index.html    ← full trading dashboard UI
├── vercel.json       ← routing config
└── package.json
```

## Features
- Live XAU/USD gold prices via Twelve Data
- Claude AI makes BUY/SELL/HOLD decisions automatically
- 4 trading strategies: Conservative, Aggressive, Scalping, Trend Following
- Real-time price chart
- Trade log with P&L tracking
- Session stats (win rate, best/worst trade)
- Paper trading — no real money involved
