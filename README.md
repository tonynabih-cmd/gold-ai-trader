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

Add these variables (get your own API keys):

| Name | Value | Notes |
|------|-------|-------|
| `CAPITAL_API_KEY` | your Capital.com API key | Get from Capital.com dashboard |
| `CAPITAL_EMAIL` | your Capital.com email | Email used for login |
| `CAPITAL_PASSWORD` | your Capital.com password | Your trading account password |
| `CAPITAL_ENV` | `demo` or `live` | CRITICAL: Set to 'demo' for testing, 'live' for real money |
| `LIVE_TRADING_MODE` | `CONFIRMED_REAL_MONEY` (if live) | REQUIRED only if CAPITAL_ENV=live. Prevents accidents. |
| `CRON_SECRET` | 32+ random characters | Use strong random string: `openssl rand -hex 16` (generates 32-char string) |
| `KV_REST_API_URL` | your Upstash Redis URL | From Upstash dashboard |
| `KV_REST_API_TOKEN` | your Upstash Redis token | From Upstash dashboard |
| `TELEGRAM_BOT_TOKEN` | your Telegram bot token | Optional, from BotFather on Telegram |
| `TELEGRAM_CHAT_ID` | your Telegram chat ID | Optional, your personal chat ID for alerts |

**⚠️ CRITICAL SECURITY:**
- DO NOT put real secrets in code or README
- NEVER commit .env files to git
- All tokens rotate immediately if exposed
- Use Vercel's encrypted environment variables only

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

## Trading Modes

**IMPORTANT: This bot trades with REAL money or paper account based on CAPITAL_ENV setting**

- **Demo Mode** (`CAPITAL_ENV=demo`): Paper trading on Capital.com simulator
  - Recommended for first 2+ weeks of testing
  - No real money at risk
  - Full market data and real execution flow
  
- **Live Mode** (`CAPITAL_ENV=live`): Real Capital.com account
  - Uses REAL money from your account
  - Only enable after extensive backtesting and paper trading
  - Start with small capital (AED 500-1000) to validate system
