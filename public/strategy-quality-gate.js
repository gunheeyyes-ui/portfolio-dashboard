// Read-only research approval gate. No broker-order or strategy execution privileges.
export const KRX_2026_HOLIDAYS = Object.freeze([
"2026-01-01","2026-02-16","2026-02-17","2026-02-18","2026-03-02",
"2026-05-01","2026-05-05","2026-05-25","2026-06-03","2026-07-17",
"2026-08-17","2026-09-24","2026-09-25","2026-10-05","2026-10-09","2026-12-25","2026-12-31"]);
export function expectedMissingKrxDays(dates,holidays=KRX_2026_HOLIDAYS) {
  if(!Array.isArray(dates)||dates.length<2)return [];
  const observed=[...new Set(dates)].sort(),seen=new Set(observed),closed=new Set(holidays);
  if(!observed.every(d=>/^2026-\d{2}-\d{2}$/.test(d)))return null; // unknown calendar => fail closed
  const missing=[];
  for(let t=Date.parse(observed[0]+"T00:00:00Z");t<=Date.parse(observed.at(-1)+"T00:00:00Z");t+=86400000){
    const d=new Date(t).toISOString().slice(0,10),weekday=new Date(t).getUTCDay();
    if(weekday>0&&weekday<6&&!seen.has(d)&&!closed.has(d))missing.push(d);
  }
  return missing;
}
export function evaluateResearchQualityGate(audit,liveOosDates=null) {
  const failures=(audit?.checks||[]).filter(c=>c.status==="FAIL").map(c=>c.id);
  const missing=expectedMissingKrxDays(liveOosDates||audit?.oosCalendar?.observedDates||[]);
  if(!audit || !Array.isArray(audit.checks) || !Array.isArray(missing)||!liveOosDates?.length) {
    return {status:"BLOCKED",liveOrderEligible:false,researchRankingApproved:false,
      reasons:["AUDIT_OR_LIVE_CALENDAR_UNAVAILABLE"],missingDates:missing||[]};
  }
  if(missing.length)failures.push("MISSING_OOS_SNAPSHOTS");
  return {status:failures.length?"BLOCKED":"REVIEW_REQUIRED",liveOrderEligible:false,
    researchRankingApproved:false,reasons:[...new Set(failures)],missingDates:missing,
    lastSignalDate:[...liveOosDates].sort().at(-1)};
}
