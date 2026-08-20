// Backtest Lab V3 — filter-combination research on top of the V2 dataset.
//
// V3 does not invent a new score. Every condition it tests is an existing
// dashboard field (Ranking V2 tier, Leader, Scout, RS20, CAFE/MTT, the
// R/F/F2/B/C/H2/H3/I flags, supply and liquidity), so the question it answers
// is "which of the things we already look at actually mattered".
//
// Two phases, deliberately separated (see --matrix-only / --from-matrix):
//   1. feature matrix  — reads backtest-cache-v2, no network, no filters
//   2. filter evaluation — reads the matrix, no prices, fast and repeatable
//
// Usage:
//   node backtest-lab-v3.mjs --years 2 --limit 100 --holds 1,3,5,10,20,60 --cost 0.23
//   node backtest-lab-v3.mjs --preset LEADER_REBOUND
//   node backtest-lab-v3.mjs --config ./backtest-configs/my-test.json
//   node backtest-lab-v3.mjs --sweep 1
//   node backtest-lab-v3.mjs --self-test 1

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFeatureMatrix, attachExcessReturns, loadUniverseFromCache } from "./backtest-v3/features.mjs";
import {
  runSingleFactors, runTwoFactor, runCoreTriples, runPresets, runTopN,
  runThresholdSweep, baselineRows, attachVerdicts, runCondition
} from "./backtest-v3/analysis.mjs";
import { buildReport } from "./backtest-v3/report.mjs";
import { runSelfTest } from "./backtest-v3/selftest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "backtest-results-v3");
const MATRIX_DIR = path.join(__dirname, "backtest-v3", "matrix");

const args = parseArgs(process.argv.slice(2));

if (args["self-test"] === "1" || args.selftest === "1") {
  runSelfTest();
  process.exit(0);
}

const years = Number(args.years || 2);
const endDate = args.end || yyyymmdd(new Date());
const startDate = args.start || yyyymmdd(addDays(new Date(), -365 * years));
const limit = Number(args.limit || 100);
const maxTickers = args.max ? Number(args.max) : null;
const costPct = Number(args.cost || 0.23);
const holds = String(args.holds || "1,3,5,10,20,60").split(",").map(Number).filter((v) => Number.isFinite(v) && v > 0);
const focusHorizon = Number(args.focus || (holds.includes(10) ? 10 : holds[0]));
const trainRatio = clamp(Number(args.train || 0.6), 0.2, 0.85);
const minTrades = Number(args["min-trades"] || 20);
const rawOutput = args.raw === "1";
const matrixOnly = args["matrix-only"] === "1";
const fromMatrix = args["from-matrix"] || null;

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(MATRIX_DIR, { recursive: true });

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

