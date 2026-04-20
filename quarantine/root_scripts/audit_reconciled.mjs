import fs from 'fs';
import { Redis } from '@upstash/redis';
import { getCapitalSession } from './lib/session.js';
import { fetchWithTimeout } from './lib/fetch.js';

// Load .env.local for local runs
try {
  const env = fs.readFileSync('.env.local', 'utf-8');
  env.split('\n').forEach(line => {
    if (line.trim() && !line.startsWith('#')) {
      const idx = line.indexOf('=');
      if (idx !== -1) {
        const k = line.substring(0, idx).trim();
        const v = line.substring(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (k) process.env[k] = v;
      }
    }
  });
} catch (e) {}

const KV_URL = process.env.KV_REST_API_URL || 'https://well-hawk-71664.upstash.io';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || 'gQAAAAAAARfwAAIncDE5Y2Y4MTg0MWZlN2E0ZTMxYjdkYjZlZGNlODgyNTJiZXAxNzE2NjQ';

const redis = new Redis({ url: KV_URL, token: KV_TOKEN });

async function runAudit() {
  console.log('🚀 Starting Reconciled Performance Audit v2.0...');
  
  try {
    const session = await getCapitalSession().catch(e => {
        console.error('FAILED TO CONNECT TO CAPITAL.COM:', e.message);
        process.exit(1);
    });
    const { baseUrl, cst, securityToken } = session;

    // 1. Fetch Broker Transactions (Last 30 Days)
    console.log('📡 Fetching broker transaction history (PRIMARY SOURCE)...');
    const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('.')[0];
    const url = `${baseUrl}/api/v1/history/transactions?from=${from}`;
    const hRes = await fetchWithTimeout(url, {
      headers: { 'X-CAP-API-KEY': process.env.CAPITAL_API_KEY, 'CST': cst, 'X-SECURITY-TOKEN': securityToken },
    });
    
    if (!hRes.ok) throw new Error(`Broker API failed: ${hRes.status}`);
    const hData = await hRes.json();
    const allTx = hData.transactions || [];
    
    // Group all gold transactions and fees
    const goldTx = allTx.filter(t => (t.instrumentName?.includes('GOLD')) || (t.transactionType === 'SWAP') || (t.transactionType === 'REBATE' && t.note?.includes('SPREAD')));

    // 2. Load Bot Data
    console.log('📦 Loading bot telemetry (SECONDARY SOURCE)...');
    const botState = await redis.get('bot_state') || {};
    const recentOutcomes = botState.recentOutcomes || [];
    
    // Fetch logs to check for "Silent Activity" (Activity in logs but 0 P&L)
    const rawLogs = await redis.lrange('trade_logs_list', 0, 100).catch(() => []);
    const logs = rawLogs.map(l => typeof l === 'string' ? JSON.parse(l) : l);
    const activeCyclesInLogs = logs.filter(l => l.signalDetected !== 'NONE').length;

    // 3. Process Trades from Broker (Source of Truth)
    console.log('📊 Reconstructing trade history from ledger...');
    const reconstructedTrades = [];
    const summary = {
      totalNetPnl: 0,
      totalFees: 0,
      tradesCount: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      mismatches: 0,
      reconciledCount: 0,
      unreconciledCount: 0,
      status: 'VALID'
    };

    // Group related transactions by dealId
    const dealGroups = {};
    goldTx.forEach(t => {
      // Primary grouping for trades
      if (t.transactionType === 'TRADE' && t.note?.includes('closed')) {
        const id = t.dealId || t.reference;
        if (!dealGroups[id]) dealGroups[id] = [];
        dealGroups[id].push(t);
      } else if (t.transactionType === 'SWAP') {
        summary.totalFees += Math.abs(parseFloat(t.size || t.profitAndLoss || 0));
      } else if (t.transactionType === 'REBATE') {
        // Rebates (spread back) are added to total P&L
        summary.totalNetPnl += parseFloat(t.size || t.profitAndLoss || 0);
      }
    });

    for (const [dealId, txs] of Object.entries(dealGroups)) {
      const closingTx = txs[0];
      const brokerPnl = parseFloat(closingTx.profitAndLoss ?? closingTx.size ?? 0);
      
      // Attempt to match with bot outcome
      const outcome = recentOutcomes.find(o => o.dealId === dealId || o.ref === dealId);
      const botPnl = outcome ? parseFloat(outcome.pnl || 0) : null;
      
      const trade = {
        dealId,
        date: closingTx.date,
        brokerPnl,
        botPnl,
        diff: botPnl !== null ? Math.abs(brokerPnl - botPnl) : null,
        entryType: outcome?.entryType || 'UNKNOWN',
        action: outcome?.action || (parseFloat(closingTx.size) > 0 ? 'SELL_CLOSE' : 'BUY_CLOSE'),
        status: outcome ? 'RECONCILED' : 'UNRECONCILED'
      };

      // Flag huge mismatches
      if (trade.diff !== null && trade.diff > 0.05) { 
        trade.flag = '⚠️ MISMATCH';
        summary.mismatches++;
      } else if (trade.status === 'RECONCILED') {
        trade.flag = '✅ OK';
        summary.reconciledCount++;
      } else {
        trade.flag = '❓ BROKER_ONLY';
        summary.unreconciledCount++;
      }

      reconstructedTrades.push(trade);
      summary.totalNetPnl += brokerPnl;
      summary.tradesCount++;
      if (brokerPnl > 0.001) summary.wins++;
      else if (brokerPnl < -0.001) summary.losses++;
    }

    summary.winRate = summary.tradesCount > 0 ? (summary.wins / summary.tradesCount) * 100 : 0;
    summary.totalNetPnl -= summary.totalFees;

    // 4. INVALIDITY CHECK (User requirement: Step 4)
    if (summary.tradesCount === 0 && activeCyclesInLogs > 0) {
        summary.status = 'INVALID_AUDIT (Logs show activity but broker has no trades)';
        console.warn('🚨 AUDIT INVALIDITY ALERT: Logs show activity but broker records are empty for this window.');
    }

    // 5. Generate Report
    const report = {
      timestamp: new Date().toISOString(),
      summary,
      trades: reconstructedTrades.sort((a,b) => new Date(b.date) - new Date(a.date))
    };

    fs.writeFileSync('AUDIT_PERFORMANCE_RECONCILED.json', JSON.stringify(report, null, 2));
    
    // Markdown Report Construction
    let md = `# 🛡️ Performance Audit: Broker Reconciliation\n\n`;
    md += `**Status:** ${summary.status === 'VALID' ? '✅ VALID' : '🚨 ' + summary.status}\n\n`;
    md += `> This report uses the **Capital.com Transaction Ledger** as the single source of truth. Bot state and logs are used ONLY for enrichment and validation, never for financial calculations.\n\n`;
    
    md += `## 📈 Financial Summary\n`;
    md += `| Metric | Absolute Value |\n`;
    md += `| :--- | :--- |\n`;
    md += `| **Net P&L (All-In)** | **${summary.totalNetPnl.toFixed(2)} AED** |\n`;
    md += `| Realized Wins | ${summary.wins} |\n`;
    md += `| Realized Losses | ${summary.losses} |\n`;
    md += `| **Win Rate** | **${summary.winRate.toFixed(1)}%** |\n`;
    md += `| Total Fees (Swaps) | ${summary.totalFees.toFixed(2)} AED |\n\n`;

    md += `## 🔍 Reconciliation Integrity\n`;
    md += `| Quality Metric | Count |\n`;
    md += `| :--- | :--- |\n`;
    md += `| **Reconciled Trades** | ${summary.reconciledCount} |\n`;
    md += `| **Unreconciled (Broker Only)** | ${summary.unreconciledCount} |\n`;
    md += `| **Data Mismatches > 0.05R** | ${summary.mismatches > 0 ? `🛑 ${summary.mismatches}` : '✅ 0'} |\n\n`;

    md += `## 📜 Reconstructed Trade Ledger\n`;
    md += `| Date (UTC) | Deal ID | Side | Type | Broker P&L | Bot P&L | Status |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
    
    report.trades.forEach(t => {
      md += `| ${t.date.split('.')[0].replace('T', ' ')} | \`${t.dealId.slice(-8)}\` | ${t.action} | ${t.entryType} | ${t.brokerPnl.toFixed(2)} | ${t.botPnl?.toFixed(2) || '---'} | ${t.flag} |\n`;
    });

    md += `\n---\n*Audit Engine v2.0 - Developed for Gold AI Trader*`;

    fs.writeFileSync('AUDIT_PERFORMANCE_RECONCILED.md', md);
    console.log('✅ Audit complete. Saved to AUDIT_PERFORMANCE_RECONCILED.md');

  } catch (err) {
    console.error('❌ Audit Component Failure:', err.message);
  }
}

runAudit();
