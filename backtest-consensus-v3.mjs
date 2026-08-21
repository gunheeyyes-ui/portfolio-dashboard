// Consensus backtest: reuse an existing Backtest V3 feature matrix and test
// whether agreement across the dashboard's many candidate systems adds value.
// No prices are downloaded and no live score/rank is changed.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { annotateConsensusRows } from "./backtest-v3/consensus.mjs";
import { attachVerdicts, baselineRows, runCondition } from "./backtest-v3/analysis.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MATRIX_DIR = path.join(__dirname, "backtest-v3", "matrix");
const OUT_DIR = path.join(__dirname, "backtest-results-v3");
const args = parseArgs(process.argv.slice(2));
const minTrades = Number(args["min-trades"] || 20);
const trainRatio = clamp(Number(args.train || 0.6), 0.2, 0.85);

mkdirSync(OUT_DIR, { recursive: true });

const matrixPath = args["from-matrix"] ? path.resolve(args["from-matrix"]) : latestMatrix();
if (!matrixPath || !existsSync(matrixPath)) {
  throw new Error("V3 feature matrix가 없습니다. 먼저 node backtest-lab-v3.mjs --matrix-only 1 을 실행하세요.");
}

const loaded = JSON.parse(readFileSync(matrixPath, "utf8"));
const rows = annotateConsensusRows(loaded.observations ?? []);
const holds = (loaded.holds ?? [1, 3, 5, 10, 20, 60]).map(Number).filter(Number.isFinite);
const focusHorizon = Number(args.focus || (holds.includes(10) ? 10 : holds[0]));
const dates = [...new Set(rows.map((row) => row.date))].sort();
const splitIndex = Math.max(1, Math.min(dates.length - 1, Math.floor(dates.length * trainRatio)));
const splitDate = dates[splitIndex] ?? dates.at(-1);
const opts = { splitDate, holds, minTrades };
const baseline = baselineRows(rows, splitDate, holds, minTrades);

const C = (field, op, value) => value === undefined ? { field, op } : { field, op, value };
const all = (...conditions) => ({ all: conditions });

