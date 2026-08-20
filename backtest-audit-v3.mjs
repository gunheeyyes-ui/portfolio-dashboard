// Robustness audit runner for Backtest Lab V3.
//
// This does not produce signals. It re-measures the trades V3 already found,
// trying to break each result: same-date benchmark instead of absolute
// return, repeat-signal and outlier resampling, rolling out-of-sample folds,
// cooldown sensitivity, concentration, and corporate-action suspects.
//
//   node backtest-audit-v3.mjs                       # uses the newest matrix
//   node backtest-audit-v3.mjs --from-matrix <file>
//   node backtest-audit-v3.mjs --self-test 1

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { attachSameDateBenchmark, detectCorporateActions, suspectWindows } from "./backtest-v3/robustness.mjs";
import {
  extremeDrawdownAudit, leaderBreakdown, leaderRsMatrix, leaderPullback,
  leaderRiskStab, reboundWithLeader, portfolioTopN, attachPortfolioRanks,
  marketCapBuckets, coreComparison, CORE_STRATEGIES,
  buildFolds, runWalkForward, cooldownSensitivity, tradesFor, block, C, resampleAudit
} from "./backtest-v3/audit.mjs";
import { runAuditSelfTest } from "./backtest-v3/audit-selftest.mjs";
import { buildFeatureMatrix, loadUniverseFromCache } from "./backtest-v3/features.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "backtest-results-v3");
const MATRIX_DIR = path.join(__dirname, "backtest-v3", "matrix");

const args = parseArgs(process.argv.slice(2));
if (args["self-test"] === "1" || args.selftest === "1") {
  runAuditSelfTest();
  process.exit(0);
}

const H = Number(args.focus || 10);
const holds = String(args.holds || "3,5,10,20").split(",").map(Number).filter(Boolean);
const minTrades = Number(args["min-trades"] || 20);
const trainRatio = Number(args.train || 0.6);

mkdirSync(OUT_DIR, { recursive: true });

