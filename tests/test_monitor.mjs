// tests/test_monitor.mjs - Alert severity, cooldown, and dedupe policy.

import { ALERT_SEVERITY, shouldDispatchAlert } from '../lib/monitor.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  OK ${message}`);
  } else {
    failed++;
    console.error(`  FAIL ${message}`);
  }
}

const state = {};
const base = {
  id: 'realtime:high_stale',
  dedupeKey: 'realtime:high_stale',
  severity: ALERT_SEVERITY.WARNING,
  now: 1000,
};

const first = shouldDispatchAlert(state, 'High stale data', base);
assert(first.dispatch === true, 'first warning dispatches');
assert(first.stateModified === true, 'first warning writes alert registry');

const duplicate = shouldDispatchAlert(state, 'High stale data', { ...base, now: 2000 });
assert(duplicate.dispatch === false, 'identical active warning is deduped');
assert(duplicate.reason === 'DEDUPED_ACTIVE', 'duplicate suppression reason is active dedupe');

state.alertRegistry['realtime:high_stale'].active = false;
const cooldown = shouldDispatchAlert(state, 'High stale data changed', { ...base, now: 10 * 60 * 1000 });
assert(cooldown.dispatch === false, 'warning inside 30 minute cooldown is suppressed');
assert(cooldown.reason === 'COOLDOWN', 'cooldown suppression reason is tracked');

const afterCooldown = shouldDispatchAlert(state, 'High stale data changed', { ...base, now: 31 * 60 * 1000 });
assert(afterCooldown.dispatch === true, 'warning after 30 minutes dispatches');

const infoState = {};
const infoFirst = shouldDispatchAlert(infoState, 'Daily summary', {
  id: 'daily',
  severity: ALERT_SEVERITY.INFO,
  now: 1000,
});
assert(infoFirst.dispatch === true, 'first info alert dispatches to log layer');
infoState.alertRegistry.daily.active = false;
const infoCooldown = shouldDispatchAlert(infoState, 'Daily summary updated', {
  id: 'daily',
  severity: ALERT_SEVERITY.INFO,
  now: 60 * 60 * 1000,
});
assert(infoCooldown.dispatch === false, 'info inside 2 hour cooldown is suppressed');

if (failed > 0) {
  console.error(`\n${failed} monitor tests failed (${passed} passed).`);
  process.exit(1);
}

console.log(`\nAll monitor tests passed (${passed}).`);
