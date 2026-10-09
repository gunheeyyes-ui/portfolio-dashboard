import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { latestEmbargoedSignalDate, timeSafePeriods } from "./strategy-audit-boundaries.mjs";
import { calendarMissingDays, auditLabelChronology } from "./strategy-data-quality-audit.mjs";
import { expectedMissingKrxDays, evaluateResearchQualityGate } from "./public/strategy-quality-gate.js";
import { classifyOutcomeIntegrity } from "./market-integrity.js";

const report=JSON.parse(readFileSync(new URL("./public/strategy-data-quality.json",import.meta.url),"utf8"));
const grid=JSON.parse(readFileSync(new URL("./public/strategy-experiments.json",import.meta.url),"utf8"));

test("2026 KRX holidays excluded from missing OOS count, thirteen gaps remain",()=>{
 assert.equal(report.oosCalendar.missingExpectedTradingDates.length,13);
 assert.deepEqual(report.oosCalendar.missingExpectedTradingDates,
   expectedMissingKrxDays(report.oosCalendar.observedDates));
 assert.deepEqual(report.oosCalendar.missingExpectedTradingDates,
   calendarMissingDays(report.oosCalendar.observedDates));
 for(const day of ["2026-09-24","2026-09-25","2026-10-05"])assert.ok(!report.oosCalendar.missingExpectedTradingDates.includes(day));
});

test("audit confirms 200-stock bias and reports price quality without falsely claiming verified adjustment",()=>{
 assert.equal(report.input.matrixUniverse,200);
 assert.equal(report.input.matrixRows,90909);
 assert.equal(report.rawPrices.totals.quoteBarCount,209609);
 assert.equal(report.rawPrices.totals.ohlcInvalid,0);
 assert.ok(report.futureReturnExtremes.count>0);
 assert.equal(report.gates.historicalBacktestApprovedForLiveStrategySelection,false);
 assert.equal(report.gates.lookaheadCleared,false);
 assert.ok(report.checks.find(x=>x.id==="SURVIVORSHIP"&&x.status==="FAIL"));
 assert.ok(report.sourceFindings.presentDayShareCountUsedHistorically);
});

test("chronology validator catches deliberate future leakage / duplicated date",()=>{
 const base={date:"20260107",market:"KOSPI",code:"000001",r10:2,entryDate10:"20260108",exitDate10:"20260122"};
 assert.equal(auditLabelChronology([base],[10]).chronologyPass,true);
 const leak={...base,entryDate10:"20260106"};
 const fail=auditLabelChronology([leak,leak],[10]);
 assert.equal(fail.chronologyPass,false);
 assert.ok(fail.counters.signalLaterThanEntry>0);
 assert.ok(fail.counters.duplicateRows>0);
});

test("21 market-day purge prevents training and validation labels from crossing next split",()=>{
 const sessions=Array.from({length:100},(_,i)=>String(20261000+i).padStart(8,"0"));
 assert.equal(latestEmbargoedSignalDate(sessions,sessions[50],20),sessions[29]);
 const periods=timeSafePeriods({sessions,trainEnd:sessions[35],validationStart:sessions[36],
   validationEnd:sessions[70],holdoutStart:sessions[71],finalSignalDate:sessions[99],maxHoldTradingDays:20});
 assert.equal(periods[0].to,sessions[14]);
 assert.equal(periods[1].to,sessions[49]);
 assert.equal(grid.periods[0].boundaryDate,"20250801");
 assert.ok(grid.periods[0].to<grid.periods[0].boundaryDate);
 assert.ok(grid.periods[1].to<grid.periods[1].boundaryDate);
});

test("unverified extreme 10-day OOS return is quarantined, older 3-day comparable remains",()=>{
 const r={signalDate:"2026-09-07",market:"KOSPI",code:"000001",signalPrice:10000,entryOpen:10000,
   outcomes:{"3":{netReturnPct:1.77,grossReturnPct:2,exitPrice:10200},
   "10":{netReturnPct:-75, grossReturnPct:-74.77,exitPrice:2523}}};
 assert.equal(classifyOutcomeIntegrity(r,3).comparable,true);
 const flagged=classifyOutcomeIntegrity(r,10);
 assert.equal(flagged.comparable,false);
 assert.ok(flagged.reasons.includes("EXTREME_RETURN_NEEDS_PRICE_REVIEW"));
});

test("missing or failed audit fails closed without approving any live order",()=>{
 assert.equal(evaluateResearchQualityGate(null,report.oosCalendar.observedDates).status,"BLOCKED");
 assert.equal(evaluateResearchQualityGate(report,null).liveOrderEligible,false);
 const gate=evaluateResearchQualityGate(report,report.oosCalendar.observedDates);
 assert.equal(gate.status,"BLOCKED");
 assert.equal(gate.liveOrderEligible,false);
 assert.equal(gate.missingDates.length,13);
});

test("PIT full-market correction uses 441 historical daily universes and rejects fixed 200 universe for forward conclusions",()=>{
  const pit=JSON.parse(readFileSync(new URL("./public/strategy-pit-price-only.json",import.meta.url),"utf8"));
  assert.equal(pit.schema,"pit-price-only-rs20-v1");
  assert.equal(pit.coverage.tradingSessions,441);
  assert.equal(pit.coverage.historicalMembershipRows,88200);
  assert.equal(pit.coverage.historicalDistinctStocks,351);
  assert.equal(pit.coverage.historicalStocksAbsentFromFutureSample,151);
  const picked=(group,n,h)=>pit.experiments.find(e=>e.universe===group&&e.topN===n&&e.holdingSessions===h);
  const real=picked("HISTORICAL_AS_OF",3,10);
  const biased=picked("FUTURE_FIXED_CONTROL",3,10);
  assert.ok(real && biased);
  assert.ok(biased.averageCompletedTradePct>real.averageCompletedTradePct);
  assert.equal(pit.realMoneyApproved,false);
  assert.match(pit.method.warning,/NOT existing 107-strategy validation/);
});
