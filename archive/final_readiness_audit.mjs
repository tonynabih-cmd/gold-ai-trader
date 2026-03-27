import fs from 'fs';

// Simple .env.local loader (POPULATE FIRST)
try {
  const envContent = fs.readFileSync('.env.local', 'utf-8');
  envContent.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const [k, ...vParts] = trimmed.split('=');
    const v = vParts.join('=').trim().replace(/^['"]|['"]$/g, '');
    process.env[k] = v;
  });
} catch (e) {}

// Dynamic import
const { getCapitalSession } = await import('../lib/session.js');
const { getMarketData }     = await import('../lib/market_data.js');
const { loadState }         = await import('../lib/state.js');
const { checkRisk }         = await import('../lib/risk.js');

async function verifyBotReadiness() {
  console.log('\n--- FINAL READINESS AUDIT ---');
  try {
    const session = await getCapitalSession();
    const state = await loadState();
    const md = await getMarketData(session, state);
    
    const indicators = {
       spread: md.spread,
       atr: 5,
       atrAverage: 5,
       lastCandle: { close: 2400 }
    };

    const dummySignal = {
        action: 'BUY',
        entryPrice: 2400,
        stopLoss: 2390,
        takeProfit: 2420,
        score: 5,
        id: "TEST_ID_1"
    }

    const riskResult = checkRisk(dummySignal, state, indicators);
    
    console.log(`- Base Balance: AED ${state.balance}`);
    console.log(`- Current Spread: ${md.spread}`);
    console.log(`- Max Spread Limit: ${process.env.MAX_SPREAD || '0.40'}`);
    console.log(`- Minimum Balance Floor: AED 80`);
    console.log(`\n- Risk Check Result (Dummy Signal): ${riskResult}`);

  } catch (err) {
    console.error('Audit Error:', err.message);
  }
  console.log('-----------------------------\n');
}

verifyBotReadiness().catch(console.error);