async function main() {
  const matrixFile = args["from-matrix"]
    ? path.resolve(args["from-matrix"])
    : newestMatrix();
  if (!matrixFile) throw new Error("No feature matrix found. Run backtest-lab-v3.mjs first.");
  console.log(`Matrix: ${path.basename(matrixFile)}`);
  const loaded = JSON.parse(readFileSync(matrixFile, "utf8"));
  const universe = loaded.universe;
  let observations = loaded.observations;
  console.log(`  ${observations.length.toLocaleString()} observations`);

  // 8. Same-date, same-market benchmark replaces the naive absolute return.
  observations = attachSameDateBenchmark(observations, holds);
  observations = attachPortfolioRanks(observations);

  const dates = [...new Set(observations.map((r) => r.date))].sort();
  const splitIdx = Math.max(1, Math.floor(dates.length * trainRatio));
  const splitDate = dates[splitIdx];
  const testRows = observations.filter((r) => r.date >= splitDate);
  const folds = buildFolds(dates, 3);
  console.log(`TEST from ${splitDate} (${testRows.length.toLocaleString()} obs) · folds: ${folds.map((f) => `${f.testFrom}~${f.testTo}`).join(", ")}`);

  const stamp = `${loaded.startDate}_${loaded.endDate}`;
  const write = (name, rows) => {
    const file = path.join(OUT_DIR, `${name}-${stamp}.csv`);
    writeFileSync(file, toCsv(rows), "utf8");
    return file;
  };

  // 3. Corporate-action suspects, rebuilt from the same cache the matrix used.
  console.log("Detecting possible corporate actions ...");
  const { seriesByCode } = buildFeatureMatrix(universe, {
    startDate: loaded.startDate, endDate: loaded.endDate,
    holds: [1], costPct: loaded.costPct ?? 0.23
  });
  const suspects = detectCorporateActions(seriesByCode, universe, Number(args["ca-threshold"] || 40));
  const isSuspect = suspectWindows(suspects, Number(args["ca-window"] || 90));
  write("corporate-action-suspects", suspects);
  console.log(`  ${suspects.length} suspect bars across ${new Set(suspects.map((s) => s.code)).size} codes`);

  // 2. Extreme drawdown, audited every way.
  console.log("Auditing <-60% drawdown bucket ...");
  const dd = extremeDrawdownAudit(testRows, H);
  write("extreme-drawdown-audit", dd.detail);
  const ddClean = dd.trades.filter((r) => !isSuspect(r));
  const ddCleanSummary = resampleAudit(ddClean, H);

  // 4-7, 15. Leader-centric slices.
  console.log("Leader breakdowns ...");
  const leaderRows = leaderBreakdown(observations.filter((r) => r.date >= splitDate), holds);
  write("leader-breakdown", leaderRows);
  const rsMatrix = leaderRsMatrix(testRows, H);
  write("leader-rs-matrix", rsMatrix);
  const pullback = leaderPullback(testRows, H);
  write("leader-pullback", pullback);
  const riskStab = leaderRiskStab(testRows, H);
  write("leader-risk-stab", riskStab);
  const rebound = reboundWithLeader(testRows, H);
  write("rebound-with-leader", rebound);

  // 10-14. Stability, cooldown, portfolio, concentration, size.
  console.log("Walk-forward, cooldown, portfolio, concentration ...");
  const wfRows = [];
  for (const [key, condition] of CORE_STRATEGIES) {
    const wf = runWalkForward(observations, condition, folds, H);
    wfRows.push({
      strategy: key,
      ...Object.fromEntries(wf.folds.flatMap((f) => [[`${f.fold}_n`, f.n], [`${f.fold}_excess`, f.excessPct]])),
      foldsPositive: wf.foldsPositive, foldsTotal: wf.foldsTotal,
      meanFoldExcessPct: wf.meanFoldExcessPct, worstFoldExcessPct: wf.worstFoldExcessPct,
      stability: wf.stability
    });
  }
  write("walkforward-summary", wfRows);

  const cooldownRows = [];
  for (const [key, condition] of [
    ["Leader A", { all: [C.leaderA] }],
    ["Leader TOP3", { all: [C.rank("leaderRank", 3)] }],
    ["RS80+", { all: [C.rs(80)] }],
    ["Leader A + RS80", { all: [C.leaderA, C.rs(80)] }],
    ["RankingV2 TOP10", { all: [C.rank("rankingV2Rank", 10)] }],
    ["Scout TOP10", { all: [C.rank("scoutRank", 10)] }],
    ["낙폭 <-60", { all: [C.ddBelow(-60)] }]
  ]) {
    const s = cooldownSensitivity(testRows, condition, H);
    cooldownRows.push({
      strategy: key,
      ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== "verdict")
        .flatMap(([k, v]) => [[`${k}_n`, v.n], [`${k}_excess`, v.excessPct]])),
      verdict: s.verdict
    });
  }
  write("cooldown-sensitivity", cooldownRows);

  const portfolio = portfolioTopN(testRows, holds);
  write("portfolio-topn", portfolio);
  const caps = marketCapBuckets(testRows, H);
  write("marketcap-buckets", caps);

  // 16-17. Core comparison with the combined verdict.
  console.log("Core comparison ...");
  const core = coreComparison(testRows, observations, folds, H, minTrades);
  write("core-comparison", core);

  const reportFile = path.join(OUT_DIR, `audit-report-${stamp}.md`);
  writeFileSync(reportFile, buildAuditReport({
    stamp, loaded, universe, observations, testRows, splitDate, folds, H, minTrades,
    suspects, dd, ddCleanSummary, ddCleanCount: ddClean.length,
    core, leaderRows, rsMatrix, pullback, riskStab, rebound, wfRows, cooldownRows, portfolio, caps
  }), "utf8");

  console.log("\n=== CORE COMPARISON (10D TEST) ===");
  for (const r of core) {
    console.log(`${String(r.strategy).padEnd(30)} N=${String(r.n).padStart(5)} avg=${String(r.avgPct).padStart(6)}% ex=${String(r.excessPct).padStart(6)}% folds=${r.foldsPositive}/${r.foldsTotal} top5=${String(r.top5SharePct).padStart(5)}% ${r.verdict}`);
  }
  console.log(`\nReport: ${reportFile}`);
}

