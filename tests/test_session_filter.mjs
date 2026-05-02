// tests/test_session_filter.mjs — Unit tests for UTC trading-session classification.

import { classifyTradingSession } from '../lib/session_filter.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${message}`);
  }
}

function section(name) {
  console.log(`\n── ${name} ──`);
}

function at(utcTime) {
  return new Date(`2026-05-04T${utcTime}:00.000Z`);
}

section('Allowed UTC windows');
{
  assert(classifyTradingSession(at('07:00')).sessionName === 'LONDON_OPEN', '07:00 UTC is LONDON_OPEN');
  assert(classifyTradingSession(at('07:00')).isAllowedSession === true, '07:00 UTC allowed');
  assert(classifyTradingSession(at('10:30')).sessionName === 'LONDON_OPEN', '10:30 UTC is LONDON_OPEN');
  assert(classifyTradingSession(at('10:30')).isAllowedSession === true, '10:30 UTC allowed');
  assert(classifyTradingSession(at('12:30')).sessionName === 'NY_OPEN', '12:30 UTC is NY_OPEN');
  assert(classifyTradingSession(at('12:30')).isAllowedSession === true, '12:30 UTC allowed');
  assert(classifyTradingSession(at('16:00')).sessionName === 'NY_OPEN', '16:00 UTC boundary resolves to NY_OPEN');
  assert(classifyTradingSession(at('16:00')).isAllowedSession === true, '16:00 UTC allowed');
  assert(classifyTradingSession(at('18:00')).sessionName === 'NY_CONTINUATION', '18:00 UTC is NY_CONTINUATION');
  assert(classifyTradingSession(at('18:00')).isAllowedSession === true, '18:00 UTC allowed');
}

section('Blocked UTC windows');
{
  const early = classifyTradingSession(at('00:00'));
  assert(early.sessionName === 'OUTSIDE_SESSION', `00:00 UTC blocked as outside session (got ${early.sessionName})`);
  assert(early.isAllowedSession === false, '00:00 UTC blocked');

  const preLondon = classifyTradingSession(at('06:59'));
  assert(preLondon.sessionName === 'OUTSIDE_SESSION', `06:59 UTC blocked as outside session (got ${preLondon.sessionName})`);
  assert(preLondon.isAllowedSession === false, '06:59 UTC blocked');

  const midGap = classifyTradingSession(at('10:31'));
  assert(midGap.sessionName === 'OUTSIDE_SESSION', `10:31 UTC blocked as outside session (got ${midGap.sessionName})`);
  assert(midGap.isAllowedSession === false, '10:31 UTC blocked');

  const late = classifyTradingSession(at('18:01'));
  assert(late.sessionName === 'OUTSIDE_SESSION', `18:01 UTC blocked as outside session (got ${late.sessionName})`);
  assert(late.isAllowedSession === false, '18:01 UTC blocked');

  const rollover = classifyTradingSession(at('22:00'));
  assert(rollover.sessionName === 'ROLLOVER_PROTECTION', `22:00 UTC blocked as rollover (got ${rollover.sessionName})`);
  assert(rollover.isAllowedSession === false, '22:00 UTC blocked');
  assert(rollover.sessionRejectReason.includes('rollover protection'), `22:00 UTC reason names rollover (got ${rollover.sessionRejectReason})`);
}

section('Market closed override');
{
  const closed = classifyTradingSession(at('22:00'), {
    marketClosedReason: 'MARKET_CLOSED: Gold weekend close (Saturday UTC)',
  });
  assert(closed.sessionName === 'MARKET_CLOSED', `market closed remains primary session label (got ${closed.sessionName})`);
  assert(closed.isAllowedSession === false, 'market closed is not an allowed entry session');
  assert(closed.sessionRejectReason === null, 'market closed does not emit a session reject reason');
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(60)}\n`);

if (failed > 0) process.exit(1);
