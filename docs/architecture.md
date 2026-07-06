# Architecture

Gold AI Trader is organized around clear boundaries between market observation, decision support, risk review, execution preparation, monitoring, and dashboard reporting. This public version documents those boundaries without exposing private strategy logic, production credentials, or live execution code.

## Market Data Input

The market data layer represents incoming XAU/USD snapshots or candles from an external data source. In this showcase, the layer returns mock data only. Production data-provider URLs, authentication details, polling intervals, and normalization logic are excluded.

## Signal Engine Boundary

The signal engine is responsible for evaluating market context and producing a directional signal object. Private trading logic is omitted in this public version, including signal rules, indicator combinations, thresholds, model weights, entry conditions, and exit conditions.

## Risk-Control Boundary

The risk-control layer reviews whether a candidate signal is eligible for execution under portfolio and session constraints. Exact risk formulas, money management rules, exposure thresholds, and position sizing calculations are excluded.

## Broker Adapter Boundary

The broker adapter isolates order preparation from the rest of the system. Public sample functions never place live orders and return simulated responses only. Broker credentials, endpoints, account identifiers, and execution payload details are intentionally excluded.

## Trade Monitor

The trade monitor tracks public-safe trade status objects such as pending, simulated, closed, or blocked. This showcase uses fake trade records and does not include live logs, real account data, or production order identifiers.

## Dashboard

The dashboard presents market status, signal state, risk review status, mock trade history, and mock performance summaries. Screenshots with balances, broker data, private account identifiers, or production history are excluded.

## Storage And Logging Concept

Storage may be used to persist configuration, status snapshots, audit events, and historical records. This repository includes only mock JSON data. Real databases, server URLs, logs, reports, exports, and backtest artifacts are excluded from the public version.

