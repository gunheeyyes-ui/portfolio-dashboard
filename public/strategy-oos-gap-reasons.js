// Classify only evidence present in immutable OOS metadata.
// Unknown dates are never assumed to share a known gap's cause.
export function classifyOosGaps(dates=[],skipped=[]){
  const events=new Map();
  for(const event of skipped||[]){
    const date=String(event?.signalDate??"");
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))continue;
    if(!events.has(date))events.set(date,[]);
    events.get(date).push(event);
  }
  const result=(dates||[]).map(date=>{
    const matching=events.get(date)||[];
    const quarantined=matching.find(e=>e.reason==="QUARANTINED_INCOMPLETE_MARKET_REFRESH");
    if(quarantined)return {
      date,status:"CONFIRMED_QUARANTINED",reason:quarantined.reason,
      marketCounts:quarantined.marketCounts||null,
      removed:quarantined.removed||null,
      verifiedFrom:"OOS_META_SKIPPED"
    };
    return {
      date,status:"CAUSE_UNVERIFIED",reason:matching.map(e=>e.reason).join("|")||null,
      marketCounts:null,removed:null,verifiedFrom:matching.length?"OOS_META_SKIPPED":"NO_EVENT_IN_EXPOSED_HISTORY"
    };
  });
  return {
    missingDates:result.length,
    confirmedQuarantine:result.filter(x=>x.status==="CONFIRMED_QUARANTINED").length,
    unresolved:result.filter(x=>x.status!=="CONFIRMED_QUARANTINED").length,
    rows:result
  };
}
