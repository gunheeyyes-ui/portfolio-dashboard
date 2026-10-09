import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
 normalizeKrxMarketRows,validateHistoricalKrxCoverage,collectKrxDaily,readValidatedKrxSnapshots
} from "./krx-pit-universe.mjs";
import {buildPitReadiness} from "./build-strategy-pit-readiness.mjs";
import {classifyOosGaps} from "./public/strategy-oos-gap-reasons.js";
const outliers=JSON.parse(readFileSync(new URL("./public/strategy-extreme-price-evidence.json",import.meta.url),"utf8"));
const pitReport=JSON.parse(readFileSync(new URL("./public/strategy-pit-readiness.json",import.meta.url),"utf8"));
const date="20240919";
const response=(market,n)=>({OutBlock_1:Array.from({length:n},(_,i)=>({
 BAS_DD:date,ISU_CD:String(i+1).padStart(6,"0"),ISU_NM:`${market}-${i}`,
 TDD_OPNPRC:"10000",TDD_HGPRC:"10100",TDD_LWPRC:"9900",TDD_CLSPRC:"10050",
 ACC_TRDVOL:"1000",ACC_TRDVAL:"10000000",MKTCAP:"1005000000",LIST_SHRS:"100000"
}))});
test("KRX daily snapshot importer rejects incomplete universe and corrupt inputs",()=>{
 assert.throws(()=>normalizeKrxMarketRows(response("KOSPI",499),{date,market:"KOSPI"}),/COVERAGE_INVALID/);
 const wrong=response("KOSPI",500);wrong.OutBlock_1[0].BAS_DD="20241001";
 assert.throws(()=>normalizeKrxMarketRows(wrong,{date,market:"KOSPI"}),/COVERAGE_INVALID/);
});
test("official KRX one-day dual-market collector preserves point-in-time listed shares without credentials on disk",async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),"pit-krx-test-"));
 try{
  let calls=0;
  const fetchStub=async url=>{calls++;return {ok:true,json:async()=>response(url.includes("ksq_bydd_trd")?"KOSDAQ":"KOSPI",500)};};
  await assert.rejects(collectKrxDaily({date,rootDir:dir,authKey:"",fetchImpl:fetchStub}),/KRX_AUTH_KEY_NOT_CONFIGURED/);
  assert.equal(calls,0);
  const r=await collectKrxDaily({date,rootDir:dir,authKey:"fake-not-prod",fetchImpl:fetchStub});
  assert.equal(r.complete,true);
  assert.equal(calls,2);
  const read=readValidatedKrxSnapshots(dir,[date]);
  const ready=validateHistoricalKrxCoverage(read.files,[date]);
  assert.equal(ready.readyForPitRebuild,true);
  assert.equal(ready.validatedDailyFiles,2);
  assert.equal(read.files.get(`${date}|KOSPI`).rows[0].listedShares,100000);
  assert.ok(!JSON.stringify(read.files.get(`${date}|KOSPI`)).includes("fake-not-prod"));
  const readyReport=buildPitReadiness({observations:[{date}]},dir,{keyConfigured:true});
  assert.equal(readyReport.readyForPitRebuild,true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("without authentic source data current 459-day backtest is NOT PIT qualified",()=>{
 assert.equal(pitReport.requiredDays,459);
 assert.equal(pitReport.expectedDailyFiles,918);
 assert.equal(pitReport.validatedDailyFiles,0);
 assert.equal(pitReport.readyForPitRebuild,false);
 assert.equal(pitReport.status,"BLOCKED_SOURCE_CREDENTIALS_AND_COVERAGE");
 assert.equal(pitReport.historicalExperimentReleasedForLiveTrading,false);
});
test("all 94 large returns arithmetically tie to locally cached OHLC, external verification stays pending",()=>{
 assert.equal(outliers.summary.extremeLabels,94);
 assert.equal(outliers.summary.internalPriceMatches,94);
 assert.equal(outliers.summary.affectedStocks,11);
 assert.equal(outliers.summary.mismatchCount,0);
 assert.equal(outliers.summary.thirdPartyValidatedCount,0);
 assert.ok(outliers.windows.every(w=>w.reviewStatus==="UNVERIFIED_EXTERNAL_PRICE_OR_CORPORATE_ACTION"));
 assert.ok(outliers.priorityStocks.find(s=>s.code==="950160").suspiciousLabels===27);
});
test("OOS unknown missing days aren't inferred from September 15 quarantine event",()=>{
 const days=["2026-09-15","2026-09-16","2026-10-06"];
 const sample=[{signalDate:days[0],reason:"QUARANTINED_INCOMPLETE_MARKET_REFRESH",
   marketCounts:{KOSPI:29,KOSDAQ:30},removed:{strategyRecords:60,strategySelections:214}}];
 const x=classifyOosGaps(days,sample);
 assert.equal(x.confirmedQuarantine,1);
 assert.equal(x.unresolved,2);
 assert.equal(x.rows[0].removed.strategyRecords,60);
 assert.ok(x.rows.slice(1).every(y=>y.status==="CAUSE_UNVERIFIED"));
});
