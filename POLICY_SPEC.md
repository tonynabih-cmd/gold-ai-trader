# Gold Trader Execution Policy Specification

This document defines the intended execution policy for the trading bot. It is an audit reference, not executable code. If implementation behavior differs from this document, the difference must be treated as an audit finding unless explicitly listed as a known exception.

## Scope

The bot may open trades only after the strategy, market-data guards, risk gate, execution policy, and broker execution checks have all permitted execution.

This policy covers opening trades. Existing-position management, reconciliation, state integrity checks, and audit telemetry support this policy but must not be used to justify bypassing opening-trade rules.

## Allowed Symbols

- `GOLD` is the only allowed broker symbol/instrument for opening trades.
- No other symbol, pair, market, or synthetic instrument is authorized by this policy.

## Allowed Actions

- `BUY`
- `SELL`

Any other action, including `HOLD`, `NONE`, empty actions, malformed actions, or non-string action values, must not open a broker order.

## Strategy Authority

The strategy is the only normal authority for creating trade intent.

- A strategy-generated signal may request `BUY` or `SELL`.
- A missing signal means no opening trade.
- A rejected strategy setup means no opening trade.
- Risk, execution policy, and execution checks may reduce or block a strategy-approved signal.
- Risk, execution policy, and execution checks must not create a new strategy signal.
- Telemetry, audit, dashboard, or delegation-gap logic must not create trade intent.

## Execution Policy Decisions

Execution policy decisions are:

- `ALLOW`: Risk returned `APPROVED`, and the market regime does not reduce risk. The trade may proceed to broker execution checks.
- `LIMIT`: Risk returned `APPROVED`, but the market regime applies a risk multiplier below `1.0`. The trade may proceed only with the reduced risk multiplier.
- `BLOCK`: Risk did not return `APPROVED`. No broker opening order may be submitted.

The original risk decision must be preserved in execution-policy telemetry.

## Risk Limits

The bot must enforce all configured risk gates before broker submission:

- Environment kill switch: `BOT_ENABLED` must be `true`.
- State kill switch: `botEnabled` must not be `false`.
- State integrity: `stateIntegrityOk` must not be `false`.
- Critical failure: `criticalFailure` must not be `true`.
- Risk data must be fresh and must not be expired.
- Signal fields must be valid numeric entry, stop-loss, and take-profit values.
- Stop loss must be on the correct side of entry.
- Balance must be synced and high enough for minimum trading.
- Margin must be sufficient using the configured margin buffer.
- Duplicate signal IDs must be blocked.
- Duplicate idempotency keys must be blocked.
- Broker-confirmed fills must pass strict fill validation before a trade is recorded as successful.

Sizing policy:

- Target risk is 2% of live account balance.
- Hard single-trade risk cap is 3% of live account balance.
- Minimum size is `0.01` oz.
- Maximum size is `1.0` oz.
- Margin buffer is `1.5x`.
- Position sizing must use the actual execution stop distance, not stale signal stop distance.
- Regime multipliers may reduce risk, but must not increase risk above the base risk.

Portfolio stress policy:

- Dynamic worst-case move must be valid before opening a trade.
- Portfolio worst-case risk must include existing open trades plus the pending trade.
- Portfolio worst-case exposure must not exceed the configured equity percentage cap.

## Daily Trade Cap

- Maximum executed opening trades per day: `10`.
- Only confirmed successful opening trades count.
- Skipped signals do not count.
- Failed broker orders do not count.

## Order-Rate Cap

- Maximum confirmed successful opening orders: `2` per `60` seconds.
- The cap uses `recentOrderTimestamps`.
- Timestamps older than `60` seconds are ignored.
- Timestamps are updated only after a confirmed successful opening trade.
- Skipped signals do not count.
- Failed broker orders do not count.

## Max Open Trades

- Maximum simultaneous open trades: `2`.
- If local state already has `2` or more open trades, no additional opening trade may be submitted.
- This rule is independent of the daily trade cap and order-rate cap.

## Spread Rules

Spread must be available and within the adaptive spread limit.

- Missing, null, non-numeric, or invalid spread must block opening trades.
- Base spread limit comes from configuration.
- Adaptive spread limit may increase with ATR but is capped.
- Broker-side live spread is checked again immediately before order submission.
- If live spread exceeds the adaptive limit, the broker order must not be submitted.

## ATR Rules

ATR is both strategy input and execution safety input.

- Indicator calculation must produce valid ATR telemetry.
- Strategy may reject dead or unstable ATR regimes before a signal exists.
- Pullback entries must pass the pullback extension guard.
- Pullback extension cap: `2.0` ATR from EMA20.
- Execution stop loss and take profit are recalculated from actual execution price using ATR multipliers.
- Opening trades must preserve at least `2.5R` initial reward/risk after strategy signal generation.
- Broker minimum stop distance may adjust stop loss only within execution safety rules.
- If broker minimum stop distance is too large relative to ATR, the trade must be skipped.
- Invalid ATR in execution risk modeling must halt the attempted trade and trigger critical safety handling where applicable.

## Stale Data Rules

The bot must not open trades on stale or unsafe market data.

- Risk data must be fresh.
- Risk sync older than the configured expiry window must stop trading.
- Signals older than the execution age limit must be rejected.
- Candle data older than persisted state must be skipped as stale market data.
- Candles arriving too late after close must be skipped as stale for reliable entry.
- Missing or invalid market-data snapshots must block execution.

## Duplicate Candle Rules

