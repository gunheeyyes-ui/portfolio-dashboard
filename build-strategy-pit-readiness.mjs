// Strict readiness report: never mistake fixed 200-stock history for PIT all-market data.
import {readFileSync,writeFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {readValidatedKrxSnapshots,validateHistoricalKrxCoverage} from "./krx-pit-universe.mjs";

export function buildPitReadiness(matrix,pitFolder,{keyConfigured=false}={}){
  const dates=[...new Set(matrix.observations.map(x=>x.date))].sort();
  const loaded=readValidatedKrxSnapshots(pitFolder,dates,{minCount:500});
  const coverage=validateHistoricalKrxCoverage(loaded.files,dates,{minCount:500});
  const status=coverage.readyForPitRebuild?"PIT_COVERAGE_READY_FOR_NEXT_STAGE":
    !keyConfigured?"BLOCKED_SOURCE_CREDENTIALS_AND_COVERAGE":"BLOCKED_HISTORICAL_COVERAGE";
  return {
    schema:"strategy-pit-source-readiness-v1",
    generatedAt:new Date().toISOString(),
    source:"KRX_OPEN_API_FULL_MARKET_DAILY",
    credentialConfigured:keyConfigured,
    acquisitionURL:"https://openapi.krx.co.kr/contents/OPP/INFO/OPPINFO003.jsp",
    endpoints:["stk_bydd_trd","ksq_bydd_trd"],
    expectedFrom:dates[0],expectedThrough:dates.at(-1),
    ...coverage,corruptOrUntrustedFiles:loaded.invalid,
    status,
    historicalExperimentReleasedForLiveTrading:false,
    note:"Completing daily KRX snapshots only clears whole-market coverage. Adjusted-price and company action checks remain separate gates."
  };
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const matrixPath=process.argv[2],pitDir=process.argv[3],out=process.argv[4];
  if(!matrixPath||!pitDir||!out)throw Error("Usage: node build-strategy-pit-readiness.mjs <matrix> <KRX-PIT-folder> <report.json>");
  const result=buildPitReadiness(JSON.parse(readFileSync(matrixPath,"utf8")),pitDir,{keyConfigured:Boolean(process.env.KRX_AUTH_KEY)});
  writeFileSync(out,JSON.stringify(result),"utf8");
  console.log(JSON.stringify({status:result.status,requiredDays:result.requiredDays,validatedFiles:result.validatedDailyFiles,
    missingFiles:result.missingFileCount,invalidFiles:result.invalidFileCount,
    realOrdersAllowed:result.historicalExperimentReleasedForLiveTrading},null,2));
}
