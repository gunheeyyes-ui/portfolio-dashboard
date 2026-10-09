// Exhaustive retrospective policy grid, segregated from immutable/live OOS.
// Still subject to severe historical fixed-universe selection/survivorship bias.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { latestEmbargoedSignalDate, timeSafePeriods } from "./strategy-audit-boundaries.mjs";

const INITIAL=100_000_000, BUDGET=10_000_000, MAX_POSITIONS=10, BASE_FRICTION=0.23;
const finite = (x) => x!==null && x!==undefined && Number.isFinite(Number(x));
const rnd = (x) => Math.round(x*1000)/1000;
const rules = [
  {id:"fixed3",days:3}, {id:"fixed5",days:5}, {id:"fixed10",days:10}, {id:"fixed20",days:20},
  {id:"sl5_tp8_5",days:5,stop:-5,take:8},
  {id:"sl5_tp8_10",days:10,stop:-5,take:8},
  {id:"sl8_tp15_20",days:20,stop:-8,take:15}
];
const positionsPerDay = [3,5,10];
const priorities = ["native","timing"];
const periodNames = ["train","validation","holdout"];
const highRiskCodes=new Set();
function cashMetrics(ordered, tradeRows, selectionCount, misses, dateStart, dateEnd, friction) {
  const total=ordered.at(-1)?.equity ?? INITIAL;
  const closed=tradeRows.length;
  const pos=tradeRows.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
  const neg=Math.abs(tradeRows.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0));
  let peak=INITIAL, worst=0;
  for(const p of ordered){
    if(p.equity>peak) peak=p.equity;
    worst=Math.min(worst, (p.equity/peak-1)*100);
  }
  return {
    netPct:rnd((total/INITIAL-1)*100),
    mddPct:rnd(worst),
    closed,entries:tradeRows.length+misses.openAtEnd,
    winPct:closed?rnd(100*tradeRows.filter(x=>x.pnl>0).length/closed):null,
    pf:neg>0?rnd(pos/neg):null,
    signals:selectionCount,skipped:misses.skipped,missingQuotes:misses.missingQuotes,
    gapBlocked:misses.gapBlocked,unfilled:misses.unfilled,
    abnormalTrades:tradeRows.filter(t=>t.abnormal).length,
    // Not a counterfactual: post-hoc haircut diagnostics on existing trades.
    removeTop5PnlPct:rnd((total - [...tradeRows].sort((a,b)=>b.pnl-a.pnl).slice(0,5).reduce((s,t)=>s+Math.max(t.pnl,0),0))/INITIAL*100-100),
    capped40PnlPct:rnd((total-tradeRows.reduce((s,t)=>s+Math.max(0,t.pnl-t.principal*0.4),0))/INITIAL*100-100),
    costBps:friction*100,from:dateStart,to:dateEnd
  };
}

