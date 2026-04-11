# 🛡️ Performance Audit: Broker Reconciliation

**Status:** ✅ VALID

> This report uses the **Capital.com Transaction Ledger** as the single source of truth. Bot state and logs are used ONLY for enrichment and validation, never for financial calculations.

## 📈 Financial Summary
| Metric | Absolute Value |
| :--- | :--- |
| **Net P&L (All-In)** | **-3.59 AED** |
| Realized Wins | 8 |
| Realized Losses | 11 |
| **Win Rate** | **42.1%** |
| Total Fees (Swaps) | 0.16 AED |

## 🔍 Reconciliation Integrity
| Quality Metric | Count |
| :--- | :--- |
| **Reconciled Trades** | 0 |
| **Unreconciled (Broker Only)** | 15 |
| **Data Mismatches > 0.05R** | 🛑 4 |

## 📜 Reconstructed Trade Ledger
| Date (UTC) | Deal ID | Side | Type | Broker P&L | Bot P&L | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 2026-04-09 20:41:52 | `8f550315` | BUY | breakout | -0.75 | -0.70 | ⚠️ MISMATCH |
| 2026-04-09 18:31:29 | `8f536b34` | BUY | pullback | -0.74 | -0.95 | ⚠️ MISMATCH |
| 2026-04-09 18:18:34 | `8f530772` | BUY | breakout | -0.01 | 0.11 | ⚠️ MISMATCH |
| 2026-04-09 15:34:01 | `8f5124e2` | BUY | pullback | 1.00 | 2.31 | ⚠️ MISMATCH |
| 2026-04-06 17:52:43 | `8f2e2f9d` | BUY_CLOSE | UNKNOWN | -0.92 | --- | ❓ BROKER_ONLY |
| 2026-04-06 02:00:03 | `8f228a1c` | BUY_CLOSE | UNKNOWN | -2.38 | --- | ❓ BROKER_ONLY |
| 2026-04-02 16:21:11 | `8f1d0b88` | SELL_CLOSE | UNKNOWN | 0.02 | --- | ❓ BROKER_ONLY |
| 2026-04-01 20:22:46 | `8f108e92` | SELL_CLOSE | UNKNOWN | 0.43 | --- | ❓ BROKER_ONLY |
| 2026-04-01 15:39:22 | `8f0b53a8` | SELL_CLOSE | UNKNOWN | 1.00 | --- | ❓ BROKER_ONLY |
| 2026-03-31 18:00:11 | `8eff242d` | SELL_CLOSE | UNKNOWN | 1.02 | --- | ❓ BROKER_ONLY |
| 2026-03-31 17:54:38 | `8eff8bcf` | SELL_CLOSE | UNKNOWN | 1.09 | --- | ❓ BROKER_ONLY |
| 2026-03-31 15:11:18 | `8efe4637` | BUY_CLOSE | UNKNOWN | -0.98 | --- | ❓ BROKER_ONLY |
| 2026-03-30 19:37:31 | `8ef4a157` | BUY_CLOSE | UNKNOWN | -0.79 | --- | ❓ BROKER_ONLY |
| 2026-03-30 19:35:40 | `8ef51cac` | BUY_CLOSE | UNKNOWN | -0.80 | --- | ❓ BROKER_ONLY |
| 2026-03-30 17:45:26 | `8ef2d62c` | BUY_CLOSE | UNKNOWN | -1.39 | --- | ❓ BROKER_ONLY |
| 2026-03-30 17:35:38 | `8ef350c1` | BUY_CLOSE | UNKNOWN | -1.18 | --- | ❓ BROKER_ONLY |
| 2026-03-30 15:44:51 | `8ef0de5a` | SELL_CLOSE | UNKNOWN | 1.55 | --- | ❓ BROKER_ONLY |
| 2026-03-30 15:42:18 | `8ef0845e` | SELL_CLOSE | UNKNOWN | 1.65 | --- | ❓ BROKER_ONLY |
| 2026-03-30 11:34:54 | `8ef0254f` | BUY_CLOSE | UNKNOWN | -1.27 | --- | ❓ BROKER_ONLY |

---
*Audit Engine v2.0 - Developed for Gold AI Trader*