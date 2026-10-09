// Fail-closed time-boundary guard for historical retrospective experiments.
// A signal entered at the next open can exit as late as 20 trading sessions
// after the entry, so at least 21 known trading sessions are purged.
export function latestEmbargoedSignalDate(sessions, lastSession, maxHoldTradingDays = 20) {
  if (!Array.isArray(sessions) || !sessions.length) return null;
  const idx = sessions.indexOf(lastSession);
  if (idx < 0 || !Number.isInteger(maxHoldTradingDays) || maxHoldTradingDays < 0) return null;
  const safeIdx = idx - (maxHoldTradingDays + 1);
  return safeIdx < 0 ? null : sessions[safeIdx];
}

export function timeSafePeriods({ sessions, trainEnd, validationStart, validationEnd, holdoutStart, finalSignalDate, maxHoldTradingDays = 20 }) {
  if (!sessions?.length || !sessions.includes(trainEnd) || !sessions.includes(validationEnd) ||
      !sessions.includes(validationStart) || !sessions.includes(holdoutStart)) throw Error("BAD_SESSION_BOUNDARIES");
  const trainSafe = latestEmbargoedSignalDate(sessions, trainEnd, maxHoldTradingDays);
  const valSafe = latestEmbargoedSignalDate(sessions, validationEnd, maxHoldTradingDays);
  if (!trainSafe || !valSafe || trainSafe >= validationStart || valSafe >= holdoutStart) throw Error("INSUFFICIENT_EMBARGO");
  return [
    { id:"train", from:sessions[0], to:trainSafe, boundaryDate:trainEnd, purgedThrough:trainEnd },
    { id:"validation", from:validationStart, to:valSafe, boundaryDate:validationEnd, purgedThrough:validationEnd },
    { id:"holdout", from:holdoutStart, to:finalSignalDate, boundaryDate:finalSignalDate, purgedThrough:null }
  ];
}
