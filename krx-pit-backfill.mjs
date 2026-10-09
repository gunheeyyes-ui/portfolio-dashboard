// Resumable official KRX all-market daily collection. No auth secret persistence.
// Run deliberately, in a foreground shell. Optional --max-days 4 for cautious batches.
import {readFileSync} from "node:fs";
import {collectKrxDaily,readValidatedKrxSnapshots} from "./krx-pit-universe.mjs";
import path from "node:path";
import {fileURLToPath} from "node:url";
const sleep=(ms)=>new Promise(done=>setTimeout(done,ms));
export async function collectHistoricalKrxDates({
  dates,rootDir,authKey,maxDays=4,delayMs=1500,collector=collectKrxDaily,onProgress=()=>{}
}){
  if(!authKey)throw Error("KRX_AUTH_KEY_NOT_CONFIGURED: first approve stk_bydd_trd and ksq_bydd_trd APIs");
  if(!Number.isInteger(maxDays)||maxDays<1)throw Error("MAX_DAYS_INVALID");
  let completed=0,skippedExisting=0;
  const results=[];
  for(const date of [...new Set(dates)].sort()){
    const available=readValidatedKrxSnapshots(rootDir,[date]);
    if(available.files.size===2){skippedExisting++;continue;}
    if(completed>=maxDays)break;
    const batch=await collector({date,rootDir,authKey});
    if(!batch.complete)throw Error("INCOMPLETE_MARKET_"+date);
    completed++;
    results.push({date,markets:batch.markets.map(x=>({market:x.market,count:x.count,skippedCached:x.skippedCached}))});
    onProgress({completed,maxNewDays:maxDays,skippedExisting,date,markets:batch.markets.length});
    if(completed<maxDays)await sleep(delayMs);
  }
  return {completed,skippedExisting,requestedDays:dates.length,results,readyForLiveOrders:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [matrixPath,rootDir,arg]=process.argv.slice(2);
  if(!matrixPath||!rootDir)throw Error("Usage: node krx-pit-backfill.mjs <matrix.json> <output-dir> [maxDays=4]");
  const matrix=JSON.parse(readFileSync(matrixPath,"utf8"));
  const dates=[...new Set(matrix.observations.map(x=>x.date))].sort();
  collectHistoricalKrxDates({
    dates,rootDir,authKey:process.env.KRX_AUTH_KEY,maxDays:Math.min(459,Math.max(1,Number(arg||4))),
    onProgress:x=>console.log(JSON.stringify({progress:x}))
  }).then(x=>console.log(JSON.stringify({status:"DONE",...x}))).catch(e=>{console.error(e.message);process.exitCode=1});
}
