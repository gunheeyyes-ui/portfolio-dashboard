// Read-only provenance, price, OOS-calendar and label-leak audit.
// NEVER backfill lost signal dates or silently alter corporate-action prices.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { latestEmbargoedSignalDate } from "./strategy-audit-boundaries.mjs";

export const VERIFIED_KRX_2026_CLOSURES = Object.freeze([
  "2026-01-01","2026-02-16","2026-02-17","2026-02-18","2026-03-02",
  "2026-05-01","2026-05-05","2026-05-25","2026-06-03","2026-07-17",
  "2026-08-17","2026-09-24","2026-09-25","2026-10-05","2026-10-09",
  "2026-12-25","2026-12-31"
]);
const finite=(v)=>v!==null && v!==undefined && Number.isFinite(Number(v));
const iso=(s)=>/^\d{8}$/.test(s)?`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6)}`:s;
const compact=(s)=>String(s).replaceAll("-","");
const pct=(x)=>Math.round(x*1000)/1000;
const LIMIT=25;

export function calendarMissingDays(dates, holidays=VERIFIED_KRX_2026_CLOSURES) {
  const observed=[...new Set((dates||[]).map(iso))].sort();
  if(observed.length<2)return [];
  const closed=new Set(holidays),actual=new Set(observed),missing=[];
  const start=new Date(observed[0]+"T00:00:00Z");
  const end=new Date(observed.at(-1)+"T00:00:00Z");
  for(let t=start.getTime();t<=end.getTime();t+=86400000){
    const dt=new Date(t);
    const day=dt.getUTCDay(),date=dt.toISOString().slice(0,10);
    if(day!==0&&day!==6&&!closed.has(date)&&!actual.has(date))missing.push(date);
  }
  return missing;
}
export function auditLabelChronology(observations,holds=[3,5,10,20]) {
  const violations=[],counters={completeLabels:0,missingLabels:0,signalLaterThanEntry:0,entryLaterThanExit:0,duplicateRows:0,missingDate:0};
  const seen=new Set();
  const byCode=new Map();
  for(const row of observations){
    const key=`${row.date}|${row.market}|${row.code}`;
    if(seen.has(key)) {counters.duplicateRows++;if(violations.length<LIMIT)violations.push({kind:"DUPLICATE_OBSERVATION",code:row.code,date:iso(row.date)});}
    seen.add(key);
    if(!/^\d{8}$/.test(String(row.date)))counters.missingDate++;
    const prev=byCode.get(row.code);
    if(prev && row.date<=prev)counters.duplicateRows++;
    byCode.set(row.code,row.date);
    for(const h of holds){
      const amount=row[`r${h}`],entry=row[`entryDate${h}`],exit=row[`exitDate${h}`];
      if(!finite(amount)){counters.missingLabels++;continue;}
      counters.completeLabels++;
      if(!entry||compact(iso(entry))<=row.date){
        counters.signalLaterThanEntry++;
        if(violations.length<LIMIT)violations.push({kind:"ENTRY_NOT_AFTER_SIGNAL",code:row.code,date:iso(row.date),hold:h,entry:iso(entry||"")});
      }
      if(!exit || compact(iso(exit))<compact(iso(entry||""))){
        counters.entryLaterThanExit++;
        if(violations.length<LIMIT)violations.push({kind:"EXIT_BEFORE_ENTRY",code:row.code,date:iso(row.date),hold:h,entry:iso(entry||""),exit:iso(exit||"")});
      }
    }
  }
  return {counters,examples:violations,chronologyPass:!counters.signalLaterThanEntry&&!counters.entryLaterThanExit&&!counters.duplicateRows&&!counters.missingDate};
}
function groupCounts(items,key){
  const m=new Map();
  for(const v of items)m.set(key(v),(m.get(key(v))||0)+1);
  return [...m.entries()].sort((a,b)=>b[1]-a[1]).map(([id,n])=>({id,n}));
}
export function auditRetrospective({matrix,cacheFolder,oosSignalDates=[],featureSource=""}) {
  const observations=matrix.observations||[], universe=matrix.universe||[];
  const dates=[...new Set(observations.map(r=>r.date))].sort();
  const codes=[...new Set(observations.map(r=>r.code))];
  const first=iso(dates[0]),last=iso(dates.at(-1));
  const countsByMarket=groupCounts(universe,x=>x.market);
  const observationsByMarket=groupCounts(observations,x=>x.market);
  const rowDup=auditLabelChronology(observations,matrix.holds||[3,5,10,20]);
  const allCodeDates=new Set(observations.map(r=>`${r.date}|${r.code}`));
  let matrixExpected=universe.length*dates.length;
  const matrixMissing=matrixExpected-allCodeDates.size;
  const anomalies=[],count={cacheFiles:0,cacheMissingTickers:0,ohlcInvalid:0,nonpositivePrice:0,duplicateQuoteDate:0,
    dateOrderErrors:0,splitLikeMove45:0,extremeDailyLoss70:0,extremeDailyGain200:0,quoteBarCount:0};
  const files=readdirSync(cacheFolder);
  const bestFiles=new Map();
  for(const name of files){
    const match=/^price-(\d{6})-(\d{8})-(\d{8})\.json$/.exec(name);
    if(!match)continue;
    const [_,code,from,to]=match,prior=bestFiles.get(code);
    if(!prior || (to>prior.to ||(to===prior.to&&from<prior.from)))bestFiles.set(code,{name,from,to});
  }
  const splitByCode=new Map();
  for(const stock of universe){
    const info=bestFiles.get(stock.code);
    if(!info){count.cacheMissingTickers++;continue;}
    count.cacheFiles++;
    let parsed;
    try{parsed=JSON.parse(readFileSync(path.join(cacheFolder,info.name),"utf8"));}catch{count.cacheMissingTickers++;continue;}
    const bars=parsed.value??parsed;
    if(!Array.isArray(bars)){count.cacheMissingTickers++;continue;}
    let prev=null,seen=new Set();
    for(const b of bars){
      count.quoteBarCount++;
      const values=[b.open,b.high,b.low,b.close].map(Number);
      if(!values.every(v=>Number.isFinite(v)&&v>0)){
        count.nonpositivePrice++;
        if(anomalies.length<LIMIT)anomalies.push({kind:"NONPOSITIVE_OR_MISSING_BAR",code:stock.code,date:iso(b.date)});
        continue;
      }
      const [open,high,low,close]=values;
      if(high<Math.max(open,close,low) || low>Math.min(open,close,high)){
        count.ohlcInvalid++;
        if(anomalies.length<LIMIT)anomalies.push({kind:"OHLC_OUT_OF_RANGE",code:stock.code,date:iso(b.date),open,high,low,close});
      }
      if(seen.has(b.date)){count.duplicateQuoteDate++;if(anomalies.length<LIMIT)anomalies.push({kind:"DUPLICATE_PRICE_DATE",code:stock.code,date:iso(b.date)});}
      seen.add(b.date);
      if(prev){
        if(b.date<=prev.date)count.dateOrderErrors++;
        if(prev.close>0){
          const dayReturn=(close/prev.close-1)*100;
          if(Math.abs(dayReturn)>=45){
            count.splitLikeMove45++;
            splitByCode.set(stock.code,(splitByCode.get(stock.code)||0)+1);
            if(anomalies.length<LIMIT)anomalies.push({kind:"SPLIT_OR_CORPORATE_ACTION_REVIEW",code:stock.code,date:iso(b.date),priorClose:prev.close,close,changePct:pct(dayReturn)});
          }
          if(dayReturn<=-70)count.extremeDailyLoss70++;
          if(dayReturn>=200)count.extremeDailyGain200++;
        }
      }
      prev=b;
    }
  }
  const labelAnomalies=[];
  const outlierByCode=new Map();
  const labelOutliers={horizons:{},count:0,negative70:0,positive200:0};
  for(const h of matrix.holds||[3,5,10,20]){
    const suspects=observations.filter(r=>finite(r[`r${h}`])&&(r[`r${h}`]<=-70||r[`r${h}`]>=200));
    labelOutliers.horizons[h]=suspects.length;
    for(const r of suspects){
      labelOutliers.count++;
      if(r[`r${h}`]<=-70)labelOutliers.negative70++;
      else labelOutliers.positive200++;
      outlierByCode.set(r.code,(outlierByCode.get(r.code)||0)+1);
      if(labelAnomalies.length<LIMIT)labelAnomalies.push({code:r.code,market:r.market,signalDate:iso(r.date),horizon:h,returnPct:pct(r[`r${h}`])});
    }
  }
  const oosDates=[...new Set(oosSignalDates.map(iso))].sort();
  const missingOos=calendarMissingDays(oosDates);
  const sourceFindings={
    pointInTimeHistorySlice:/series\.slice\(0, i \+ 1\)/.test(featureSource),
    presentDayShareCountUsedHistorically:/const listedShares = quote\?\.listedShares/.test(featureSource)
      && /listedShares \* r\.close/.test(featureSource),
    usesFixed100Universe:/universe-\$\{market\}-100\.json/.test(featureSource)
  };
  const controls={
    needsHistoricalMembership:sourceFindings.usesFixed100Universe,
    potentialQuoteShareLookahead:sourceFindings.presentDayShareCountUsedHistorically,
    pointInTimeIndicatorSlicingFound:sourceFindings.pointInTimeHistorySlice,
    labelDateConsistency:rowDup.chronologyPass,
    missingRawOosDates:missingOos.length,
    unresolvedExtremes:labelOutliers.count+count.splitLikeMove45+count.ohlcInvalid,
    biasCanBeCorrectedFromThisCache:false
  };
  const checks=[
    {id:"SURVIVORSHIP",label:"과거 종목 선정·생존자 편향",status:controls.needsHistoricalMembership?"FAIL":"UNKNOWN",message:"2026 고정 200종목 명단을 2024년까지 소급 적용. 과거 시점 상장·퇴출 전체종목 원장 없음"},
    {id:"CORPORATE_ACTION",label:"급등락·액면분할·권리락 의심가격",status:controls.unresolvedExtremes?"FAIL":"PASS",message:"수정주가·기업행사 원본 대조 없이 급변 가격을 자동 보정해서는 안 됨"},
    {id:"MISSING_OOS",label:"OOS 장마감 거래일 누락",status:missingOos.length?"FAIL":"PASS",message:"KRX 2026 휴장일을 제외하고 실제 기록 없는 거래일만 표시. 사후 보충해도 원래의 실시간 OOS가 되지 않음"},
    {id:"FUTURE_LABEL",label:"진입·청산 순서 및 구간 경계",status:rowDup.chronologyPass?"PASS":"FAIL",message:"시그널 이후 시가진입, 미래 청산 날짜 검증. 독립 매매조건 교차검증은 21거래일 격리 필요"},
    {id:"PIT_FEATURES",label:"과거 피처 미래정보 혼입",status:controls.potentialQuoteShareLookahead?"FAIL":controls.pointInTimeIndicatorSlicingFound?"WARN":"UNKNOWN",message:"가격지표 계산은 과거까지 잘랐지만 당대가 아닌 상장주식수와 사후 고정 종목 선정이 사용됨"}
  ];
  return {
    schema:"strategy-data-integrity-audit-v1",
    generatedAt:new Date().toISOString(),
    input:{matrixStart:iso(matrix.startDate),matrixEnd:iso(matrix.endDate),observedStart:first,observedEnd:last,
      matrixUniverse:universe.length,matrixUniverseByMarket:countsByMarket,observedCodes:codes.length,
      observedTradingDates:dates.length,matrixRows:observations.length,observationsByMarket,
      theoreticalRows:matrixExpected,missingCodeDateRows:matrixMissing},
    labels:rowDup,rawPrices:{totals:count,suspectExample:anomalies,suspectByStock:[...splitByCode].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([code,n])=>({code,n}))},
    futureReturnExtremes:{...labelOutliers,example:labelAnomalies,
      topCodes:[...outlierByCode].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([code,n])=>({code,n}))},
    oosCalendar:{observedDates:oosDates,first:oosDates[0]??null,last:oosDates.at(-1)??null,
      holidaySource:"https://open.krx.co.kr/contents/MKD/01/0110/01100305/MKD01100305.jsp",
      corroboration:"https://atsview.com/calendar/2026",holidaysApplied:VERIFIED_KRX_2026_CLOSURES,
      missingExpectedTradingDates:missingOos,holidayExcluded:true},
    sourceFindings,controls,checks,
    gates:{historicalBacktestApprovedForLiveStrategySelection:false,forwardOosDataComplete:missingOos.length===0,
      historicalPriceEventsCleared:false,lookaheadCleared:false,liveAutotradingPermitted:false},
    nextActions:[
      "KRX 또는 신뢰할 수 있는 가격공급원의 과거 시점 전체 상장·폐지 종목 명단을 별도로 확보",
      "권리락/액면분할/상장폐지 후보를 거래소 공시 및 수정주가 이력과 종목별 대조",
      "누락 신호일 원인을 EOD 수집기 로그에서 확인·복구; 과거 OOS 원장은 소급 생성 금지",
      "현재 상장주식수를 과거 리플레이에 쓰지 말고 과거 시점 발행주식수로 교체",
      "21거래일 purge한 훈련/검증 분리로 매매 실험 전량 재실행",
      "시장전체/PIT 가격 이력으로 재검증하기 전 실전 자동주문 금지"
    ]
  };
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [matrixFile,cacheFolder,oosDatesFile,outFile]=process.argv.slice(2);
  if(!matrixFile||!cacheFolder||!oosDatesFile||!outFile){
    console.error("Usage: node strategy-data-quality-audit.mjs <matrix.json> <price-cache-dir> <oos-snapshot.json> <output.json>");
    process.exitCode=2;
  }else{
    const matrix=JSON.parse(readFileSync(matrixFile,"utf8"));
    const oos=JSON.parse(readFileSync(oosDatesFile,"utf8"));
    const source=readFileSync(new URL("./backtest-v3/features.mjs",import.meta.url),"utf8");
    const report=auditRetrospective({matrix,cacheFolder,oosSignalDates:oos.meta?.signalDates??oos.signalDates??[],featureSource:source});
    writeFileSync(outFile,JSON.stringify(report),"utf8");
    console.log(JSON.stringify({report:outFile,checks:report.checks,prices:report.rawPrices.totals,
      extremes:report.futureReturnExtremes.count,missingOos:report.oosCalendar.missingExpectedTradingDates,
      chronology:report.labels.counters,source:report.sourceFindings},null,2));
  }
}
