# Risk Management Concept

Risk management in Gold AI Trader is designed as a separate review layer between signal generation and broker execution. This public version describes the concepts only and excludes exact formulas, thresholds, and private rules.

## Position Sizing Concept

Position sizing determines whether a candidate trade fits within the allowed risk profile. The public version does not include lot size formulas, account-based calculations, or money management rules.

## Exposure Limits

Exposure limits help prevent too many open positions or too much concentration in one market condition. Exact exposure caps and private eligibility rules are excluded.

## Max Daily Loss Concept

A daily loss guard can pause new trade activity after a configured drawdown condition. Public samples do not include real thresholds, production account values, or private enforcement logic.

## Trade Cooldown Concept

A cooldown concept can reduce overtrading by spacing decisions across time or market states. Exact cooldown rules and timing logic are excluded.

## Stop-Loss And Take-Profit Concept

Stop-loss and take-profit planning defines how a trade idea would be bounded before execution. This repository does not include stop-loss formulas, take-profit formulas, trailing stop logic, or private exit rules.