const tests = [
  ["CONSENSUS_STRATEGY_3_PLUS", C("strategyMatchCount", "gte", 3), "전략 수 자체의 효과"],
  ["CONSENSUS_STRATEGY_5_PLUS", C("strategyMatchCount", "gte", 5), "전략 5개 이상 합의"],
  ["CONSENSUS_STRATEGY_7_PLUS", C("strategyMatchCount", "gte", 7), "전략 7개 이상 강한 합의"],
  ["CONSENSUS_AXIS_2_PLUS", C("strategyAxisCount", "gte", 2), "독립 계열 2개 이상"],
  ["CONSENSUS_AXIS_3_PLUS", C("strategyAxisCount", "gte", 3), "독립 계열 3개 이상"],
  ["CONSENSUS_AXIS_4_PLUS", C("strategyAxisCount", "gte", 4), "독립 계열 4개 이상"],
  ["CONSENSUS_5S_3A", all(C("strategyMatchCount", "gte", 5), C("strategyAxisCount", "gte", 3)), "5전략+·3계열+"],
  ["CONSENSUS_5S_4A", all(C("strategyMatchCount", "gte", 5), C("strategyAxisCount", "gte", 4)), "5전략+·4계열+"],
  ["CONSENSUS_3A_LEADER_RS", all(C("strategyAxisCount", "gte", 3), C("strategyHasLeaderAxis", "true"), C("strategyHasRsAxis", "true")), "3계열+이면서 Leader·RS 모두 포함"],
  ["CONSENSUS_4A_LEADER_RS", all(C("strategyAxisCount", "gte", 4), C("strategyHasLeaderAxis", "true"), C("strategyHasRsAxis", "true")), "4계열+이면서 Leader·RS 모두 포함"],
  ["CONSENSUS_3A_ACTIONABLE", all(C("strategyAxisCount", "gte", 3), C("actionable", "true")), "3계열+ + 실제 진입판정"],
  ["CONSENSUS_4A_ACTIONABLE", all(C("strategyAxisCount", "gte", 4), C("actionable", "true")), "4계열+ + 실제 진입판정"],
  ["CONSENSUS_5S_3A_ACTIONABLE", all(C("strategyMatchCount", "gte", 5), C("strategyAxisCount", "gte", 3), C("actionable", "true")), "5전략+·3계열+ + 실제 진입판정"],

  // Cross the consensus signal with the dashboard's major candidate queues.
  ["TIMING_TOP10_3AXIS", all(C("combinedRank", "between", [1, 10]), C("strategyAxisCount", "gte", 3)), "종합순위 TOP10 + 3계열+"],
  ["TIMING_TOP10_5S3A", all(C("combinedRank", "between", [1, 10]), C("strategyMatchCount", "gte", 5), C("strategyAxisCount", "gte", 3)), "종합순위 TOP10 + 5전략+·3계열+"],
  ["RANKING_V2_TOP10_3AXIS", all(C("rankingV2Rank", "between", [1, 10]), C("strategyAxisCount", "gte", 3)), "반등우선 TOP10 + 3계열+"],
  ["RANKING_V2_TOP10_5S3A", all(C("rankingV2Rank", "between", [1, 10]), C("strategyMatchCount", "gte", 5), C("strategyAxisCount", "gte", 3)), "반등우선 TOP10 + 5전략+·3계열+"],
  ["SCOUT_TOP10_3AXIS", all(C("scoutRank", "between", [1, 10]), C("strategyAxisCount", "gte", 3)), "반등후보 TOP10 + 3계열+"],
  ["SCOUT_TOP10_5S3A", all(C("scoutRank", "between", [1, 10]), C("strategyMatchCount", "gte", 5), C("strategyAxisCount", "gte", 3)), "반등후보 TOP10 + 5전략+·3계열+"],
  ["LEADER_TOP10_3AXIS", all(C("leaderRank", "between", [1, 10]), C("strategyAxisCount", "gte", 3)), "주도주 TOP10 + 3계열+"],
  ["LEADER_TOP10_5S3A", all(C("leaderRank", "between", [1, 10]), C("strategyMatchCount", "gte", 5), C("strategyAxisCount", "gte", 3)), "주도주 TOP10 + 5전략+·3계열+"],
  ["RS80_3AXIS", all(C("rs20", "gte", 80), C("strategyAxisCount", "gte", 3)), "RS80+ + 3계열+"],
  ["RS80_5S3A", all(C("rs20", "gte", 80), C("strategyMatchCount", "gte", 5), C("strategyAxisCount", "gte", 3)), "RS80+ + 5전략+·3계열+"],
  ["LEADER_A_RS80_3AXIS", all(C("leaderGrade", "eq", "A"), C("rs20", "gte", 80), C("strategyAxisCount", "gte", 3)), "Leader A + RS80 + 3계열+"],
  ["LEADER_A_RS80_5S3A", all(C("leaderGrade", "eq", "A"), C("rs20", "gte", 80), C("strategyMatchCount", "gte", 5), C("strategyAxisCount", "gte", 3)), "Leader A + RS80 + 5전략+·3계열+"],
  ["RANKING_V2_TOP10_LEADER_A_RS80", all(C("rankingV2Rank", "between", [1, 10]), C("leaderGrade", "eq", "A"), C("rs20", "gte", 80)), "반등우선 TOP10 + Leader A + RS80"],
  ["TIMING_TOP10_LEADER_A_RS80", all(C("combinedRank", "between", [1, 10]), C("leaderGrade", "eq", "A"), C("rs20", "gte", 80)), "종합순위 TOP10 + Leader A + RS80"]
];

const raw = [];
for (const [name, condition, thesis] of tests) {
  for (const result of runCondition({ name, condition, rows, ...opts })) raw.push({ ...result, thesis });
}
const results = attachVerdicts(raw, baseline, minTrades).map((row) => ({
  ...row,
  promotionCandidate: isPromotionCandidate(row, baseline, focusHorizon) ? "YES" : "NO"
}));

const stamp = path.basename(matrixPath).replace(/^feature-matrix-/, "").replace(/\.json$/i, "");
const csvPath = path.join(OUT_DIR, `consensus-summary-${stamp}.csv`);
const reportPath = path.join(OUT_DIR, `consensus-report-${stamp}.md`);
writeFileSync(csvPath, toCsv(results), "utf8");
writeFileSync(reportPath, buildReport(results, baseline, { matrixPath, splitDate, focusHorizon, minTrades, rows }), "utf8");

console.log(`Consensus backtest: ${matrixPath}`);
console.log(`TRAIN < ${splitDate} <= TEST · ${rows.length.toLocaleString()} observations`);
printLeaderboard(results, focusHorizon, minTrades);
console.log(`\nSaved:\n- ${csvPath}\n- ${reportPath}`);