function newestMatrix() {
  if (!existsSync(MATRIX_DIR)) return null;
  const files = readdirSync(MATRIX_DIR).filter((f) => f.endsWith(".json"))
    .map((f) => ({ f, size: readFileSync(path.join(MATRIX_DIR, f)).length }))
    .sort((a, b) => b.size - a.size);
  return files[0] ? path.join(MATRIX_DIR, files[0].f) : null;
}

const PERF = [
  ["N", (r) => r.n], ["평균%", (r) => r.avgPct], ["중앙%", (r) => r.medianPct],
  ["승률%", (r) => r.winPct], ["PF", (r) => r.pf],
  ["MFE%", (r) => r.mfePct], ["MAE%", (r) => r.maePct], ["초과%", (r) => r.excessPct]
];

function tbl(rows, cols) {
  if (!rows?.length) return "_결과 없음_\n";
  return `| ${cols.map((c) => c[0]).join(" | ")} |\n| ${cols.map(() => "---").join(" | ")} |\n`
    + rows.map((r) => `| ${cols.map((c) => fmt(c[1](r))).join(" | ")} |`).join("\n") + "\n";
}
function fmt(v) { return v === null || v === undefined || v === "" ? "-" : String(v).replace(/\|/g, "\\|"); }

function buildAuditReport(x) {
  const { dd, ddCleanSummary, ddCleanCount, suspects, core, H } = x;
  const s = dd.summary;
  return `# V3 Robustness Audit

기준: **${H}일 보유 · TEST 표본** (분리일 ${x.splitDate}) · 관측 ${x.observations.length.toLocaleString()}건
Rolling folds: ${x.folds.map((f) => `${f.testFrom}~${f.testTo}`).join(" · ")}

> 이 리포트의 기본 성과지표는 **same-date same-market 초과수익(초과%)** 입니다.
> 절대수익은 TEST 구간이 강세장이면 전 전략이 좋아 보이므로 단독으로 읽으면 안 됩니다.

> **CURRENT-UNIVERSE SURVIVORSHIP BIAS** 유지. 상장주식수 현재값 소급, H3/VWAP EOD 근사,
> CAFE 기술+수급 프록시라는 V3 리포트의 한계가 그대로 적용됩니다.

## 16. CORE COMPARISON — ${H}D TEST

${tbl(core, [
    ["전략", (r) => r.strategy], ["N", (r) => r.n], ["평균%", (r) => r.avgPct],
    ["중앙%", (r) => r.medianPct], ["승률%", (r) => r.winPct], ["PF", (r) => r.pf],
    ["MAE%", (r) => r.maePct], ["MFE%", (r) => r.mfePct],
    ["초과%", (r) => r.excessPct], ["folds+", (r) => `${r.foldsPositive}/${r.foldsTotal}`],
    ["top5기여%", (r) => r.top5SharePct], ["판정", (r) => r.verdict]
  ])}

**판정 기준** — Robust candidate: 표본 충분 + 초과수익 양수 + folds 2/3 이상 양수 + 리샘플 5종 모두 양수 + 집중도 정상.
Promising: 그중 일부만 충족. Fragile: 특정 조건에서만. Concentrated: 상위 5종목이 60% 초과 기여. Negative: 초과수익 음수.

## 2. 극단 낙폭(<-60%) 전수 감사

원 결과가 좋았기에 가장 강하게 의심해야 하는 대상입니다.

| 재측정 방식 | N | 평균% |
| --- | --- | --- |
| 전체 | ${s.all.n} | ${s.all.mean} |
| 종목당 최초 신호만 | ${s.firstSignalOnly.n} | ${s.firstSignalOnly.mean} |
| 종목별 equal weight | ${s.equalWeightByCode.n} | ${s.equalWeightByCode.mean} |
| 날짜별 equal weight | ${s.equalWeightByDate.n} | ${s.equalWeightByDate.mean} |
| 상위 1% 제거 | ${s.trimTop1.n} | ${s.trimTop1.mean} |
| 상위 5% 제거 | ${s.trimTop5.n} | ${s.trimTop5.mean} |

- 중앙값 ${s.medianPct}% · 승률 ${s.winRatePct}% · PF ${s.profitFactor} · MFE ${s.avgMfePct}% · MAE ${s.avgMaePct}%
- **same-date 초과수익 ${s.avgExcessPct}%**
- 모든 재측정 양수: ${s.allVariantsPositive ? "예" : "아니오"} · 가장 약한 방식 **${s.weakestVariant} = ${s.weakestMean}%**
- 판정: **${s.potentiallyRobust ? "potentially robust" : "NOT robust — 특정 종목 또는 특정 날짜에 의존"}**
  (양수인 것만으로는 부족합니다. 가장 약한 재측정이 전체 평균의 25% 이상을 유지해야 통과입니다.)
- 종목 집중도: 상위 1종목 ${dd.concentration.top1SharePct}% / 상위 5종목 ${dd.concentration.top5SharePct}% (${dd.concentration.top5Codes})
- 상위 5종목 제외 시: N=${dd.concentration.excludeTop5N}, 평균 ${dd.concentration.excludeTop5MeanPct}%, 초과 ${dd.concentration.excludeTop5ExcessPct}%

### 3. Corporate action 의심 제거 후

- 의심 bar ${suspects.length}건 (전일 대비 ±40% 이상). **POSSIBLE CORPORATE ACTION** 으로만 표기하며 분할·병합 여부는 확인 불가입니다.
- 의심 종목의 ±90일 구간을 제외하면: N=${ddCleanCount} (원래 ${s.all.n}), 평균 **${ddCleanSummary.all.mean}%**, 초과 ${ddCleanSummary.avgExcessPct}%, 재측정 5종 모두 양수: ${ddCleanSummary.potentiallyRobust ? "예" : "아니오"}

## 4. Leader 정밀 검증

### 등급 × 보유기간
${tbl(x.leaderRows.filter((r) => r.view === "등급×보유"), [["등급", (r) => r.key], ["보유", (r) => `${r.horizon}D`], ...PERF])}

### 등급 × 시장
${tbl(x.leaderRows.filter((r) => r.view === "등급×시장"), [["등급", (r) => r.key], ["시장", (r) => r.market], ...PERF])}

### 등급 × 기간 (반기)
${tbl(x.leaderRows.filter((r) => r.view === "등급×기간"), [["등급", (r) => r.key], ["기간", (r) => r.period], ...PERF])}

### 점수 threshold
${tbl(x.leaderRows.filter((r) => r.view === "점수 threshold"), [["조건", (r) => r.key], ...PERF])}

## 5. Leader × RS20
${tbl(x.rsMatrix, [["조건", (r) => r.key], ...PERF])}

## 6. Leader × 눌림 깊이
${tbl(x.pullback, [["Leader", (r) => r.leader], ["낙폭", (r) => r.drawdown], ...PERF])}

## 7. Leader × Risk × Stabilize
${tbl(x.riskStab, [["조건", (r) => r.key], ...PERF])}

## 15. 반등 시스템 × Leader

Ranking V2·Scout를 폐기할지가 아니라, **좋은 종목을 먼저 고른 뒤 반등 필터를 쓰면 달라지는지**를 봅니다.

${tbl(x.rebound, [["조건", (r) => r.key], ...PERF])}

## 10. Rolling walk-forward
${tbl(x.wfRows, [
    ["전략", (r) => r.strategy],
    ["F1 초과%", (r) => r.Fold1_excess], ["F2 초과%", (r) => r.Fold2_excess], ["F3 초과%", (r) => r.Fold3_excess],
    ["평균", (r) => r.meanFoldExcessPct], ["최악", (r) => r.worstFoldExcessPct],
    ["양수", (r) => `${r.foldsPositive}/${r.foldsTotal}`], ["판정", (r) => r.stability]
  ])}

## 11. Cooldown 민감도
${tbl(x.cooldownRows, [
    ["전략", (r) => r.strategy],
    ["cd0", (r) => r.cooldown0_excess], ["cd3", (r) => r.cooldown3_excess],
    ["cd5", (r) => r.cooldown5_excess], ["cd10", (r) => r.cooldown10_excess],
    ["보유쿨다운", (r) => r.holdingCooldown_excess], ["최초신호만", (r) => r.firstSignalOnly_excess],
    ["판정", (r) => r.verdict]
  ])}

## 12. TOP-N 일별 포트폴리오 (equal weight)

개별 거래 평균이 아니라 **매일 N종목 균등보유** 관점입니다. 위 표들과 직접 비교하지 마세요.

${tbl(x.portfolio.filter((r) => r.topN <= 10), [
    ["순위체계", (r) => r.system], ["TOP", (r) => r.topN], ["코호트", (r) => r.cohorts],
    ["3D%", (r) => r.avg3], ["5D%", (r) => r.avg5], ["10D%", (r) => r.avg10], ["20D%", (r) => r.avg20],
    ["10D초과%", (r) => r.excess10], ["승률%", (r) => r.winPct10],
    ["최악", (r) => r.worstCohort10], ["중앙", (r) => r.medianCohort10], ["최고", (r) => r.bestCohort10],
    ["중복%", (r) => r.avgOverlapPct], ["회전%", (r) => r.turnoverPct]
  ])}

## 13/14. 집중도 · 시가총액

집중도는 CORE COMPARISON의 top5기여% 열에 포함되어 있습니다.

${tbl(x.caps, [["구간", (r) => r.key], ...PERF, ["비고", (r) => r.note]])}

## 18. 라이브 반영 검토 후보 (자동 적용하지 않음)

아래는 **제안일 뿐이며 이번 작업에서 라이브 파일은 전혀 수정하지 않았습니다.**
실제 반영 여부는 사용자가 결정합니다.

${liveSuggestions(core, x.rsMatrix, x.rebound)}
`;
}