- The bot must compare the latest fetched candle timestamp to `lastProcessedCandle`.
- If the latest candle equals `lastProcessedCandle`, the cycle is a duplicate candle and must be skipped.
- If the latest candle is older than `lastProcessedCandle`, the cycle is stale and must be skipped.
- Duplicate candle skips must not count as trades.
- Duplicate candle skips must not update opening-order timestamps.
- A successfully processed trade or definitive no-trade outcome may update candle processing state according to the scheduler flow.

## Drawdown Halt

- Equity drawdown at or above `20%` from peak balance must disable the bot.
- Once disabled by drawdown, the bot must not open new trades until manually reviewed and re-enabled.
- Drawdown halt is a hard safety condition, not a telemetry-only warning.

## Daily Loss Halt

- Daily loss at or above `5%` of balance must stop opening trades.
- Daily loss halt is independent of the daily trade count.
- Daily reset may reset daily loss tracking according to the configured trading-day logic.

## Cooldown Logic

The bot enforces same-direction loss cooldown logic:

- After a same-direction stop-loss outcome, the bot must pause that direction for `3` completed candles.
- Two consecutive same-direction stop losses activate a circuit breaker for that direction.
- The same-direction circuit breaker waits for a qualifying 1h trend reset.
- Rolling 5-trade profit factor below the configured threshold activates the expectancy kill switch.
- The expectancy kill switch waits for a 1h trend reset or 24h expiry before normal risk resumes.
- A restricted quality re-entry may clear the expectancy kill switch after 6h only when the candidate setup has at least `2.5R` initial reward/risk, setup confidence `>=75`, and risk is capped at `0.5x` before execution.
- Quality re-entry still must pass all normal risk gates and execution-quality checks.

Cooldowns must not be weakened by regime logic, telemetry, or execution-policy mapping.

## Regime-Based Multipliers

Market regime classification is passive telemetry plus risk multiplier input. It must not create trades.

Regime multipliers:

- `NORMAL`: `1.0`
- `VOLATILE`: `0.5`
- `EXTREME`: `0.25`
- `SIDEWAYS`: `0.5`
- `DEAD`: `0.25`

Policy mapping:

- `APPROVED` plus `NORMAL` maps to `ALLOW`.
- `APPROVED` plus reduced-risk regimes maps to `LIMIT`.
- Any non-`APPROVED` risk result maps to `BLOCK`.

Regime multipliers may reduce sizing only. They must not bypass a risk gate.

## Slippage Telemetry

Slippage is both a pre-execution guard and post-fill telemetry.

- Live slippage from intended entry to execution price is checked before order submission.
- Slippage above the allowed threshold must reject or skip the trade.
- Execution quality score below `70` must reject the trade before broker submission.
- Fill slippage telemetry records intended entry, actual fill, absolute slippage, slippage-to-ATR, and fill quality.
- Fill quality labels include `GOOD`, `ACCEPTABLE`, `DEGRADED`, and `UNKNOWN`.
- Unknown slippage telemetry must not synthesize missing values.

## CVaR Telemetry

CVaR is passive tail-loss telemetry for audit and monitoring.

- CVaR must be calculated from closed-trade P&L data.
- CVaR telemetry must not create trade intent.
- CVaR telemetry must not override risk gates.
- CVaR anomalies may support human review and future policy changes, but are not an execution bypass.

## Delegation-Gap Logging

Delegation-gap logging records cases where a strategy-intended trade did not execute.

It must preserve:

- Intended action.
- Blocking reason.
- Category.
- Market regime.
- Execution policy.
- Timestamp.

Categories include:

- `risk_gate`
- `data_guard`
- `market_condition`
- `execution_failure`
- `unknown`

Delegation-gap logging is telemetry only. It must not place trades, retry blocked trades, or weaken a blocking reason.

## Non-bypassable Execution Rules

The following rules are non-bypassable in normal operation:

- Only `GOLD` may be traded.
- Only `BUY` and `SELL` may open trades.
- No signal means no trade.
- Risk result other than `APPROVED` means execution policy `BLOCK`.
- `BLOCK` means no broker opening order.
- Max `10` executed opening trades per day.
- Max `2` confirmed opening orders per `60` seconds.
- Max `2` simultaneous open trades.
- Fresh risk data is required.
- Valid state integrity is required.
- Critical failure state blocks trading.
- Duplicate candle cycles are skipped.
- Stale candle or stale risk data is skipped or stopped.
- Daily loss halt blocks trading.
- Drawdown halt disables trading.
- Invalid broker response, unknown order state, partial fill, missing deal ID, or failed strict fill validation must not be treated as a successful opening trade.
- Order-rate timestamps, daily trade counts, and open-trade state update only after confirmed successful opening trades.

## Current known exception: FORCE_TRADE

`FORCE_TRADE=true` is a known exception in the current implementation.

When active, it can create a forced test signal and bypass normal strategy and risk filters by treating the risk result as `APPROVED` for `forced_test` entries.

Audit status:

- This exception is not part of normal intended execution policy.
- It must be treated as test-only behavior.
- It should never be enabled in live production trading.
- Any live trade opened through `FORCE_TRADE` should be flagged as a policy exception.
- Future hardening should remove this bypass or restrict it behind stronger non-production controls.

## Audit Position

For future audits, the expected behavior is strict:

- Strategy may propose trades.
- Risk may approve, pause, stop, disable, or skip.
- Execution policy may allow, limit, or block.
- Broker execution may still reject.
- Telemetry may explain decisions.
- No layer after risk approval may expand authority beyond what the strategy and risk gate allowed.