function stableHash(value){ let h=2166136261; for(let i=0;i<value.length;i++) {h^=value.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0; }
function sortRank(a,b,method,ranker){
  if(method.startsWith("random")) {
    const ha=stableHash(method+"|"+a.date+"|"+a.market+"|"+a.code);
    const hb=stableHash(method+"|"+b.date+"|"+b.market+"|"+b.code);
    return ha-hb || a.code.localeCompare(b.code);
  }
  const vals = {
    native: ranker==="leader"?"leaderRank":ranker==="rs"?"_historicalRsRank":ranker==="timing"?"combinedRank":ranker==="rankingV2"?"rankingV2Rank":ranker==="scout"?"scoutRank":"leaderRank",
    timing:"combinedRank"
  };
  const field=vals[method];
  const aa=finite(a[field])?Number(a[field]):999999, bb=finite(b[field])?Number(b[field]):999999;
  return aa-bb || (Number(b.rs20||0)-Number(a.rs20||0)) || a.market.localeCompare(b.market) || a.code.localeCompare(b.code);
}
function prepStrategySignals(strategy, rows, marketSessions, cachedBars, sortMethods=priorities) {
  const index=new Map(marketSessions.map((date,i)=>[date,i]));
  const byDate=new Map();
  const barsMap=new Map();
  let unavailable=0, blocked=0;
  for(const row of rows){
    const entryDate=row.entryDate3;
    if(!entryDate || !index.has(entryDate)) {unavailable++;continue;}
    let barMap=barsMap.get(row.code);
    if(!barMap){barMap=cachedBars(row.code);barsMap.set(row.code,barMap);}
    const signal=barMap.get(row.date), entry=barMap.get(entryDate);
    if(!signal?.close || !entry?.open){unavailable++;continue;}
    // Reject grossly discontinuous next-open prices without peeking ahead.
    const gap=(entry.open/signal.close-1)*100;
    if(Math.abs(gap)>15){blocked++;continue;}
    const payload={row,code:row.code,name:row.name,market:row.market,signalDate:row.date,
      date:entryDate, entryOpen:Number(entry.open),signalClose:Number(signal.close),
      bars:barMap, liquidity:Number(row.liquidityScore??0), entryIndex:index.get(entryDate)};
    if(!byDate.has(entryDate))byDate.set(entryDate,[]);
    byDate.get(entryDate).push(payload);
  }
  const orders={};
  for(const method of sortMethods){
    const sortByDate = new Map();
    for(const [date,items] of byDate){
      const arr=[...items].sort((a,b)=>sortRank(a.row,b.row,method,strategy.ranker));
      sortByDate.set(date,arr);
    }
    orders[method]=sortByDate;
  }
  return {orders,unavailable,blocked};
}

function simulate({prepared, sessions, startSignalDate, endSignalDate, dailyLimit, priority, rule, friction=BASE_FRICTION}) {
  const index=new Map(sessions.map((d,i)=>[d,i]));
  const candidates=prepared.orders[priority];
  const startIndex=Math.max(0,sessions.findIndex(d=>d>=startSignalDate));
  const endIndex=sessions.findIndex(d=>d>endSignalDate);
  const finalIndex = Math.min(sessions.length-1,(endIndex<0?sessions.length-1:endIndex)+22);
  let cash=INITIAL;
  const held=new Map(), trades=[],curve=[];
  const missed={skipped:0,unfilled:0,gapBlocked:prepared.blocked,missingQuotes:0,openAtEnd:0};
  let signals=0, attempts=0;
  for(let di=startIndex;di<=finalIndex;di++){
    const date=sessions[di];
    if(date<=endSignalDate){
      const todays=candidates.get(date)||[];
      const chosen=todays.filter(x=>x.signalDate>=startSignalDate&&x.signalDate<=endSignalDate).slice(0,dailyLimit);
      signals+=chosen.length;
      for(const c of chosen){
        attempts++;
        if(held.has(c.code)||held.size>=MAX_POSITIONS){missed.skipped++;continue;}
        const slip=c.liquidity>=70?0.10:c.liquidity>=45?0.20:0.35;
        const fill=c.entryOpen*(1+slip/200);
        const qty=Math.floor(Math.min(BUDGET,cash)/fill);
        if(qty<=0){missed.unfilled++;continue;}
        const principal=qty*fill;
        cash-=principal;
        held.set(c.code,{
          ...c,qty,principal,slip,entryFill:fill,entryIndex:di,lastClose:c.entryOpen,
          stopPrice:rule.stop===undefined?null:fill*(1+rule.stop/100),
          takePrice:rule.take===undefined?null:fill*(1+rule.take/100),
          abnormal:false
        });
      }
    }
    for(const [code,pos] of held){
      const bar=pos.bars.get(date);
      if(!bar?.close){missed.missingQuotes++;continue;}
      const close=Number(bar.close), open=Number(bar.open||close), high=Number(bar.high||close),low=Number(bar.low||close);
      if(pos.lastClose && (close/pos.lastClose>1.45||close/pos.lastClose<0.55))pos.abnormal=true;
      pos.lastClose=close;
      let exit=null,reason=null;
      if(rule.stop!==undefined){
        if(open<=pos.stopPrice){exit=open;reason="GAP_STOP";}
        else if(open>=pos.takePrice){exit=open;reason="GAP_TAKE";}
        else if(low<=pos.stopPrice){exit=pos.stopPrice;reason=(high>=pos.takePrice?"BOTH_STOP_FIRST":"STOP");}
        else if(high>=pos.takePrice){exit=pos.takePrice;reason="TAKE";}
      }
      if(exit===null && di>=pos.entryIndex+rule.days){exit=close;reason="TIME";}
      if(exit!==null){
        const proceeds=pos.qty*exit*(1-pos.slip/200)*(1-friction/100);
        const pnl=proceeds-pos.principal;
        cash+=proceeds;
        trades.push({code,date,pnl,principal:pos.principal,abnormal:pos.abnormal||Math.abs((exit/pos.entryFill-1)*100)>80,reason});
        held.delete(code);
      }
    }
    let equity=cash;
    for(const pos of held) equity+=pos[1].qty*pos[1].lastClose;
    curve.push({date,equity});
  }
  missed.openAtEnd=held.size;
  return cashMetrics(curve,trades,signals,missed,startSignalDate,endSignalDate,friction);
}

function robustGate(train,validation) {
  return train.closed>=25 && validation.closed>=20 &&
    train.netPct>0 && validation.netPct>0 && validation.mddPct>=-20 &&
    validation.pf!==null && validation.pf>=1.1 && validation.removeTop5PnlPct>0 &&
    validation.abnormalTrades===0;
}

export async function runRobustnessGrid({matrix,dated,matches,registry,cachedBars,outputFile}){
  const allDates=[...new Set(dated.map(r=>r.date))].sort();
  const allSessions=[...new Set(matrix.observations.map(r=>r.date))].sort();
  const trainEnd=allDates[Math.floor(allDates.length*0.48)-1];
  const valStart=allDates[Math.floor(allDates.length*0.48)];
  const valEnd=allDates[Math.floor(allDates.length*0.74)-1];
  const testStart=allDates[Math.floor(allDates.length*0.74)];
  // Purge signals whose latest permitted exit could enter validation/holdout.
  // 20D max hold + 1D next-open entry = at least 21 market sessions.
  const periods=timeSafePeriods({
    sessions:allSessions,trainEnd,validationStart:valStart,validationEnd:valEnd,
    holdoutStart:testStart,finalSignalDate:allDates.at(-1),maxHoldTradingDays:20
  });
  console.log(JSON.stringify({stage:"grid-start",sessions:allSessions.length,periods,policies:rules.length,perDay:positionsPerDay,priority:priorities}));
  const results=[], methodCount=rules.length*positionsPerDay.length*priorities.length*periods.length;
  for(let k=0;k<registry.length;k++){
    const strategy=registry[k], selected=matches.get(strategy.id);
    const prepared=prepStrategySignals(strategy,selected,allSessions,cachedBars);
    const experiments=[];
    for(const rule of rules)for(const dailyLimit of positionsPerDay)for(const priority of priorities){
      const metrics={};
      for(const p of periods)metrics[p.id]=simulate({
        prepared,sessions:allSessions,startSignalDate:p.from,endSignalDate:p.to,dailyLimit,priority,rule
      });
      experiments.push({
        rule:rule.id,dailyLimit,priority,
        train:metrics.train,validation:metrics.validation,holdout:metrics.holdout,
        screenPass:robustGate(metrics.train,metrics.validation)
      });
    }
    const passing=experiments.filter(x=>x.screenPass);
    const sorted=[...passing].sort((a,b)=>
      (b.validation.netPct-Math.abs(b.validation.mddPct)*0.4)-(a.validation.netPct-Math.abs(a.validation.mddPct)*0.4)
      || a.rule.localeCompare(b.rule));
    const choice=sorted[0]??null;
    results.push({id:strategy.id,name:strategy.displayName,group:strategy.group,matched: selected.length,
      unavailable:prepared.unavailable,gapBlocked:prepared.blocked,
      experiments,preHoldoutSelected:choice?{rule:choice.rule,dailyLimit:choice.dailyLimit,priority:choice.priority,train:choice.train,validation:choice.validation,holdout:choice.holdout}:null,
      screenPassed:passing.length});
    if((k+1)%15===0) console.log(JSON.stringify({stage:"grid-progress",done:k+1,total:registry.length,passed:results.filter(x=>x.preHoldoutSelected).length}));
  }
  const randomByPolicy = new Map();
  const seeds=Array.from({length:10},(_,i)=>"random"+i);
  const controlSignals=prepStrategySignals({ranker:null},dated,allSessions,cachedBars,seeds);
  for(const rule of rules)for(const dailyLimit of positionsPerDay){
    const samples=[];
    for(const seed of seeds){
      const hold=simulate({prepared:controlSignals,sessions:allSessions,startSignalDate:periods[2].from,
        endSignalDate:periods[2].to,dailyLimit,priority:seed,rule});
      samples.push(hold.netPct);
    }
    samples.sort((a,b)=>a-b);
    randomByPolicy.set(rule.id+"|"+dailyLimit,{medianPct:rnd((samples[4]+samples[5])/2),minPct:samples[0],maxPct:samples.at(-1),samples});
  }
  const chosen=results.filter(x=>x.preHoldoutSelected).map(x=>({id:x.id,name:x.name,matched:x.matched,selected:x.preHoldoutSelected,
    control:randomByPolicy.get(x.preHoldoutSelected.rule+"|"+x.preHoldoutSelected.dailyLimit),
    validated:x.preHoldoutSelected.holdout.closed>=20 && x.preHoldoutSelected.holdout.netPct>0 &&
      x.preHoldoutSelected.holdout.mddPct>=-20 && x.preHoldoutSelected.holdout.removeTop5PnlPct>0
  })).sort((a,b)=>b.selected.holdout.netPct-a.selected.holdout.netPct);
  const costAndMarketStress={};
  for(const item of chosen){
    const strategy=registry.find(s=>s.id===item.id);
    const rule=rules.find(r=>r.id===item.selected.rule);
    const q=matches.get(item.id);
    const prepared=prepStrategySignals(strategy,q,allSessions,cachedBars);
    const config={prepared,sessions:allSessions,startSignalDate:periods[2].from,
      endSignalDate:periods[2].to,dailyLimit:item.selected.dailyLimit,
      priority:item.selected.priority,rule};
    const kospi=prepStrategySignals(strategy,q.filter(z=>z.market==="KOSPI"),allSessions,cachedBars);
    const kosdaq=prepStrategySignals(strategy,q.filter(z=>z.market==="KOSDAQ"),allSessions,cachedBars);
    costAndMarketStress[item.id]={
      roundTripFee05:simulate({...config,friction:0.5}),
      roundTripFee10:simulate({...config,friction:1.0}),
      kospiOnly:simulate({...config,prepared:kospi}),
      kosdaqOnly:simulate({...config,prepared:kosdaq})
    };
  }
  const summary={
    schema:"strategy-robustness-grid-v3",
    computedAt:new Date().toISOString(),
    source:"fixed 200-stock cache created with future-date membership; strong survivorship/selection bias; research only",
    observations:matrix.observations.length,completeRows:dated.length,
    strategyCount:registry.length,
    combinationsPerStrategy:methodCount,
    experimentCount:registry.length*methodCount,
    policies:rules,priorities,dailyCaps:positionsPerDay,periods,
    researchOnly:true,canEnableRealOrders:false,
    methodology:"Same synthetic initial 100m independently per 107 strategy × 7 exit × 3 daily caps × 2 priorities × 3 chronological windows; validate params on training + validation only, holdout never used to select.",
    lookaheadWarning:"Definitions were established later than replayed trades; selecting among 107 definitions itself invalidates genuine out-of-sample independence.",
    priceIntegrityWarning:"Single instrument history may contain unadjusted corporate actions; abnormal trades are flagged, and top-profit/40% profit cap stress are post-hoc sensitivities, not alternative portfolios.",
    noForwardOrderPlacement:true,
    costAndMarketStress,
    randomControl:{description:"Ten pre-seeded random daily selection orders from same frozen 200-stock universe, independently funded 100m accounts",byPolicy:Object.fromEntries(randomByPolicy)},
    preHoldoutQualified:chosen.length,
    holdoutPositive:chosen.filter(x=>x.validated).length,
    selectedCandidates:chosen,
    results
  };
  mkdirSync(path.dirname(outputFile),{recursive:true});
  writeFileSync(outputFile,JSON.stringify(summary),"utf8");
  console.log(JSON.stringify({stage:"grid-complete",outputFile,experiments:summary.experimentCount,qualified:chosen.length,holdoutPositive:summary.holdoutPositive,top:chosen.slice(0,18).map(x=>({id:x.id,name:x.name,rule:x.selected.rule,cap:x.selected.dailyLimit,priority:x.selected.priority,validation:x.selected.validation.netPct,holdout:x.selected.holdout.netPct,mdd:x.selected.holdout.mddPct,n:x.selected.holdout.closed,stress:x.selected.holdout.removeTop5PnlPct,abnormal:x.selected.holdout.abnormalTrades,control:x.control?.medianPct}))},null,2));
}