function isPromotionCandidate(row, baselineRowsValue, horizon) {
  if (row.horizonDays !== horizon || (row.testTrades ?? 0) < minTrades) return false;
  const base = baselineRowsValue.find((item) => item.horizonDays === horizon)?.testAvgPct;
  return Number.isFinite(row.testAvgPct)
    && Number.isFinite(row.testExcessPct)
    && row.trainAvgPct > 0
    && row.testAvgPct > 0
    && row.testExcessPct > 0
    && row.testAvgPct > (base ?? -Infinity)
    && Number(row.testPF ?? 0) > 1
    && row.overfitWarning !== true;
}

function buildReport(resultsValue, baselineRowsValue, meta) {
  const base = baselineRowsValue.find((item) => item.horizonDays === meta.focusHorizon);
  const ranked = resultsValue
    .filter((row) => row.horizonDays === meta.focusHorizon && (row.testTrades ?? 0) >= meta.minTrades)
    .sort((a, b) => (b.testExcessPct ?? -999) - (a.testExcessPct ?? -999)
      || (b.testAvgPct ?? -999) - (a.testAvgPct ?? -999));
  const promote = ranked.filter((row) => row.promotionCandidate === "YES");
  const table = (list) => [
    "| 조합 | TEST N | TEST 평균 | 초과 | PF | 승률 | TRAIN | 판정 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...list.map((row) => `| ${row.strategy} | ${row.testTrades} | ${row.testAvgPct ?? "-"}% | ${row.testExcessPct ?? "-"}%p | ${row.testPF ?? "-"} | ${row.testWinRatePct ?? "-"}% | ${row.trainAvgPct ?? "-"}% | ${row.verdict} |`)
  ].join("\n");
  return `# 전략·계열 합의 백테스트\n\n- matrix: \`${meta.matrixPath}\`\n- split: TRAIN < ${meta.splitDate} <= TEST\n- 기준 보유: ${meta.focusHorizon}거래일\n- 최소 TEST 표본: ${meta.minTrades}\n- 대조군 TEST 평균: ${base?.testAvgPct ?? "-"}%\n- 중요: 합의 수는 새로운 투자점수가 아니라 기존 94개 전략의 동시 통과 개수입니다.\n\n## 승격 검토군\n\n승격 검토군은 TEST 표본 충족, TRAIN/TEST 모두 양수, 대조군 초과, 초과수익 양수, PF>1, 명백한 과최적화 경고 없음 조건을 모두 통과한 조합입니다. 이것만으로 실전 매수규칙으로 확정하지 않고 prospective OOS와 함께 확인합니다.\n\n${promote.length ? table(promote.slice(0, 15)) : "아직 승격 조건을 모두 통과한 조합이 없습니다."}\n\n## TEST 초과수익 순위\n\n${table(ranked.slice(0, 25))}\n`;
}

function printLeaderboard(resultsValue, horizon, minimum) {
  console.log(`\n=== ${horizon}일 TEST · 합의 조합 ===`);
  const top = resultsValue
    .filter((row) => row.horizonDays === horizon && (row.testTrades ?? 0) >= minimum)
    .sort((a, b) => (b.testExcessPct ?? -999) - (a.testExcessPct ?? -999))
    .slice(0, 20);
  for (const row of top) {
    console.log(`${String(row.strategy).padEnd(36)} N=${String(row.testTrades).padStart(4)} avg=${String(row.testAvgPct).padStart(6)}% excess=${String(row.testExcessPct).padStart(6)}%p PF=${String(row.testPF ?? "-").padStart(5)} ${row.promotionCandidate}`);
  }
}

function latestMatrix() {
  if (!existsSync(MATRIX_DIR)) return null;
  const files = readdirSync(MATRIX_DIR)
    .filter((name) => /^feature-matrix-.*\.json$/.test(name))
    .map((name) => ({ path: path.join(MATRIX_DIR, name), mtime: statSync(path.join(MATRIX_DIR, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.path ?? null;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith("--")) continue;
    const key = current.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = "1";
    else { out[key] = next; i += 1; }
  }
  return out;
}

function toCsv(rowsValue) {
  if (!rowsValue.length) return "";
  const columns = [...new Set(rowsValue.flatMap((row) => Object.keys(row)))];
  const cell = (value) => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.join(","), ...rowsValue.map((row) => columns.map((column) => cell(row[column])).join(","))].join("\n");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
