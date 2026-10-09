// Historical *reconstruction*, NOT immutable/live OOS and NOT the 428 live paper accounts.
// Read-only historical matrix + local price cache; never mutate any tracker records.
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_STRATEGY_REGISTRY, enabledStrategies } from "./strategy-oos-registry.js";
import { strategyAxes, strategyMatchesFeature } from "./public/strategy-consensus.js";
import { simulationCategory } from "./simulation-category.js";
import { buildPaperAutoModel, PAPER_AUTO_POLICY } from "./paper-auto-service.js";
import { PAPER_AUTO_ARENA_POLICY } from "./paper-auto-arena.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const matrixPath = process.argv[2];
const cachePath = process.argv[3];
const outPath = process.argv[4] || path.join(here, "backtest-results-v3", "107-strategy-historical-lab.json");
if (!matrixPath || !cachePath || !existsSync(matrixPath)) {
  console.error("Usage: node backtest-strategy-paper-lab.mjs <feature-matrix.json> <backtest-cache-v2-dir> [output.json]");
  process.exit(2);
}
const holds = [3, 5, 10, 20];
const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
const rows = matrix.observations || [];
const maxDate = [...new Set(rows.filter((r) => Number.isFinite(r.r20)).map((r) => r.date))].sort().at(-1);
const dated = rows.filter((r) => holds.every((h) =>
  Number.isFinite(r[`r${h}`]) && r[`entryDate${h}`] && r[`exitDate${h}`] && r[`exitDate${h}`] <= matrix.endDate));
const dates = [...new Set(dated.map((r) => r.date))].sort();
const split = dates[Math.floor(dates.length * 0.6)];
const trainCut = dates[Math.max(0, Math.floor(dates.length * 0.6) - 21)];
const registry = enabledStrategies();
const nameMap = new Map(registry.map((s) => [s.id, s]));
const matches = new Map(registry.map((s) => [s.id, []]));
const priceMap = new Map();
let missingPrice = 0;
const cacheFiles = readdirSync(cachePath);
const cacheLookup = new Map();
for (const name of cacheFiles) {
  const m = name.match(/^price-(\d{6})-(\d{8})-(\d{8})\.json$/);
  if (!m) continue;
  const current = cacheLookup.get(m[1]);
  if (!current || m[3] > current.to || (m[3] === current.to && m[2] < current.from)) cacheLookup.set(m[1], { name, from: m[2], to: m[3] });
}
function cachedBars(code) {
  if (priceMap.has(code)) return priceMap.get(code);
  const file = cacheLookup.get(code)?.name;
  let bars = new Map();
  if (file) {
    const parsed = JSON.parse(readFileSync(path.join(cachePath, file), "utf8"));
    bars = new Map((parsed.value ?? parsed).map((bar) => [bar.date, bar]));
  }
  priceMap.set(code, bars);
  return bars;
}
function feature(row) {
  const flags = Object.fromEntries(["R","F","F2","B","C","H2","H3","I"].map((k) => [k, row[k] === true]));
  const sim = simulationCategory({
    changeRate: row.changeRate, changeRate3d: row.changeRate3d,
    strategy: { flags, overheat: row.overheat },
    supply: {
      liquidityScore: row.liquidityScore, foreignStreak: row.foreignStreak, instStreak: row.instStreak,
      smartMoneyBodyPct: row.smartMoneyBodyPct, smartMoneyTradingSharePct: row.smartMoneyTradingSharePct,
      tradingValueRatio20: row.tradingValueRatio20
    }
  });
  return {
    leaderRank: row.leaderGrade === "계산불가" ? null : row.leaderRank,
    leaderScore: row.leaderScore, leaderGrade: row.leaderGrade === "계산불가" ? null : row.leaderGrade,
    rs20: row.rs20, rsRank: null, combinedRank: row.combinedRank,
    combinedScore: row.combinedScore, combinedDecision: row.combinedLabel === "계산불가" ? null : row.combinedLabel,
    rankingV2Tier: row.rankingTier, rankingV2Rank: row.rankingV2Rank,
    scoutRank: row.scoutRank, scoutStatus: row.scoutStatus === "계산불가" ? null : row.scoutStatus,
    reboundStatus: row.reboundStateKey,
    drawdownPct: row.drawdownFromHighPct, riskScore: row.scoutRiskScore,
    stabilizeScore: row.scoutStabilizeScore, liquidityScore: row.liquidityScore,
    flags, cafe: row.cafePass, mtt: row.minerviniPass, leaderRebound: row.leaderReboundPass,
    deepRecovery: row.deepRecoveryPass, actionable: sim.actionable,
    simCategory: sim.key,
    market: row.market, code: row.code
  };
}
const rowFeatures = dated.map((row) => ({ row, f: feature(row) }));
const byDay = new Map();
for (const item of rowFeatures) {
  const key = item.row.date + "|" + item.row.market;
  if (!byDay.has(key)) byDay.set(key, []);
  byDay.get(key).push(item);
}
for (const group of byDay.values()) {
  group.filter((item) => Number.isFinite(item.f.rs20))
    .sort((a, b) => b.f.rs20 - a.f.rs20 || a.row.code.localeCompare(b.row.code))
    .forEach((item, idx) => { item.f.rsRank = idx + 1; });
}
let evaluated = 0;
for (const { row, f } of rowFeatures) {
  row._historicalRsRank = f.rsRank;
  const base = BASE_STRATEGY_REGISTRY.filter((s) => strategyMatchesFeature(s, f));
  const axes = new Set(base.flatMap(strategyAxes));
  const ids = new Set(base.map((s) => s.id));
  f.strategyMatchCount = base.length;
  f.strategyAxisCount = axes.size;
  f.strategyHasLeaderAxis = axes.has("leader");
  f.strategyHasRsAxis = axes.has("rs");
  for (const strategy of registry) {
    if (ids.has(strategy.id) || (strategy.group === "consensus" && strategyMatchesFeature(strategy, f))) {
      matches.get(strategy.id).push(row);
    }
  }
  evaluated++;
}
console.log(JSON.stringify({phase:"selection",evaluated,strategies:registry.length,dateCount:dates.length,from:dates[0],to:dates.at(-1),split,trainCut,matrixRows:rows.length,eligibleRows:dated.length}));