async function main() {
  const stamp = `${startDate}_${endDate}_market_${limit}`;
  const matrixPath = fromMatrix ? path.resolve(fromMatrix) : path.join(MATRIX_DIR, `feature-matrix-${stamp}.json`);

  let observations;
  let universe;
  let skipped;

  if (fromMatrix || (existsSync(matrixPath) && args.rebuild !== "1")) {
    console.log(`Loading feature matrix: ${matrixPath}`);
    const loaded = JSON.parse(readFileSync(matrixPath, "utf8"));
    observations = loaded.observations;
    universe = loaded.universe;
    skipped = loaded.skipped ?? [];
    console.log(`  ${observations.length.toLocaleString()} observations (cached matrix, no recomputation)`);
  } else {
    universe = loadUniverseFromCache(limit).slice(0, maxTickers || undefined);
    if (!universe.length) throw new Error("No cached universe found in backtest-cache-v2.");
    console.log(`Backtest Lab V3 ${startDate}~${endDate}`);
    console.log(`Universe from cache: ${universe.length} tickers (KOSPI/KOSDAQ ranked independently)`);
    const built = buildFeatureMatrix(universe, {
      startDate, endDate, holds, costPct,
      onProgress: (i, total, item, rowCount) => {
        if (i % 25 === 0 || i === total) console.log(`  [${i}/${total}] ${item.code} ${item.name} -> ${rowCount} rows`);
      }
    });
    observations = attachExcessReturns(built.observations, holds);
    skipped = built.skipped;
    writeFileSync(matrixPath, JSON.stringify({ startDate, endDate, holds, costPct, universe, skipped, observations }), "utf8");
    console.log(`Feature matrix saved: ${matrixPath} (${observations.length.toLocaleString()} observations)`);
  }

  if (matrixOnly) {
    console.log("--matrix-only: stopping before filter evaluation.");
    return;
  }

  const uniqueDates = [...new Set(observations.map((r) => r.date))].sort();
  const splitIndex = Math.max(1, Math.min(uniqueDates.length - 1, Math.floor(uniqueDates.length * trainRatio)));
  const splitDate = uniqueDates[splitIndex] ?? uniqueDates.at(-1);
  console.log(`TRAIN < ${splitDate} <= TEST   (${uniqueDates.length} trading days)`);

  const opts = { splitDate, holds, minTrades };
  const baseline = baselineRows(observations, splitDate, holds, minTrades);

  // A config file or a single preset narrows the run; otherwise do the full sweep.
  if (args.config) {
    const cfg = JSON.parse(readFileSync(path.resolve(args.config), "utf8"));
    const list = Array.isArray(cfg) ? cfg : [cfg];
    const rows = list.flatMap((c) => runCondition({
      name: c.name || "CONFIG", condition: c.all ? { all: c.all } : c, rows: observations, ...opts
    }));
    const withVerdict = attachVerdicts(rows, baseline, minTrades);
    const file = path.join(OUT_DIR, `config-summary-${stamp}.csv`);
    writeFileSync(file, toCsv(withVerdict), "utf8");
    printLeaderboard(withVerdict, focusHorizon, minTrades);
    console.log(`\nSaved: ${file}`);
    return;
  }

  console.log("Evaluating single factors ...");
  const { results: singlesRaw, filters } = runSingleFactors(observations, opts);
  const singles = attachVerdicts(singlesRaw, baseline, minTrades);

  console.log("Evaluating 2-factor crosses ...");
  const twoFactor = attachVerdicts(runTwoFactor(observations, filters, opts), baseline, minTrades);

  console.log("Evaluating core 3-factor combinations ...");
  const triples = attachVerdicts(runCoreTriples(observations, filters, opts), baseline, minTrades);

  console.log("Evaluating presets ...");
  const presets = attachVerdicts(runPresets(observations, { ...opts, only: args.preset || null }), baseline, minTrades);

  console.log("Evaluating TOP-N rank systems ...");
  const topN = attachVerdicts(runTopN(observations, opts), baseline, minTrades);

  const sweep = args.sweep === "0"
    ? []
    : runThresholdSweep(observations, filters, { ...opts, focusHorizon });

  const diagnostics = buildDiagnostics(observations, universe, skipped, splitDate);

  const files = {
    factor: path.join(OUT_DIR, `factor-summary-${stamp}.csv`),
    strategy: path.join(OUT_DIR, `strategy-summary-${stamp}.csv`),
    combo: path.join(OUT_DIR, `combo-summary-${stamp}.csv`),
    threshold: path.join(OUT_DIR, `threshold-summary-${stamp}.csv`),
    rankTopn: path.join(OUT_DIR, `rank-topn-summary-${stamp}.csv`),
    robustness: path.join(OUT_DIR, `robustness-summary-${stamp}.csv`),
    trades: path.join(OUT_DIR, `strategy-trades-${stamp}.csv`),
    report: path.join(OUT_DIR, `report-${stamp}.md`),
    diagnostics: path.join(OUT_DIR, `diagnostics-${stamp}.json`),
    raw: path.join(OUT_DIR, `observations-${stamp}.csv`)
  };

  writeFileSync(files.factor, toCsv(singles), "utf8");
  writeFileSync(files.strategy, toCsv(presets), "utf8");
  writeFileSync(files.combo, toCsv([...twoFactor, ...triples]), "utf8");
  writeFileSync(files.threshold, toCsv(sweep), "utf8");
  writeFileSync(files.rankTopn, toCsv(topN), "utf8");
  writeFileSync(files.robustness, toCsv(sweep.filter((r) => r.verdict === "견고 가능성" || r.verdict === "과최적화 위험")), "utf8");
  writeFileSync(files.trades, toCsv(topTrades(observations, focusHorizon)), "utf8");
  writeFileSync(files.diagnostics, JSON.stringify(diagnostics, null, 2), "utf8");
  if (rawOutput) writeFileSync(files.raw, toCsv(observations), "utf8");

  writeFileSync(files.report, buildReport({
    stamp, startDate, endDate, universe, skipped, observations, splitDate,
    holds, focusHorizon, costPct, minTrades, baseline,
    singles, twoFactor, triples, presets, topN, sweep, diagnostics
  }), "utf8");

  printLeaderboard([...singles, ...twoFactor, ...triples, ...presets], focusHorizon, minTrades);
  console.log("\nSaved:");
  for (const [, file] of Object.entries(files)) {
    if (file === files.raw && !rawOutput) continue;
    console.log(`- ${file}`);
  }
}