function liveSuggestions(core, rsMatrix, rebound) {
  const get = (name) => core.find((r) => r.strategy === name);
  const lines = [];
  const leaderA = get("Leader A");
  const rs80 = get("RS80+");
  const leaderRs = get("Leader A + RS80");
  const rankingTop = get("RankingV2 TOP10");
  if (leaderA && leaderA.verdict !== "Negative" && leaderA.verdict !== "Insufficient") {
    lines.push(`- **Leader를 종목 품질 1차축으로 승격 검토** — Leader A 초과수익 ${leaderA.excessPct}%, 판정 ${leaderA.verdict}. 단, 아래 집중도(top5 ${leaderA.top5SharePct}%)를 함께 봐야 합니다.`);
  }
  if (rs80) {
    lines.push(`- **RS80을 보조 필터로 승격 검토** — RS80+ 초과 ${rs80.excessPct}% (판정 ${rs80.verdict}). RS 80 미만 구간은 가치가 없었으므로 승격한다면 컷은 80 이상이어야 합니다.`);
  }
  if (leaderRs) {
    lines.push(`- **Leader A + RS80 조합** 초과 ${leaderRs.excessPct}%, 판정 ${leaderRs.verdict}.`);
  }
  if (rankingTop) {
    lines.push(`- **Ranking V2는 반등 탐색기로 유지** — 단독 TOP10 초과 ${rankingTop.excessPct}% (판정 ${rankingTop.verdict}). 매수 우선순위가 아니라 반등 후보 탐색 용도라는 현재 정의를 유지하는 편이 데이터와 부합합니다.`);
  }
  lines.push("- **Risk 39→24 변경은 보류** — 표본이 한 구간에 몰려 있어 rolling fold 결과를 더 본 뒤 판단하는 것이 안전합니다.");
  lines.push("- 어떤 변경도 survivorship bias가 남아 있는 상태의 결과라는 점을 전제로 판단해야 합니다.");
  return lines.join("\n");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const n = argv[i + 1];
    if (!n || n.startsWith("--")) out[k] = "1"; else { out[k] = n; i += 1; }
  }
  return out;
}

function toCsv(rows) {
  if (!rows?.length) return "";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const t = String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
}

// Invoked last so every const in this module is initialised first.
main().catch((e) => { console.error(e?.stack || e); process.exitCode = 1; });
