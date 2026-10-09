// Trace extreme 3/5/10/20D labels to exact cached OHLC bars.
// An internally reconciled label is NOT externally verified market data.
import {readFileSync,readdirSync,writeFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
const costs=(a,b)=>Number((a-b).toFixed(4));
export function investigateExtremeReturns(matrix,cacheFolder,{thresholdLoss=-70,thresholdGain=200}={}){
  const obs=matrix.observations||[],universe=matrix.universe||[],holds=matrix.holds||[3,5,10,20],fee=Number(matrix.costPct||0.23);
  const candidates=[];
  for(const row of obs)for(const h of holds){
    const net=row[`r${h}`];
    if(typeof net==="number"&&(net<=thresholdLoss||net>=thresholdGain))
      candidates.push({row,h,net});
  }
  const files=readdirSync(cacheFolder);
  const barsByCode=new Map();
  const metadataByCode=new Map(universe.map(x=>[x.code,x]));
  const load=(code)=>{
    if(barsByCode.has(code))return barsByCode.get(code);
    const matching=files.filter(x=>x.startsWith(`price-${code}-`)&&x.endsWith(".json")).sort().reverse();
    if(!matching.length){barsByCode.set(code,new Map());return barsByCode.get(code);}
    const raw=JSON.parse(readFileSync(path.join(cacheFolder,matching[0]),"utf8"));
    const data=Array.isArray(raw)?raw:raw.value||[];
    const map=new Map(data.map(x=>[x.date,x]));
    barsByCode.set(code,map);return map;
  };
  const evidence=[],codes=new Map();
  for(const {row,h,net} of candidates){
    const bars=load(row.code);
    const entryDate=row[`entryDate${h}`],exitDate=row[`exitDate${h}`];
    const entry=bars.get(entryDate),exit=bars.get(exitDate);
    const chronological=[...bars.values()].filter(x=>x.date>=entryDate&&x.date<=exitDate).sort((a,b)=>a.date.localeCompare(b.date));
    let minDaily=Infinity,maxDaily=-Infinity,prev=null;
    for(const bar of chronological){
      if(prev?.close>0){const day=(bar.close/prev.close-1)*100;minDaily=Math.min(minDaily,day);maxDaily=Math.max(maxDaily,day);}
      prev=bar;
    }
    const derived=entry?.open>0&&exit?.close>0?(exit.close/entry.open-1)*100-fee:null;
    const drift=derived===null?null:costs(derived,net);
    const internallyConsistent=drift!==null&&Math.abs(drift)<0.03;
    const e={
      code:row.code,name:row.name,market:row.market,signalDate:row.date,horizon:h,
      entryDate,exitDate,entryOpen:entry?.open??null,exitClose:exit?.close??null,
      cacheNetPct:net,derivedNetPct:derived===null?null:Number(derived.toFixed(3)),
      differencePct:drift,internallyConsistent,
      marketBarCount:chronological.length,largestOneDayRisePct:maxDaily===-Infinity?null:Number(maxDaily.toFixed(2)),
      largestOneDayFallPct:minDaily===Infinity?null:Number(minDaily.toFixed(2)),
      // A large cumulative move may be a legitimate sequence of limit up/down days.
      reviewStatus:"UNVERIFIED_EXTERNAL_PRICE_OR_CORPORATE_ACTION",
      externalPriceEvidenceAvailable:false
    };
    evidence.push(e);
    const rowAgg=codes.get(row.code)||{
      code:row.code,name:metadataByCode.get(row.code)?.name||row.name,market:row.market,
      suspiciousLabels:0,internallyConsistent:0,firstSignalDate:row.date,lastSignalDate:row.date,holdHorizons:new Set()
    };
    rowAgg.suspiciousLabels++;
    if(internallyConsistent)rowAgg.internallyConsistent++;
    rowAgg.firstSignalDate=rowAgg.firstSignalDate<row.date?rowAgg.firstSignalDate:row.date;
    rowAgg.lastSignalDate=rowAgg.lastSignalDate>row.date?rowAgg.lastSignalDate:row.date;
    rowAgg.holdHorizons.add(h);
    codes.set(row.code,rowAgg);
  }
  const stocks=[...codes.values()].map(x=>({...x,holdHorizons:[...x.holdHorizons].sort((a,b)=>a-b)}))
    .sort((a,b)=>b.suspiciousLabels-a.suspiciousLabels||a.code.localeCompare(b.code));
  return {
    schema:"strategy-extreme-price-evidence-v1",generatedAt:new Date().toISOString(),
    origin:"KIS historical OHLC cache / 0.23%-cost future labels. Source is NOT independent corroboration.",
    usesAdjustedHistoryFlag:"FID_ORG_ADJ_PRC=0 used by historical KIS collection (inquire-daily-itemchartprice), per endpoint documentation",
    matrix:{startDate:matrix.startDate,endDate:matrix.endDate,horizons:holds,costPct:fee},
    summary:{extremeLabels:candidates.length,affectedStocks:stocks.length,internalPriceMatches:evidence.filter(x=>x.internallyConsistent).length,
      mismatchCount:evidence.filter(x=>!x.internallyConsistent).length,thirdPartyValidatedCount:0},
    priorityStocks:stocks,windows:evidence,
    disclaimer:"Extreme multi-day cumulative moves can occur without a one-day split-like discontinuity. This evidence verifies arithmetic only, NOT corporate actions, quoted source independence, or investable execution.",
    mayBeUsedForLiveOrders:false
  };
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [matrixPath,cacheFolder,outputPath]=process.argv.slice(2);
  if(!matrixPath||!cacheFolder||!outputPath)throw Error("Usage: node strategy-extreme-price-evidence.mjs matrix.json cachedir output.json");
  const output=investigateExtremeReturns(JSON.parse(readFileSync(matrixPath,"utf8")),cacheFolder);
  writeFileSync(outputPath,JSON.stringify(output),"utf8");
  console.log(JSON.stringify({out:outputPath,summary:output.summary,stockLeaders:output.priorityStocks.slice(0,7)},null,2));
}
