const MINUTES_PER_HOUR = 60;

function utcMinutes(date) {
  return date.getUTCHours() * MINUTES_PER_HOUR + date.getUTCMinutes();
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function inRange(minutes, startHour, startMinute, endHour, endMinute) {
  const start = startHour * MINUTES_PER_HOUR + startMinute;
  const end = endHour * MINUTES_PER_HOUR + endMinute;
  return minutes >= start && minutes <= end;
}

export function classifyTradingSession(now = new Date(), options = {}) {
  const marketClosedReason = typeof options.marketClosedReason === 'string' ? options.marketClosedReason : '';
  if (marketClosedReason.includes('MARKET_CLOSED') || marketClosedReason.toLowerCase().includes('weekend close')) {
    return {
      sessionName: 'MARKET_CLOSED',
      isAllowedSession: false,
      sessionRejectReason: null,
    };
  }

  const date = validDate(now);
  if (!date) {
    return {
      sessionName: null,
      isAllowedSession: false,
      sessionRejectReason: 'SKIP: Session unavailable - invalid UTC time',
    };
  }

  const minutes = utcMinutes(date);

  if (inRange(minutes, 7, 0, 10, 30)) {
    return { sessionName: 'LONDON_OPEN', isAllowedSession: true, sessionRejectReason: null };
  }

  if (inRange(minutes, 12, 30, 16, 0)) {
    return { sessionName: 'NY_OPEN', isAllowedSession: true, sessionRejectReason: null };
  }

  if (inRange(minutes, 16, 0, 18, 0)) {
    return { sessionName: 'NY_CONTINUATION', isAllowedSession: true, sessionRejectReason: null };
  }

  if (inRange(minutes, 21, 55, 23, 10)) {
    return {
      sessionName: 'ROLLOVER_PROTECTION',
      isAllowedSession: false,
      sessionRejectReason: 'SKIP: Outside allowed trading session - rollover protection window',
    };
  }

  return {
    sessionName: 'OUTSIDE_SESSION',
    isAllowedSession: false,
    sessionRejectReason: 'SKIP: Outside allowed trading session',
  };
}