function printLeaderboard(rows, horizon, minTrades) {
  const base = rows.find((r) => r.strategy === "BASELINE_ALL" && r.horizonDays === horizon);
  console.log(`\n=== ${horizon}일 보유 · TEST 표본 · 최소 ${minTrades}거래 ===`);
  if (base) console.log(`대조군(전체) TEST 평균 ${base.testAvgPct}%`);
  const top = rows
    .filter((r) => r.horizonDays === horizon && (r.testTrades ?? 0) >= minTrades)
    .sort((a, b) => (b.testAvgPct ?? -999) - (a.testAvgPct ?? -999))
    .slice(0, 15);
  for (const r of top) {
    console.log(`${String(r.strategy).slice(0, 46).padEnd(46)} N=${String(r.testTrades).padStart(4)} avg=${String(r.testAvgPct).padStart(6)}% PF=${String(r.testPF ?? "-").padStart(5)} ${r.verdict}`);
  }
}

function topTrades(observations, horizon) {
  return observations
    .filter((r) => Number.isFinite(r[`r${horizon}`]))
    .slice(0, 5000)
    .map((r) => ({
      date: r.date, code: r.code, name: r.name, market: r.market,
      combinedRank: r.combinedRank, rankingTier: r.rankingTier, leaderGrade: r.leaderGrade,
      rs20: r.rs20, drawdownFromHighPct: r.drawdownFromHighPct,
      entryDate: r[`entryDate${horizon}`], exitDate: r[`exitDate${horizon}`],
      returnPct: r[`r${horizon}`], excessPct: r[`x${horizon}`]
    }));
}

function buildDiagnostics(observations, universe, skipped, splitDate) {
  const investorNA = observations.filter((r) => r.investorKnown === false).length;
  return {
    generatedAt: new Date().toISOString(),
    survivorshipBias: "CURRENT-UNIVERSE SURVIVORSHIP BIAS: current market-cap universe applied historically.",
    shareCountApproximation: "Current listed shares used for historical market cap / turnover.",
    vwapApproximation: "H3/VWAP is an EOD approximation from daily tradingValue/volume.",
    observations: observations.length,
    tradingDays: new Set(observations.map((r) => r.date)).size,
    splitDate,
    universeKOSPI: universe.filter((u) => u.market === "KOSPI").length,
    universeKOSDAQ: universe.filter((u) => u.market === "KOSDAQ").length,
    skipped,
    investorNA,
    investorNAPct: observations.length ? Number(((investorNA / observations.length) * 100).toFixed(1)) : 0,
    leaderNA: observations.filter((r) => r.leaderGrade === "계산불가").length,
    scoutNA: observations.filter((r) => r.scoutStatus === "계산불가").length,
    rs20NA: observations.filter((r) => r.rs20 === null || r.rs20 === undefined).length
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const n = argv[i + 1];
    if (!n || n.startsWith("--")) out[k] = "1";
    else { out[k] = n; i += 1; }
  }
  return out;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const t = String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
}

function yyyymmdd(date) { return date.toISOString().slice(0, 10).replace(/-/g, ""); }
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