function runOne(strategy, horizon, period) {
  const selected = matches.get(strategy.id).filter((r) => {
    if (period === "train") return r.date < trainCut;
    if (period === "test") return r.date >= split;
    return true;
  });
  const records = [];
  const selections = new Map();
  let skippedGap = 0;
  let skippedMissingBar = 0;
  for (const r of selected) {
    const prices = cachedBars(r.code);
    const entry = prices.get(r[`entryDate${horizon}`]);
    const signal = prices.get(r.date);
    if (!entry?.open || !signal?.close) { skippedMissingBar++; continue; }
    const gapPct = (Number(entry.open) / Number(signal.close) - 1) * 100;
    if (Math.abs(gapPct) >= 45) { skippedGap++; continue; }
    const item = {
      signalDate: `${r.date.slice(0,4)}-${r.date.slice(4,6)}-${r.date.slice(6)}`,
      code: r.code, market: r.market, name: r.name,
      signalPrice: Number(signal.close), entryOpen: Number(entry.open), entryDate: r[`entryDate${horizon}`],
      factors: { liquidityScore: r.liquidityScore, leaderRank: r.leaderRank, rs20: r.rs20 },
      outcomes: { [String(horizon)]: {
        targetTradingDate: r[`exitDate${horizon}`], netReturnPct: r[`r${horizon}`],
        grossReturnPct: r[`r${horizon}`] + Number(matrix.costPct || 0.23)
      } },
      live: null
    };
    records.push(item);
    const key = item.signalDate+"|"+item.market;
    if (!selections.has(key)) selections.set(key, {
      signalDate: item.signalDate, market: item.market, strategyId:"HIST_"+strategy.id, members:[]
    });
    selections.get(key).members.push({code:r.code,rank:0});
  }
  // Ranking strategies use their actual historical rank, condition strategies use
  // a stable deterministic tie-breaker (not a hypothetical look-ahead alpha score).
  const rank = strategy.type==="ranking" ? ({leader:"leaderRank",rs:"_historicalRsRank",timing:"combinedRank",rankingV2:"rankingV2Rank",scout:"scoutRank"}[strategy.ranker]) : null;
  const details = new Map(selected.map((r) => [r.date+"|"+r.market+"|"+r.code,r]));
  for (const s of selections.values()) {
    s.members.sort((a,b)=>{
      const keyA=s.signalDate.replaceAll("-","")+"|"+s.market+"|"+a.code;
      const keyB=s.signalDate.replaceAll("-","")+"|"+s.market+"|"+b.code;
      return (rank ? Number(details.get(keyA)?.[rank] ?? 999999) - Number(details.get(keyB)?.[rank] ?? 999999) : 0) || a.code.localeCompare(b.code);
    });
    s.members.forEach((m,i)=>{m.rank=i+1;});
  }
  const policy = {
    ...PAPER_AUTO_POLICY,
    id:`historical-reconstruction-${strategy.id}-${horizon}d-${period}`,
    sourceStrategyId:"HIST_"+strategy.id,
    startSignalDate: "2024-09-19",
    holdTradingDays: horizon,
    exitMode:"fixed-hold",
    stopLossPct:null,takeProfitPct:null,
    trackerRoundTripCostPct: matrix.costPct,
    slippageByLiquidity: PAPER_AUTO_ARENA_POLICY.slippageByLiquidity,
    extraExecutionSlippagePct:PAPER_AUTO_ARENA_POLICY.slippageByLiquidity.midPct,
    initialCapital:100_000_000,maxPositions:10,positionBudget:10_000_000,
    backfillBeforeStart:true,
    aiRole:"observe-only"
  };
  const model = buildPaperAutoModel({ records, selections:[...selections.values()], policy });
  const bad = model.closed.filter((trade)=> {
    const r=details.get(trade.signalDate.replaceAll("-","")+"|"+trade.market+"|"+trade.code);
    const gross=Number(r?.[`r${horizon}`])+Number(matrix.costPct||0.23);
    return !Number.isFinite(gross) || gross<=-80 || gross>=200;
  });
  const quarantinedPnl=bad.reduce((sum,t)=>sum+Number(t.pnl||0),0);
  return {
    ...model.summary,
    comparableReturnPct:Math.round((model.summary.equity - quarantinedPnl -100_000_000)/1_000_000*1000)/1000,
    suspiciousClosedTrades:bad.length, skippedGap,skippedMissingBar,
    // compare above is a diagnostic only, not a fully rebalanced alternate book
    syntheticPriceFlagsUnavailable:true
  };
}
const result = [];
for (let i=0;i<registry.length;i++){
  const strategy=registry[i];
  const all = {};
  for (const hold of holds){
    all[String(hold)] = {
      train: runOne(strategy,hold,"train"),
      test:runOne(strategy,hold,"test"),
      full:runOne(strategy,hold,"full")
    };
  }
  result.push({id:strategy.id, name:strategy.displayName,group:strategy.group,matchedSignals:matches.get(strategy.id).length,holds:all});
  if ((i+1)%20===0) console.log(JSON.stringify({phase:"progress",done:i+1,total:registry.length}));
}
const meta = {
  schemaVersion:"historical-strategy-paper-backtest-v1",
  generatedAt:new Date().toISOString(),
  sourceMatrix:path.basename(matrixPath),
  actualMatrixStart:dates[0],actualMatrixEnd:dates.at(-1),
  dataUniverse:matrix.universe.length,observations:rows.length,
  completeHorizonObservations:dated.length,
  trainLastSignalDate:trainCut, testFirstSignalDate:split,
  benchmark:"cache-fixed universe, historical two-year retrospective; NOT untouched forward OOS",
  caveats:["Fixed historical cache universe and survivor bias","Historical features are approximate bridge of 2026 registry; strict point-in-time parity not proven",
    "Historical status flags not available; gap filtering is only a partial protection",
    "One fixed 100m capital per strategy/horizon, 10m per position and 10-position max",
    "0.23% baseline net already stored in matrix, liquidity slippage added once",
    "Cash/position capacity and overlapping signals enforced by existing paper model",
    "Train/test is only temporal reconstruction; definitions were designed later",
    "Integrity comparable return is raw result minus suspect-trade PNL, not reallocated cash",
    "Selection dates in the 20-session split buffer are intentionally excluded from train"]
};
const output={...meta,results:result};
mkdirSync(path.dirname(outPath),{recursive:true});
writeFileSync(outPath,JSON.stringify(output),"utf8");
const top=result.map((r)=>({id:r.id,name:r.name,n:r.holds["10"].test.closedTrades,pct:r.holds["10"].test.comparableReturnPct,mdd:r.holds["10"].test.maxDrawdownPct}))
  .filter((a)=>a.n>=20).sort((a,b)=>b.pct-a.pct).slice(0,15);
console.log(JSON.stringify({phase:"complete",path:outPath,strategies:result.length,accountComparisons:result.length*holds.length,trainTestBacktests:result.length*holds.length*3,maxDate,top},null,2));
