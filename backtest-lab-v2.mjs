import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { portfolio } from "./portfolio.js";

/**
 * Backtest Lab V2
 * - Current dashboard validation: combined score/rank, liquidity, combined label/Gate, scout, R/F/F2/H3
 * - New Leader V1 validation
 * - Key intersections only (avoid combinatorial overfitting)
 * - External benchmarks: Cafe leader-pullback proxy, Minervini MTT
 * - Point-in-time price/supply rules only. No fundamental proxy is mislabeled as Lynch/Fisher.
 * - Default entry: signal EOD -> next trading day open
 * - Default cost: 0.23% round trip
 * - Train/Test split: first 60% / last 40% by signal date
 *
 * IMPORTANT LIMITATIONS
 * 1) Current market-cap universe is used historically unless --universe-file is provided -> survivorship bias.
 * 2) Current listed shares are used as a historical market-cap approximation -> share-count bias possible.
 * 3) H3/VWAP is EOD approximation using daily tradingValue/volume, not intraday 5-minute reconstruction.
 * 4) Cafe strategy is a TECH+SUPPLY proxy because historical point-in-time fundamentals are not included here.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(__dirname, "backtest-cache-v2");
const outDir = path.join(__dirname, "backtest-results-v2");
mkdirSync(cacheDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
loadDotEnv();

const args = parseArgs(process.argv.slice(2));

const today = new Date();
const endDate = args.end || yyyymmdd(today);
const years = Number(args.years || 2);
const startDate = args.start || yyyymmdd(addDays(today, -365 * years));
const warmupCalendarDays = Number(args.warmup || 900); // enough for 2y scout + 200d MAs at test start
const priceStartDate = args["price-start"] || yyyymmdd(addDays(parseYmd(startDate), -warmupCalendarDays));
const investorStartDate = args["investor-start"] || yyyymmdd(addDays(parseYmd(startDate), -60));
const universeMode = args.universe || "market";
const marketLimit = Number(args.limit || 100);
const maxTickers = args.max ? Number(args.max) : null;
const roundTripCostPct = Number(args.cost || 0.23);
const holdingDaysList = String(args.holds || "1,3,5,10,20,60").split(",").map(Number).filter((v) => Number.isFinite(v) && v > 0);
const trainRatio = clamp(Number(args.train || 0.60), 0.20, 0.85);
const rawOutput = args.raw === "1";
const KIS_BASE_URL = process.env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443";
const USER_AGENT = "Mozilla/5.0 DashboardBacktestLabV2/1.0";
const eok = 100_000_000;
let tokenPromise = null;
let lastKisCallAt = 0;

const LIQUIDITY_BINS = [
  [0, 29], [30, 39], [40, 49], [50, 59], [60, 69], [70, 79], [80, 89], [90, 100]
];
const COMBINED_BINS = [[0, 39], [40, 49], [50, 59], [60, 69], [70, 79], [80, 100]];
const SCOUT_100_BINS = [[0, 39], [40, 59], [60, 79], [80, 100]];
const SCOUT_30_BINS = [[0, 9], [10, 14], [15, 19], [20, 24], [25, 30]];

if (args["self-test"] === "1" || args.selftest === "1") {
  runSelfTest();
  process.exit(0);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

async function main() {
  console.log(`Backtest Lab V2 ${startDate}~${endDate}`);
  console.log(`price warm-up starts ${priceStartDate}; investor warm-up starts ${investorStartDate}`);
  console.log(`universe=${universeMode}, limit=${marketLimit}, holds=${holdingDaysList.join(",")}, cost=${roundTripCostPct}%`);

  const universe = (await loadUniverse()).slice(0, maxTickers || undefined);
  if (!universe.length) throw new Error("Universe is empty.");
  console.log(`Universe: ${universe.length} tickers`);

  const seriesByCode = new Map();
  const baseRows = [];
  const errors = [];

  for (let i = 0; i < universe.length; i += 1) {
    const item = universe[i];
    process.stdout.write(`[${i + 1}/${universe.length}] ${item.market || ""} ${item.code} ${item.name} ... `);
    try {
      const built = await buildTickerSeries(item);
      seriesByCode.set(item.code, built.series);
      baseRows.push(...built.rows);
      console.log(`${built.series.length} price days / ${built.rows.length} test rows`);
    } catch (error) {
      errors.push({ code: item.code, name: item.name, market: item.market || "", message: String(error.message || error) });
      console.log(`failed: ${error.message}`);
    }
  }

  if (!baseRows.length) throw new Error("No historical rows were built. Check KIS credentials/cache/network.");

  const byDateMarket = groupBy(baseRows, (r) => `${r.date}|${r.market}`);
  const observations = [];
  const sortedKeys = [...byDateMarket.keys()].sort();

  for (const key of sortedKeys) {
    const dayRows = byDateMarket.get(key);
    enrichCrossSection(dayRows);
    rankScout(dayRows);
    for (const row of dayRows) row.combined = buildCombinedDecision(row, row.scout);
    rankCombined(dayRows);
    for (const row of dayRows) {
      row.external = buildExternalSignals(row);
      row.combos = buildCombos(row);
      observations.push(flattenObservation(row));
    }
  }

  const uniqueDates = [...new Set(observations.map((r) => r.date))].sort();
  const splitIndex = Math.max(1, Math.min(uniqueDates.length - 1, Math.floor(uniqueDates.length * trainRatio)));
  const splitDate = uniqueDates[splitIndex] || uniqueDates.at(-1);
  for (const row of observations) row.sample = row.date < splitDate ? "TRAIN" : "TEST";

  const factorRows = buildFactorSummaries(observations);
  const strategyResult = buildStrategySummaries(observations);
  const strategyRows = strategyResult.summary;
  const strategyTrades = strategyResult.trades;
  const diagnostics = buildDiagnostics(observations, errors, splitDate, universe);

  const stamp = `${startDate}_${endDate}_${universeMode}_${marketLimit}`;
  const factorPath = path.join(outDir, `factor-summary-${stamp}.csv`);
  const strategyPath = path.join(outDir, `strategy-summary-${stamp}.csv`);
  const tradePath = path.join(outDir, `strategy-trades-${stamp}.csv`);
  const reportPath = path.join(outDir, `report-${stamp}.md`);
  const diagPath = path.join(outDir, `diagnostics-${stamp}.json`);
  const rawPath = path.join(outDir, `observations-${stamp}.csv`);

  writeFileSync(factorPath, toCsv(factorRows), "utf8");
  writeFileSync(strategyPath, toCsv(strategyRows), "utf8");
  writeFileSync(tradePath, toCsv(strategyTrades), "utf8");
  writeFileSync(diagPath, JSON.stringify(diagnostics, null, 2), "utf8");
  if (rawOutput) writeFileSync(rawPath, toCsv(observations), "utf8");
  writeFileSync(reportPath, buildReport({ observations, factorRows, strategyRows, diagnostics, universe, splitDate }), "utf8");

  console.log("\n=== TEST sample: 10-day strategy leaderboard (min 20 trades) ===");
  const leaderboard = strategyRows
    .filter((r) => r.sample === "TEST" && r.market === "ALL" && r.horizonDays === 10 && r.trades >= 20)
    .sort((a, b) => (b.avgReturnPct ?? -999) - (a.avgReturnPct ?? -999))
    .slice(0, 15);
  for (const r of leaderboard) {
    console.log(`${r.strategy.padEnd(30)} N=${String(r.trades).padStart(4)} win=${fmt(r.winRatePct)}% avg=${fmt(r.avgReturnPct)}% PF=${fmt(r.profitFactor)}`);
  }

  console.log("\nSaved:");
  console.log(`- ${factorPath}`);
  console.log(`- ${strategyPath}`);
  console.log(`- ${tradePath}`);
  console.log(`- ${reportPath}`);
  console.log(`- ${diagPath}`);
  if (rawOutput) console.log(`- ${rawPath}`);
  console.log("\nDo NOT paste the raw trade/observation CSV into Codex. Share strategy-summary/factor-summary/report only.");
}

async function loadUniverse() {
  if (args["universe-file"]) return loadUniverseFile(args["universe-file"]);
  if (universeMode === "market") {
    const [kospi, kosdaq] = await Promise.all([
      fetchMarketCapCandidates("KOSPI", marketLimit),
      fetchMarketCapCandidates("KOSDAQ", marketLimit)
    ]);
    return dedupe([...kospi, ...kosdaq]);
  }
  if (universeMode === "account") {
    try {
      return await fetchAccountUniverse();
    } catch (error) {
      console.warn(`Account universe failed -> portfolio.js fallback: ${error.message}`);
    }
  }
  return dedupe(portfolio.map((x) => ({ code: x.code, name: x.name, market: x.market || "UNKNOWN" })));
}

function loadUniverseFile(file) {
  const full = path.resolve(file);
  const text = readFileSync(full, "utf8");
  if (full.toLowerCase().endsWith(".json")) {
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : parsed.rows;
    return dedupe((rows || []).map((x) => ({ code: String(x.code || "").padStart(6, "0"), name: x.name || x.code, market: x.market || "UNKNOWN" })));
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines.shift().split(",").map((x) => x.trim());
  return dedupe(lines.map((line) => {
    const cells = parseCsvLine(line);
    const obj = Object.fromEntries(header.map((h, i) => [h, cells[i]]));
    return { code: String(obj.code || "").padStart(6, "0"), name: obj.name || obj.code, market: obj.market || "UNKNOWN" };
  }));
}

async function buildTickerSeries(item) {
  const prices = await fetchPriceHistory(item.code);
  const investors = await fetchInvestorHistory(item.code);
  const quote = await fetchQuote(item.code).catch(() => null);
  const listedShares = quote?.listedShares || null;
  const investorByDate = new Map(investors.map((x) => [x.date, x]));

  let foreignStreak = 0;
  let instStreak = 0;
  const series = prices.map((p) => {
    const inv = investorByDate.get(p.date) || emptyInvestor(p.date);
    foreignStreak = inv.foreignNetAmount > 0 ? foreignStreak + 1 : 0;
    instStreak = inv.instNetAmount > 0 ? instStreak + 1 : 0;
    return { ...p, ...inv, foreignStreak, instStreak };
  });

  const rows = [];
  for (let i = 25; i < series.length; i += 1) {
    const r = series[i];
    if (r.date < startDate || r.date > endDate) continue;
    const historyRows = series.slice(0, i + 1);
    const closes = historyRows.map((x) => x.close);
    const prev = series[i - 1];
    const base3 = series[i - 3];
    const tradingValue20 = avg(series.slice(Math.max(0, i - 20), i).map((x) => x.tradingValue));
    const marketCap = listedShares && r.close ? listedShares * r.close : null;
    const bodyTurnoverPct = marketCap ? (r.tradingValue / marketCap) * 100 : 0;
    const tradingValueRatio20 = tradingValue20 ? r.tradingValue / tradingValue20 : 0;
    const totalNetAmount = r.foreignNetAmount + r.instNetAmount;
    const smartMoneyBodyPct = marketCap ? (totalNetAmount / marketCap) * 100 : 0;
    const smartMoneyTradingSharePct = r.tradingValue ? (totalNetAmount / r.tradingValue) * 100 : 0;
    const liquidityScore = calcLiquidityScore({ tradingValue: r.tradingValue, bodyTurnoverPct, tradingValueRatio20, smartMoneyBodyPct, smartMoneyTradingSharePct });
    const vwap = r.volume ? r.tradingValue / r.volume : null;
    const reboundFromLowPct = r.low ? (r.close / r.low - 1) * 100 : 0;
    const vwapRecovered = Boolean(vwap && r.close >= vwap);
    const bullishTurn = r.close >= r.open;
    const foreign5 = sum(series.slice(Math.max(0, i - 4), i + 1).map((x) => x.foreignNetAmount));
    const inst5 = sum(series.slice(Math.max(0, i - 4), i + 1).map((x) => x.instNetAmount));

    const scoutBase = calcScoutBaseAt(historyRows);
    const leaderBase = calcLeaderBaseAt(historyRows);
    const flags = buildFlags({
      liquidityScore,
      change3dPct: base3?.close ? (r.close / base3.close - 1) * 100 : 0,
      dayChangePct: prev?.close ? (r.close / prev.close - 1) * 100 : 0,
      foreignStreak: r.foreignStreak,
      instStreak: r.instStreak,
      totalNetAmount,
      reboundFromLowPct,
      vwapRecovered,
      tradingValueRatio20,
      bodyTurnoverPct
    });

    rows.push({
      code: item.code,
      name: item.name,
      market: item.market || "UNKNOWN",
      date: r.date,
      seriesIndex: i,
      price: r.close,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      tradingValue: r.tradingValue,
      marketCap,
      listedSharesApprox: listedShares,
      foreignNetAmount: r.foreignNetAmount,
      instNetAmount: r.instNetAmount,
      foreign5,
      inst5,
      totalNetAmount,
      foreignStreak: r.foreignStreak,
      instStreak: r.instStreak,
      bodyTurnoverPct,
      tradingValueRatio20,
      smartMoneyBodyPct,
      smartMoneyTradingSharePct,
      liquidityScore,
      dayChangePct: prev?.close ? (r.close / prev.close - 1) * 100 : 0,
      change3dPct: base3?.close ? (r.close / base3.close - 1) * 100 : 0,
      vwap,
      vwapRecovered,
      reboundFromLowPct,
      bullishTurn,
      flags,
      scoutBase,
      leaderBase,
      outcomes: buildOutcomes(series, i)
    });
  }
  return { series, rows };
}

function calcScoutBaseAt(history) {
  const rows = history.slice(-520).filter((x) => Number.isFinite(x.close));
  const closes = rows.map((x) => x.close);
  const latest = closes.at(-1) ?? null;
  if (!latest) return null;
  const high2y = Math.max(...closes);
  const low2y = Math.min(...closes);
  const median2y = median(closes);
  const rawPos = high2y > low2y ? ((latest - low2y) / (high2y - low2y)) * 100 : null;
  const ma5 = maAt(closes, 5);
  const ma20 = maAt(closes, 20);
  const ma60 = maAt(closes, 60);
  const ma120 = maAt(closes, 120);
  const daysSinceLow = countDaysSinceLatestLow(rows);
  const vol = volumeProfile(rows);
  return {
    dataDays: rows.length,
    enoughData: rows.length >= 360,
    high2y,
    low2y,
    median2y,
    pricePositionPct: Number.isFinite(rawPos) ? clamp(rawPos, 0, 100) : null,
    drawdownFromHighPct: high2y ? (latest / high2y - 1) * 100 : null,
    reboundFromLowPct: low2y ? (latest / low2y - 1) * 100 : null,
    medianGapPct: median2y ? (latest / median2y - 1) * 100 : null,
    ma5, ma20, ma60, ma120,
    dist5: ma5 ? (latest / ma5 - 1) * 100 : null,
    dist20: ma20 ? (latest / ma20 - 1) * 100 : null,
    dist60: ma60 ? (latest / ma60 - 1) * 100 : null,
    dist120: ma120 ? (latest / ma120 - 1) * 100 : null,
    slope5: slopePct(closes, 5),
    slope20: slopePct(closes, 20),
    slope60: slopePct(closes, 60),
    slope120: slopePct(closes, 120),
    daysSinceLow,
    noNewLow5: Number.isFinite(daysSinceLow) ? daysSinceLow >= 5 : false,
    ret5: returnPctFrom(closes, 5),
    ret20: returnPctFrom(closes, 20),
    volumeUpDownRatio: vol.upAvg && vol.downAvg ? vol.upAvg / vol.downAvg : null,
    volumeImproving: vol.improving,
    volatility20: calcVolatility(closes, 20)
  };
}

function calcLeaderBaseAt(history) {
  const rows = history.filter((x) => Number.isFinite(x.close));
  const closes = rows.map((x) => x.close);
  const latest = closes.at(-1) ?? null;
  if (!latest) return null;
  const ma20 = maAt(closes, 20);
  const ma50 = maAt(closes, 50);
  const ma60 = maAt(closes, 60);
  const ma120 = maAt(closes, 120);
  const ma150 = maAt(closes, 150);
  const ma200 = maAt(closes, 200);
  const ma200Prev20 = maAt(closes, 200, closes.length - 20);
  const high52w = closes.length >= 252 ? Math.max(...closes.slice(-252)) : null;
  const low52w = closes.length >= 252 ? Math.min(...closes.slice(-252)) : null;
  const drawdown52wPct = high52w ? (latest / high52w - 1) * 100 : null;
  const month = monthlyFeatures(rows);

  let trendScore = 0;
  if (ma20 && latest > ma20) trendScore += 5;
  if (ma20 && ma60 && ma20 > ma60) trendScore += 5;
  if (ma60 && ma120 && ma60 > ma120) trendScore += 5;
  if ((slopePct(closes, 60) ?? -Infinity) > 0) trendScore += 7.5;
  if ((slopePct(closes, 120) ?? -Infinity) > 0) trendScore += 7.5;

  const highRetentionScore = Number.isFinite(drawdown52wPct)
    ? 20 * clamp((drawdown52wPct + 30) / 25, 0, 1) // -5% or better=20, -30%=0
    : null;

  let persistenceScore = 0;
  const ret60 = returnPctFrom(closes, 60);
  const ret120 = returnPctFrom(closes, 120);
  if ((ret60 ?? -Infinity) > 0) persistenceScore += 5;
  if ((ret120 ?? -Infinity) > 0) persistenceScore += 5;
  if (month.closeAboveMa5) persistenceScore += 5;
  if (month.ma5Rising) persistenceScore += 5;

  return {
    dataDays: closes.length,
    latest,
    ma20, ma50, ma60, ma120, ma150, ma200, ma200Prev20,
    slope60: slopePct(closes, 60),
    slope120: slopePct(closes, 120),
    ret20: returnPctFrom(closes, 20),
    ret60,
    ret120,
    high52w,
    low52w,
    drawdown52wPct,
    trendScore,
    highRetentionScore,
    persistenceScore,
    monthlyClose: month.monthlyClose,
    monthlyMa5: month.ma5,
    monthlyMa5Prev: month.ma5Prev,
    monthlyCloseAboveMa5: month.closeAboveMa5,
    monthlyMa5Rising: month.ma5Rising
  };
}

function monthlyFeatures(rows) {
  const monthEnds = [];
  let currentKey = null;
  let currentClose = null;
  for (const row of rows) {
    const key = String(row.date).slice(0, 6);
    if (currentKey !== null && key !== currentKey) monthEnds.push(currentClose);
    currentKey = key;
    currentClose = row.close; // current month's partial close: no future month-end leak
  }
  if (currentClose !== null) monthEnds.push(currentClose);
  const ma5 = monthEnds.length >= 5 ? avg(monthEnds.slice(-5)) : null;
  const ma5Prev = monthEnds.length >= 6 ? avg(monthEnds.slice(-6, -1)) : null;
  const monthlyClose = monthEnds.at(-1) ?? null;
  return {
    monthlyClose,
    ma5,
    ma5Prev,
    closeAboveMa5: Boolean(monthlyClose && ma5 && monthlyClose > ma5),
    ma5Rising: Boolean(ma5 && ma5Prev && ma5 > ma5Prev)
  };
}

function enrichCrossSection(rows) {
  const validScout = rows.filter((r) => r.scoutBase);
  const marketStats = {
    avgRet5: avg(validScout.map((r) => r.scoutBase.ret5)),
    avgRet20: avg(validScout.map((r) => r.scoutBase.ret20)),
    avgDist120: avg(validScout.map((r) => r.scoutBase.dist120))
  };

  const p20 = percentileMap(rows, (r) => r.leaderBase?.ret20);
  const p60 = percentileMap(rows, (r) => r.leaderBase?.ret60);
  const p120 = percentileMap(rows, (r) => r.leaderBase?.ret120);

  for (const row of rows) {
    row.scout = row.scoutBase ? enrichScoutScores(row.scoutBase, marketStats) : null;
    row.leader = row.leaderBase ? enrichLeaderScores(row.leaderBase, p20.get(row.code), p60.get(row.code), p120.get(row.code)) : null;
  }
}

function enrichScoutScores(base, marketStats) {
  const relative5 = finite2(base.ret5, marketStats.avgRet5, (a, b) => a - b);
  const relative20 = finite2(base.ret20, marketStats.avgRet20, (a, b) => a - b);
  const relativeDist120 = finite2(base.dist120, marketStats.avgDist120, (a, b) => a - b);
  const lowPriceScore = clamp((30 - (base.pricePositionPct ?? 100)) / 30, 0, 1) * 40;
  const drawdownScore = clamp((Math.abs(base.drawdownFromHighPct ?? 0) - 15) / 35, 0, 1) * 30;
  const medianGapScore = clamp(Math.abs(Math.min(base.medianGapPct ?? 0, 0)) / 35, 0, 1) * 15;
  const dataScore = base.enoughData ? 15 : 5;
  const cheapScore = Math.round(lowPriceScore + drawdownScore + medianGapScore + dataScore);

  const noLowScore = clamp((base.daysSinceLow ?? 0) / 20, 0, 1) * 25;
  const slope5Score = (base.slope5 ?? -1) > 0 ? 20 : clamp((base.slope5 ?? -5) + 5, 0, 5) / 5 * 8;
  const slope20Score = (base.slope20 ?? -1) > 0 ? 20 : clamp((base.slope20 ?? -5) + 5, 0, 5) / 5 * 8;
  const relativeScore = clamp(((relative20 ?? -10) + 8) / 16, 0, 1) * 20;
  const volumeScore = base.volumeImproving ? 15 : clamp(((base.volumeUpDownRatio ?? 0) - 0.8) / 0.7, 0, 1) * 8;
  const stabilizeScore = Math.round(noLowScore + slope5Score + slope20Score + relativeScore + volumeScore);

  let riskScore = 15;
  const riskReasons = ["하락 원인 미확인"];
  if (Number.isFinite(relativeDist120) && relativeDist120 <= -12) { riskScore += 15; riskReasons.push("시장 대비 120일선 괴리 과도"); }
  if (Number.isFinite(relative20) && relative20 <= -8) { riskScore += 15; riskReasons.push("20일 시장 대비 약세"); }
  if ((base.volatility20 ?? 0) >= 5) { riskScore += 10; riskReasons.push("변동성 급증"); }
  if ((base.daysSinceLow ?? 0) < 3) { riskScore += 15; riskReasons.push("최근 신저가 반복"); }
  if (!base.enoughData) { riskScore += 15; riskReasons.push("2년 데이터 부족"); }
  riskScore = Math.round(clamp(riskScore, 0, 100));

  const scoutCheap = (base.pricePositionPct ?? 100) <= 30 && (base.drawdownFromHighPct ?? 0) <= -20;
  const watchCheap = (base.pricePositionPct ?? 100) <= 40 && (base.drawdownFromHighPct ?? 0) <= -15;
  let status = "관찰 목록";
  let stage = 0;
  if (riskScore >= 65) { status = "추가매수 금지"; stage = 5; }
  else if (scoutCheap && stabilizeScore >= 65 && riskScore <= 35) { status = "1차 매수 검토"; stage = 3; }
  else if (scoutCheap && stabilizeScore >= 45 && riskScore <= 50) { status = "하락 정지 확인"; stage = 2; }
  else if (scoutCheap && riskScore <= 60) { status = "정찰병 1주"; stage = 1; }
  else if (watchCheap) { status = "관찰 목록"; stage = 0; }

  return { ...base, relative5, relative20, relativeDist120, cheapScore, stabilizeScore, riskScore, riskReasons, status, stage };
}

function enrichLeaderScores(base, pct20, pct60, pct120) {
  if (base.dataDays < 120) return { ...base, score: null, grade: "계산불가", relativeStrengthScore: null };
  const rs = [pct20, pct60, pct120].every(Number.isFinite) ? (pct20 + pct60 + pct120) * 10 : null;
  const componentsValid = [base.trendScore, rs, base.highRetentionScore, base.persistenceScore].every(Number.isFinite);
  const score = componentsValid ? rnd(clamp(base.trendScore + rs + base.highRetentionScore + base.persistenceScore, 0, 100), 1) : null;
  return { ...base, relativeStrengthScore: rs, score, grade: leaderGrade(score) };
}

function leaderGrade(score) {
  if (!Number.isFinite(score)) return "계산불가";
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 50) return "C";
  return "D";
}

function rankScout(rows) {
  const ranked = rows.filter((r) => r.scout).sort((a, b) =>
    scoutSortPriority(b.scout.status) - scoutSortPriority(a.scout.status)
    || b.scout.cheapScore - a.scout.cheapScore
    || b.scout.stabilizeScore - a.scout.stabilizeScore
    || a.scout.riskScore - b.scout.riskScore
  );
  ranked.forEach((r, i) => { r.scout.rank = i + 1; r.scout.total = ranked.length; });
}

function rankCombined(rows) {
  const ranked = rows.filter((r) => r.combined?.rankable).sort((a, b) =>
    b.combined.tier - a.combined.tier
    || b.combined.score - a.combined.score
    || b.combined.mainScore - a.combined.mainScore
    || (a.scout?.rank ?? 9999) - (b.scout?.rank ?? 9999)
  );
  ranked.forEach((r, i) => { r.combined.rank = i + 1; r.combined.total = ranked.length; });
}

function buildFlags(x) {
  const streak2 = Math.max(x.foreignStreak ?? 0, x.instStreak ?? 0) >= 2;
  const totalNetPositive = x.totalNetAmount > 0;
  const strongStreakBid = streak2 && x.liquidityScore >= 50;
  return {
    R: x.liquidityScore >= 60 && x.change3dPct >= -6 && x.change3dPct <= 3 && x.dayChangePct <= 5 && streak2 && totalNetPositive && x.vwapRecovered,
    F: x.liquidityScore >= 50 && x.change3dPct >= -8 && x.change3dPct <= 5 && totalNetPositive,
    F2: x.liquidityScore >= 50 && x.change3dPct >= -8 && x.change3dPct <= 5 && streak2 && totalNetPositive,
    B: x.liquidityScore >= 50 && streak2 && x.change3dPct <= 12 && x.dayChangePct <= 10 && totalNetPositive,
    C: x.liquidityScore >= 70,
    H2: x.dayChangePct >= -12 && x.dayChangePct <= -4 && x.reboundFromLowPct >= 1.5 && x.vwapRecovered && (x.tradingValueRatio20 >= 2 || x.bodyTurnoverPct >= 3) && totalNetPositive,
    H3: x.dayChangePct >= -12 && x.dayChangePct <= -5 && x.reboundFromLowPct >= 2 && x.vwapRecovered && strongStreakBid,
    I: x.dayChangePct < -12 || (x.dayChangePct <= -5 && (!x.vwapRecovered || x.reboundFromLowPct < 1.2))
  };
}

function buildCombinedDecision(row, scout) {
  const f = row.flags || {};
  const completeData = row.price > 0 && row.tradingValue > 0 && row.marketCap > 0;
  const overheat = row.dayChangePct >= 10 || row.change3dPct >= 12;
  const scoutRisk = scout?.riskScore ?? 50;
  const blocked = !completeData || Boolean(f.I) || overheat || scoutRisk >= 65;
  const strategySignal = Boolean(f.R || f.F || f.F2 || f.B || f.C || f.H3);

  let strategyPoints = 0;
  if (f.R) strategyPoints = 25;
  else if (f.F2) strategyPoints = 22;
  else if (f.F) strategyPoints = 18;
  else if (f.B && row.liquidityScore >= 50) strategyPoints = 13;
  else if (f.H3) strategyPoints = 11;
  else if (f.C) strategyPoints = 8;

  const liquidityPoints = clamp(row.liquidityScore / 100, 0, 1) * 20;
  let supplyPoints = 0;
  if (row.totalNetAmount > 0) supplyPoints += 4;
  supplyPoints += clamp(row.foreignStreak / 3, 0, 1) * 4;
  supplyPoints += clamp(row.instStreak / 3, 0, 1) * 4;
  if (row.smartMoneyBodyPct >= 0.3 || row.smartMoneyTradingSharePct >= 10) supplyPoints += 3;

  let technicalPoints = 0;
  if (row.vwapRecovered) technicalPoints += 4;
  if (row.change3dPct >= -8 && row.change3dPct <= 5) technicalPoints += 3;
  if (row.bullishTurn) technicalPoints += 3;

  const mainScore = Math.round(clamp(strategyPoints + liquidityPoints + supplyPoints + technicalPoints, 0, 70));
  const scoutScore = scout ? Math.round(clamp(scout.stabilizeScore * 0.15 + (100 - scoutRisk) * 0.10 + scout.cheapScore * 0.05, 0, 30)) : 0;
  const score = Math.round(clamp(mainScore + scoutScore, 0, 100));
  const rankable = !blocked && (strategySignal || score >= 40);

  let label = "관망", tier = 1, reason = "종합 매수조건 부족";
  if (!completeData) { label = "계산불가"; tier = 0; reason = "시세·거래 데이터 부족"; }
  else if (f.I || scoutRisk >= 65) { label = "매수보류"; tier = 0; reason = f.I ? "급락 미회복" : "정찰병 위험 높음"; }
  else if (overheat) { label = "추격주의"; tier = 0; reason = "당일 또는 3일 급등"; }
  else if (f.R && score >= 60) { label = "종합 최우선"; tier = 5; reason = "엄격 눌림·수급·정찰 조건"; }
  else if ((f.F2 || f.F) && score >= 50) { label = "종합 분할후보"; tier = 4; reason = f.F2 ? "눌림과 연속수급 확인" : "눌림과 순매수 확인"; }
  else if (f.H3) { label = "단기 특수"; tier = 3; reason = "강수급 낙주, 단기만"; }
  else if (rankable) { label = "관심 관찰"; tier = 2; reason = "일부 조건만 충족"; }

  const gateReason = !completeData ? "DATA" : f.I ? "I" : overheat ? "OVERHEAT" : scoutRisk >= 65 ? "SCOUT_RISK" : "PASS";
  return {
    score, mainScore, scoutScore,
    strategyPoints: Math.round(strategyPoints),
    liquidityPoints: Math.round(liquidityPoints),
    supplyPoints: Math.round(supplyPoints),
    technicalPoints: Math.round(technicalPoints),
    label, tier, rankable, blocked, reason, gateReason, overheat
  };
}

function buildExternalSignals(row) {
  const L = row.leader || {};
  const cafe = L.grade === "A"
    && L.monthlyCloseAboveMa5
    && L.monthlyMa5Rising
    && (row.foreign5 > 0 || row.inst5 > 0)
    && Number.isFinite(L.drawdown52wPct) && L.drawdown52wPct <= -5 && L.drawdown52wPct >= -15
    && Number.isFinite(L.ret5 ?? row.scoutBase?.ret5) && (L.ret5 ?? row.scoutBase.ret5) >= -8 && (L.ret5 ?? row.scoutBase.ret5) <= 2
    && row.dayChangePct < 10 && row.change3dPct < 12;

  const mtt = Number.isFinite(L.ma200)
    && row.price > L.ma150 && row.price > L.ma200
    && L.ma150 > L.ma200
    && Number.isFinite(L.ma200Prev20) && L.ma200 > L.ma200Prev20
    && L.ma50 > L.ma150 && L.ma50 > L.ma200
    && row.price > L.ma50
    && Number.isFinite(L.low52w) && row.price >= L.low52w * 1.30
    && Number.isFinite(L.high52w) && row.price >= L.high52w * 0.75;

  return {
    CAFE_LEADER_PULLBACK_PROXY: cafe,
    MINERVINI_MTT: mtt
  };
}

function buildCombos(row) {
  const leaderA = row.leader?.grade === "A";
  const scoutActionable = ["정찰병 1주", "하락 정지 확인", "1차 매수 검토"].includes(row.scout?.status);
  return {
    LEADER_A_AND_TOP: leaderA && row.combined?.label === "종합 최우선",
    LEADER_A_AND_R: leaderA && Boolean(row.flags?.R),
    LEADER_A_AND_F2: leaderA && Boolean(row.flags?.F2),
    LEADER_A_AND_SCOUT: leaderA && scoutActionable,
    LIQ70_AND_TOP: row.liquidityScore >= 70 && row.combined?.label === "종합 최우선"
  };
}

function buildOutcomes(series, signalIndex) {
  const out = {};
  const entry = series[signalIndex + 1];
  if (!entry?.open) return out;
  for (const h of holdingDaysList) {
    const exit = series[signalIndex + 1 + h];
    if (!exit?.close) continue;
    const window = series.slice(signalIndex + 1, signalIndex + 2 + h);
    const maxHigh = Math.max(...window.map((x) => x.high).filter(Number.isFinite));
    const minLow = Math.min(...window.map((x) => x.low).filter(Number.isFinite));
    out[h] = {
      entryDate: entry.date,
      entryPrice: entry.open,
      exitDate: exit.date,
      exitPrice: exit.close,
      netReturnPct: (exit.close / entry.open - 1) * 100 - roundTripCostPct,
      grossReturnPct: (exit.close / entry.open - 1) * 100,
      mfePct: Number.isFinite(maxHigh) ? (maxHigh / entry.open - 1) * 100 : null,
      maePct: Number.isFinite(minLow) ? (minLow / entry.open - 1) * 100 : null
    };
  }
  return out;
}

function flattenObservation(row) {
  const o = {
    date: row.date, code: row.code, name: row.name, market: row.market,
    liquidityScore: row.liquidityScore,
    combinedScore: row.combined?.score ?? null,
    mainScore: row.combined?.mainScore ?? null,
    scoutContribution: row.combined?.scoutScore ?? null,
    combinedRank: row.combined?.rank ?? null,
    combinedLabel: row.combined?.label ?? "",
    gateReason: row.combined?.gateReason ?? "",
    gatePass: row.combined?.gateReason === "PASS",
    leaderScore: row.leader?.score ?? null,
    leaderGrade: row.leader?.grade ?? "계산불가",
    leaderTrendScore: row.leader?.trendScore ?? null,
    leaderRsScore: row.leader?.relativeStrengthScore ?? null,
    leaderHighScore: row.leader?.highRetentionScore ?? null,
    leaderPersistenceScore: row.leader?.persistenceScore ?? null,
    scoutStatus: row.scout?.status ?? "계산불가",
    scoutCheapScore: row.scout?.cheapScore ?? null,
    scoutStabilizeScore: row.scout?.stabilizeScore ?? null,
    scoutRiskScore: row.scout?.riskScore ?? null,
    scoutRank: row.scout?.rank ?? null,
    R: Boolean(row.flags?.R), F: Boolean(row.flags?.F), F2: Boolean(row.flags?.F2), H3: Boolean(row.flags?.H3), I: Boolean(row.flags?.I),
    CAFE_LEADER_PULLBACK_PROXY: Boolean(row.external?.CAFE_LEADER_PULLBACK_PROXY),
    MINERVINI_MTT: Boolean(row.external?.MINERVINI_MTT),
    LEADER_A_AND_TOP: Boolean(row.combos?.LEADER_A_AND_TOP),
    LEADER_A_AND_R: Boolean(row.combos?.LEADER_A_AND_R),
    LEADER_A_AND_F2: Boolean(row.combos?.LEADER_A_AND_F2),
    LEADER_A_AND_SCOUT: Boolean(row.combos?.LEADER_A_AND_SCOUT),
    LIQ70_AND_TOP: Boolean(row.combos?.LIQ70_AND_TOP)
  };
  for (const h of holdingDaysList) {
    const x = row.outcomes?.[h];
    o[`r${h}`] = x?.netReturnPct ?? null;
    o[`mfe${h}`] = x?.mfePct ?? null;
    o[`mae${h}`] = x?.maePct ?? null;
    o[`entryDate${h}`] = x?.entryDate ?? null;
    o[`entryPrice${h}`] = x?.entryPrice ?? null;
    o[`exitDate${h}`] = x?.exitDate ?? null;
    o[`exitPrice${h}`] = x?.exitPrice ?? null;
  }
  return o;
}

function buildFactorSummaries(observations) {
  const dimensions = [
    { name: "종합점수", label: (r) => binLabel(r.combinedScore, COMBINED_BINS) },
    { name: "종합순위", label: (r) => rankBin(r.combinedRank) },
    { name: "거래강도", label: (r) => binLabel(r.liquidityScore, LIQUIDITY_BINS) },
    { name: "주도주등급", label: (r) => r.leaderGrade },
    { name: "종합판정", label: (r) => r.combinedLabel },
    { name: "Gate", label: (r) => r.gateReason },
    { name: "정찰병상태", label: (r) => r.scoutStatus },
    { name: "정찰병Cheap", label: (r) => binLabel(r.scoutCheapScore, SCOUT_100_BINS) },
    { name: "정찰병Stabilize", label: (r) => binLabel(r.scoutStabilizeScore, SCOUT_100_BINS) },
    { name: "정찰병Risk", label: (r) => binLabel(r.scoutRiskScore, SCOUT_100_BINS) },
    { name: "정찰병기여점수", label: (r) => binLabel(r.scoutContribution, SCOUT_30_BINS) }
  ];
  const samples = ["ALL", "TRAIN", "TEST"];
  const markets = ["ALL", "KOSPI", "KOSDAQ"];
  const out = [];
  for (const d of dimensions) {
    for (const sample of samples) {
      for (const market of markets) {
        const subset = observations.filter((r) => (sample === "ALL" || r.sample === sample) && (market === "ALL" || r.market === market));
        const groups = groupBy(subset, (r) => d.label(r) || "NA");
        for (const [bucket, rows] of groups) {
          if (bucket === "NA") continue;
          for (const h of holdingDaysList) out.push({ dimension: d.name, bucket, sample, market, horizonDays: h, ...metricBlock(rows, h) });
        }
      }
    }
  }
  return out;
}

function buildStrategySummaries(observations) {
  const specs = [
    ["종합_최우선", (r) => r.combinedLabel === "종합 최우선"],
    ["종합_분할후보", (r) => r.combinedLabel === "종합 분할후보"],
    ["R", (r) => r.R],
    ["F2", (r) => r.F2],
    ["H3_EOD근사", (r) => r.H3],
    ["거래강도70+", (r) => r.liquidityScore >= 70],
    ["Leader_A", (r) => r.leaderGrade === "A"],
    ["Leader_A+최우선", (r) => r.LEADER_A_AND_TOP],
    ["Leader_A+R", (r) => r.LEADER_A_AND_R],
    ["Leader_A+F2", (r) => r.LEADER_A_AND_F2],
    ["Leader_A+정찰병", (r) => r.LEADER_A_AND_SCOUT],
    ["거래강도70+최우선", (r) => r.LIQ70_AND_TOP],
    ["카페_주도주눌림_PROXY", (r) => r.CAFE_LEADER_PULLBACK_PROXY],
    ["Minervini_MTT", (r) => r.MINERVINI_MTT],
    ["Gate_PASS", (r) => r.gateReason === "PASS"],
    ["Gate_BLOCK", (r) => r.gateReason !== "PASS"]
  ];
  const samples = ["ALL", "TRAIN", "TEST"];
  const markets = ["ALL", "KOSPI", "KOSDAQ"];
  const summary = [];
  const trades = [];

  for (const [strategy, test] of specs) {
    for (const h of holdingDaysList) {
      const candidates = observations.filter((r) => test(r) && Number.isFinite(r[`r${h}`]));
      const selected = applyPerCodeCooldown(candidates, h);
      for (const row of selected) {
        trades.push({
          strategy, horizonDays: h, sample: row.sample, market: row.market,
          code: row.code, name: row.name, signalDate: row.date,
          entryDate: row[`entryDate${h}`], exitDate: row[`exitDate${h}`],
          entryPrice: row[`entryPrice${h}`], exitPrice: row[`exitPrice${h}`],
          netReturnPct: row[`r${h}`], mfePct: row[`mfe${h}`], maePct: row[`mae${h}`],
          combinedScore: row.combinedScore, combinedRank: row.combinedRank, liquidityScore: row.liquidityScore,
          leaderScore: row.leaderScore, leaderGrade: row.leaderGrade,
          scoutStatus: row.scoutStatus, combinedLabel: row.combinedLabel
        });
      }
      for (const sample of samples) {
        for (const market of markets) {
          const sub = selected.filter((r) => (sample === "ALL" || r.sample === sample) && (market === "ALL" || r.market === market));
          summary.push({ strategy, sample, market, horizonDays: h, ...strategyMetricBlock(sub, h) });
        }
      }
    }
  }
  return { summary, trades };
}

function applyPerCodeCooldown(rows, horizonDays) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
  const lastExitByCode = new Map();
  const out = [];
  for (const r of sorted) {
    const last = lastExitByCode.get(r.code);
    const entryDate = r[`entryDate${horizonDays}`];
    const exitDate = r[`exitDate${horizonDays}`];
    if (!entryDate || !exitDate) continue;
    if (last && entryDate <= last) continue;
    out.push(r);
    lastExitByCode.set(r.code, exitDate);
  }
  return out;
}

function metricBlock(rows, h) {
  const returns = rows.map((r) => r[`r${h}`]).filter(Number.isFinite);
  const mfes = rows.map((r) => r[`mfe${h}`]).filter(Number.isFinite);
  const maes = rows.map((r) => r[`mae${h}`]).filter(Number.isFinite);
  const wins = returns.filter((x) => x > 0);
  const losses = returns.filter((x) => x <= 0);
  const gp = sum(wins), gl = Math.abs(sum(losses));
  return {
    observations: returns.length,
    winRatePct: pct(wins.length, returns.length),
    avgReturnPct: rnd(avg(returns)), medianReturnPct: rnd(median(returns)),
    profitFactor: gl ? rnd(gp / gl, 2) : null,
    avgMfePct: rnd(avg(mfes)), avgMaePct: rnd(avg(maes)),
    hitPlus3Pct: pct(mfes.filter((x) => x >= 3).length, mfes.length),
    hitPlus5Pct: pct(mfes.filter((x) => x >= 5).length, mfes.length),
    hitMinus3Pct: pct(maes.filter((x) => x <= -3).length, maes.length),
    hitMinus5Pct: pct(maes.filter((x) => x <= -5).length, maes.length)
  };
}

function strategyMetricBlock(rows, h) {
  const base = metricBlock(rows, h);
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  let equity = 1, peak = 1, mdd = 0;
  for (const r of sorted) {
    equity *= 1 + (r[`r${h}`] || 0) / 100;
    peak = Math.max(peak, equity);
    mdd = Math.min(mdd, equity / peak - 1);
  }
  return { trades: base.observations, ...base, maxDrawdownPct: rnd(mdd * 100) };
}

function buildDiagnostics(observations, errors, splitDate, universe) {
  const leaderNA = observations.filter((r) => r.leaderGrade === "계산불가").length;
  const scoutNA = observations.filter((r) => r.scoutStatus === "계산불가").length;
  const marketCapMissing = observations.filter((r) => r.gateReason === "DATA").length;
  return {
    generatedAt: new Date().toISOString(),
    period: { startDate, endDate, priceStartDate, investorStartDate, splitDate, trainRatio },
    universe: { mode: universeMode, count: universe.length, marketLimit, historicalUniverseExact: Boolean(args["universe-file"]) },
    assumptions: {
      entry: "signal EOD -> next trading day open",
      roundTripCostPct,
      historicalMarketCap: "current listed shares x historical close (approximation)",
      h3: "daily EOD VWAP proxy; not intraday-exact",
      cafe: "technical+supply proxy; historical point-in-time fundamentals excluded",
      currentUniverseBias: !args["universe-file"]
    },
    counts: { observations: observations.length, leaderNA, scoutNA, marketCapMissing, errors: errors.length },
    errors: errors.slice(0, 100)
  };
}

function buildReport({ observations, factorRows, strategyRows, diagnostics, universe, splitDate }) {
  const lines = [];
  lines.push("# 주식 대시보드 통합 백테스트 V2");
  lines.push("");
  lines.push(`- 신호기간: ${startDate}~${endDate}`);
  lines.push(`- 가격 워밍업 시작: ${priceStartDate}`);
  lines.push(`- Universe: ${universeMode}, ${universe.length}종목`);
  lines.push(`- 진입: 신호 다음 거래일 시가`);
  lines.push(`- 비용: 왕복 ${roundTripCostPct}%`);
  lines.push(`- TRAIN/TEST 분할일: ${splitDate} (앞 ${Math.round(trainRatio * 100)}% / 뒤 ${Math.round((1 - trainRatio) * 100)}%)`);
  lines.push("");
  lines.push("## 반드시 읽을 한계");
  lines.push("");
  lines.push(`1. ${diagnostics.assumptions.currentUniverseBias ? "현재 시총 상위 Universe를 과거에도 적용하므로 survivorship bias가 있습니다." : "사용자 제공 Universe 파일을 사용했습니다."}`);
  lines.push("2. 과거 시총은 현재 상장주식수 × 당시 종가로 근사합니다. 유상증자/감자/분할 등이 있었던 종목은 거래강도 오차가 생길 수 있습니다.");
  lines.push("3. H3 낙주는 일봉 거래대금/거래량 VWAP 근사입니다. 장중 순서까지 재현하는 분봉 백테스트가 아닙니다.");
  lines.push("4. 카페전략은 실적 데이터가 없는 TECH+SUPPLY 프록시입니다. 완전한 '실적+수급+차트' 검증으로 부르지 않습니다.");
  lines.push("");
  lines.push("## TEST 10일 핵심 전략 비교");
  lines.push("");
  lines.push("|전략|N|승률|평균|중앙값|PF|MDD|+5%도달|-5%도달|");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  const core = strategyRows.filter((r) => r.sample === "TEST" && r.market === "ALL" && r.horizonDays === 10)
    .sort((a, b) => (b.avgReturnPct ?? -999) - (a.avgReturnPct ?? -999));
  for (const r of core) lines.push(`|${r.strategy}|${r.trades}|${fmt(r.winRatePct)}%|${fmt(r.avgReturnPct)}%|${fmt(r.medianReturnPct)}%|${fmt(r.profitFactor)}|${fmt(r.maxDrawdownPct)}%|${fmt(r.hitPlus5Pct)}%|${fmt(r.hitMinus5Pct)}%|`);
  lines.push("");
  lines.push("## 해석 원칙");
  lines.push("");
  lines.push("- TRAIN에서만 좋고 TEST에서 무너지는 조건은 채택하지 않습니다.");
  lines.push("- 승률만 보지 않고 평균수익, 중앙값, PF, MFE/MAE, MDD를 같이 봅니다.");
  lines.push("- 종합점수/순위는 점수가 높아질수록 성과가 단조롭게 좋아지는지 확인합니다.");
  lines.push("- 거래강도는 70+가 최선이라고 가정하지 않고 0~100 구간별로 검증합니다.");
  lines.push("- Leader A의 단독 성과뿐 아니라 A+최우선, A+R, A+F2, A+정찰병 교차조합을 봅니다.");
  lines.push("- Gate는 PASS가 BLOCK보다 실제로 우수한지 역추적합니다.");
  lines.push("");
  lines.push("## 결과 파일");
  lines.push("");
  lines.push("- factor-summary: 종합점수/순위/거래강도/Leader/판정/Scout/Gate 구간별 성과");
  lines.push("- strategy-summary: 실제 전략별 cooldown 적용 성과");
  lines.push("- strategy-trades: 전략별 개별 거래 (AI에 통째로 넣지 말 것)");
  lines.push("- diagnostics: 데이터 누락/가정/오류");
  if (rawOutput) lines.push("- observations: 모든 일자×종목 원자료 (대용량, AI에 통째로 넣지 말 것)");
  return `${lines.join("\n")}\n`;
}

// ---------------- Data access ----------------

async function fetchPriceHistory(code) {
  const key = `price-${code}-${priceStartDate}-${endDate}.json`;
  const cached = readCache(key);
  if (cached) return cached;
  let cursorEnd = endDate;
  const rows = [], seen = new Set();
  for (let page = 0; page < 30; page += 1) {
    const data = await kisGet("/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice", {
      FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: priceStartDate, FID_INPUT_DATE_2: cursorEnd,
      FID_PERIOD_DIV_CODE: "D", FID_ORG_ADJ_PRC: "0"
    }, "FHKST03010100");
    const chunk = data.output2 || [];
    if (!chunk.length) break;
    for (const x of chunk) {
      const date = x.stck_bsop_date;
      if (!date || seen.has(date)) continue;
      seen.add(date);
      rows.push({ date, open: num(x.stck_oprc), high: num(x.stck_hgpr), low: num(x.stck_lwpr), close: num(x.stck_clpr), volume: num(x.acml_vol), tradingValue: num(x.acml_tr_pbmn) });
    }
    const oldest = chunk.at(-1)?.stck_bsop_date;
    if (!oldest || oldest <= priceStartDate) break;
    cursorEnd = yyyymmdd(addDays(parseYmd(oldest), -1));
  }
  const result = rows.filter((r) => r.date >= priceStartDate && r.date <= endDate && r.close).sort((a, b) => a.date.localeCompare(b.date));
  writeCache(key, result);
  return result;
}

async function fetchInvestorHistory(code) {
  const key = `investor-${code}-${investorStartDate}-${endDate}.json`;
  const cached = readCache(key);
  if (cached) return cached;
  let cursor = endDate;
  const rows = [], seen = new Set();
  for (let page = 0; page < 35; page += 1) {
    const data = await kisGet("/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily", {
      FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code, FID_INPUT_DATE_1: cursor,
      FID_ORG_ADJ_PRC: "", FID_ETC_CLS_CODE: ""
    }, "FHPTJ04160001");
    const chunk = data.output2 || data.output || [];
    if (!chunk.length) break;
    for (const x of chunk) {
      const date = x.stck_bsop_date;
      if (!date || seen.has(date)) continue;
      seen.add(date);
      rows.push({ date, foreignNetAmount: num(x.frgn_ntby_tr_pbmn) * 1_000_000, instNetAmount: num(x.orgn_ntby_tr_pbmn) * 1_000_000 });
    }
    const oldest = chunk.at(-1)?.stck_bsop_date;
    if (!oldest || oldest <= investorStartDate) break;
    cursor = yyyymmdd(addDays(parseYmd(oldest), -1));
  }
  const result = rows.filter((r) => r.date >= investorStartDate && r.date <= endDate).sort((a, b) => a.date.localeCompare(b.date));
  writeCache(key, result);
  return result;
}

async function fetchQuote(code) {
  const key = `quote-${code}.json`;
  const cached = readCache(key, 1000 * 60 * 60 * 24 * 7);
  if (cached) return cached;
  const data = await kisGet("/uapi/domestic-stock/v1/quotations/inquire-price", { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code }, "FHKST01010100");
  const out = data.output || {};
  const result = { listedShares: num(out.lstn_stcn), name: out.hts_kor_isnm || code };
  writeCache(key, result);
  return result;
}

async function fetchAccountUniverse() {
  const account = kisAccountConfig();
  if (!account.cano) throw new Error("KIS account not configured");
  const data = await kisGet("/uapi/domestic-stock/v1/trading/inquire-balance", {
    CANO: account.cano, ACNT_PRDT_CD: account.product, AFHR_FLPR_YN: "N", OFL_YN: "",
    INQR_DVSN: "02", UNPR_DVSN: "01", FUND_STTL_ICLD_YN: "N", FNCG_AMT_AUTO_RDPT_YN: "N",
    PRCS_DVSN: "01", CTX_AREA_FK100: "", CTX_AREA_NK100: ""
  }, account.trId);
  return dedupe((data.output1 || []).filter((x) => num(x.hldg_qty) > 0).map((x) => ({ code: String(x.pdno).padStart(6, "0"), name: String(x.prdt_name || x.pdno).trim(), market: "UNKNOWN" })));
}

async function fetchMarketCapCandidates(market, count) {
  const key = `universe-${market}-${count}.json`;
  const cached = readCache(key, 1000 * 60 * 60 * 12);
  if (cached) return cached;
  const out = [], seen = new Set();
  const sosok = market === "KOSDAQ" ? "1" : "0";
  for (let page = 1; page <= 12 && out.length < count; page += 1) {
    const response = await fetch(`https://finance.naver.com/sise/sise_market_sum.naver?sosok=${sosok}&page=${page}`, { headers: { "user-agent": USER_AGENT, referer: "https://finance.naver.com/sise/" } });
    if (!response.ok) throw new Error(`Naver universe HTTP ${response.status}`);
    const html = await readKoreanHtml(response);
    const matches = html.matchAll(/<a\s+href="\/item\/main\.naver\?code=(\d{6})"[^>]*class="tltle"[^>]*>([\s\S]*?)<\/a>/g);
    for (const m of matches) {
      const code = m[1], name = stripHtml(m[2]);
      if (seen.has(code) || isExcludedMarketCandidate(name)) continue;
      seen.add(code); out.push({ code, name, market, rank: out.length + 1 });
      if (out.length >= count) break;
    }
  }
  writeCache(key, out);
  return out;
}

async function kisGet(endpoint, params, trId) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const token = await getKisToken();
      await throttleKis();
      const url = new URL(endpoint, KIS_BASE_URL);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      const response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: {
        authorization: `Bearer ${token}`, appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET,
        tr_id: trId, custtype: process.env.KIS_CUSTTYPE || "P", "user-agent": USER_AGENT
      }});
      const data = await response.json();
      if (!response.ok || (data.rt_cd && data.rt_cd !== "0")) throw new Error(data.msg1 || `KIS failed ${endpoint}`);
      return data;
    } catch (e) {
      lastError = e;
      const msg = String(e.message || "");
      const retryable = /초당|잠시|EGW|timeout|fetch failed/i.test(msg);
      if (!retryable || attempt === 3) break;
      await sleep(1200 * (attempt + 1));
    }
  }
  throw lastError;
}

async function getKisToken() {
  if (tokenPromise) return tokenPromise;
  tokenPromise = (async () => {
    const cached = readCache("kis-token.json", 1000 * 60 * 50);
    if (cached?.access_token) return cached.access_token;
    if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) throw new Error("KIS_APP_KEY/KIS_APP_SECRET missing in .env");
    const response = await fetch(`${KIS_BASE_URL}/oauth2/tokenP`, { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ grant_type: "client_credentials", appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET }) });
    const data = await response.json();
    if (!response.ok || !data.access_token) throw new Error(data.msg1 || data.error_description || "KIS token failed");
    writeCache("kis-token.json", data);
    return data.access_token;
  })();
  return tokenPromise;
}

async function throttleKis() {
  const gap = Number(process.env.KIS_REQUEST_GAP_MS || 160);
  const now = Date.now();
  const wait = Math.max(0, lastKisCallAt + gap - now);
  lastKisCallAt = now + wait;
  if (wait) await sleep(wait);
}

// ---------------- Utilities ----------------

function calcLiquidityScore({ tradingValue, bodyTurnoverPct, tradingValueRatio20, smartMoneyBodyPct, smartMoneyTradingSharePct }) {
  const absoluteValueScore = scaled((tradingValue ?? 0) / eok, 500, 3000, 10000);
  const bodyScore = scaled(bodyTurnoverPct, 1, 5, 20);
  const explosionScore = scaled(tradingValueRatio20, 1, 3, 10);
  const smartBodyScore = scaled(smartMoneyBodyPct, 0.1, 0.3, 1);
  const leadershipScore = scaled(smartMoneyTradingSharePct, 5, 10, 30);
  return Math.round(absoluteValueScore * 0.12 + bodyScore * 0.31 + explosionScore * 0.27 + smartBodyScore * 0.20 + leadershipScore * 0.10);
}
function scaled(value, weak, strong, extreme) {
  if (!Number.isFinite(value) || value <= weak) return 0;
  if (value >= extreme) return 100;
  if (value >= strong) return 70 + ((value - strong) / (extreme - strong)) * 30;
  return ((value - weak) / (strong - weak)) * 70;
}
function percentileMap(rows, getter) {
  const valid = rows.map((r) => ({ code: r.code, value: getter(r) })).filter((x) => Number.isFinite(x.value)).sort((a, b) => a.value - b.value);
  const out = new Map();
  if (!valid.length) return out;
  const n = valid.length;
  for (let i = 0; i < n; i += 1) out.set(valid[i].code, n === 1 ? 0.5 : i / (n - 1));
  return out;
}
function scoutSortPriority(status) { return { "1차 매수 검토": 5, "하락 정지 확인": 4, "정찰병 1주": 3, "관찰 목록": 2, "추가매수 금지": 1 }[status] ?? 0; }
function volumeProfile(rows) {
  const recent = rows.slice(-20), up = [], down = [];
  for (let i = 1; i < recent.length; i += 1) {
    const p = recent[i - 1], r = recent[i];
    if (!Number.isFinite(r.volume) || !Number.isFinite(r.close) || !Number.isFinite(p.close)) continue;
    (r.close >= p.close ? up : down).push(r.volume);
  }
  return { upAvg: avg(up), downAvg: avg(down), improving: Number.isFinite(avg(up)) && Number.isFinite(avg(down)) ? avg(up) > avg(down) : false };
}
function calcVolatility(closes, days) {
  const rets = [];
  for (let i = Math.max(1, closes.length - days); i < closes.length; i += 1) if (closes[i - 1]) rets.push((closes[i] / closes[i - 1] - 1) * 100);
  if (!rets.length) return null;
  const m = avg(rets); return Math.sqrt(avg(rets.map((x) => (x - m) ** 2)));
}
function countDaysSinceLatestLow(rows) {
  let low = Infinity, idx = -1;
  rows.forEach((r, i) => { if (Number.isFinite(r.close) && r.close <= low) { low = r.close; idx = i; } });
  return idx >= 0 ? rows.length - 1 - idx : null;
}
function maAt(closes, period, endExclusive = closes.length) { return endExclusive >= period ? avg(closes.slice(endExclusive - period, endExclusive)) : null; }
function slopePct(closes, period, lag = 5) { const now = maAt(closes, period), prev = maAt(closes, period, closes.length - lag); return now && prev ? (now / prev - 1) * 100 : null; }
function returnPctFrom(closes, days) { if (closes.length <= days) return null; const b = closes.at(-1 - days), l = closes.at(-1); return b && l ? (l / b - 1) * 100 : null; }
function finite2(a, b, fn) { return Number.isFinite(a) && Number.isFinite(b) ? fn(a, b) : null; }
function rankBin(rank) { if (!Number.isFinite(rank)) return "NA"; if (rank <= 5) return "1-5"; if (rank <= 10) return "6-10"; if (rank <= 20) return "11-20"; if (rank <= 50) return "21-50"; return "51+"; }
function binLabel(value, bins) { if (!Number.isFinite(value)) return "NA"; for (const [a, b] of bins) if (value >= a && value <= b) return `${a}-${b}`; return "NA"; }
function groupBy(rows, keyFn) { const m = new Map(); for (const r of rows) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; }
function avg(values) { const v = values.filter(Number.isFinite); return v.length ? sum(v) / v.length : null; }
function sum(values) { return values.filter(Number.isFinite).reduce((s, x) => s + x, 0); }
function median(values) { const v = values.filter(Number.isFinite).sort((a, b) => a - b); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; }
function pct(n, d) { return d ? rnd(n / d * 100) : null; }
function rnd(x, digits = 2) { return Number.isFinite(x) ? Number(x.toFixed(digits)) : null; }
function fmt(x) { return Number.isFinite(x) ? Number(x).toFixed(2) : ""; }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function num(value) { if (value === null || value === undefined || value === "") return 0; const n = Number(String(value).replace(/[,+%\s]/g, "")); return Number.isFinite(n) ? n : 0; }
function emptyInvestor(date) { return { date, foreignNetAmount: 0, instNetAmount: 0 }; }
function yyyymmdd(date) { return date.toISOString().slice(0, 10).replace(/-/g, ""); }
function parseYmd(v) { return new Date(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T00:00:00+09:00`); }
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i += 1) { const a = argv[i]; if (!a.startsWith("--")) continue; const k = a.slice(2), n = argv[i + 1]; if (!n || n.startsWith("--")) out[k] = "1"; else { out[k] = n; i += 1; } } return out; }
function loadDotEnv() { const f = path.join(__dirname, ".env"); if (!existsSync(f)) return; for (const line of readFileSync(f, "utf8").split(/\r?\n/)) { const m = line.match(/^([^#=]+)=(.*)$/); if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, ""); } }
function kisAccountConfig() { const c = process.env.KIS_ACCOUNT_NO || process.env.KIS_ACCOUNT || ""; const m = String(c).trim().match(/^(\d{8})[-\s]?(\d{2})$/); return { cano: process.env.KIS_CANO || process.env.KIS_ACCOUNT_CANO || m?.[1] || "", product: process.env.KIS_ACNT_PRDT_CD || process.env.KIS_ACCOUNT_PRODUCT_CODE || m?.[2] || "01", trId: process.env.KIS_BALANCE_TR_ID || (process.env.KIS_VIRTUAL === "1" ? "VTTC8434R" : "TTTC8434R") }; }
function readCache(name, ttl = Infinity) { const f = path.join(cacheDir, name); if (!existsSync(f)) return null; const p = JSON.parse(readFileSync(f, "utf8")); if (p.__createdAt && Date.now() - p.__createdAt > ttl) return null; return p.value ?? p; }
function writeCache(name, value) { writeFileSync(path.join(cacheDir, name), JSON.stringify({ __createdAt: Date.now(), value }), "utf8"); }
function dedupe(rows) { const s = new Set(); return rows.filter((r) => /^\d{6}$/.test(r.code) && !s.has(r.code) && s.add(r.code)); }
function isExcludedMarketCandidate(name = "") { const n = String(name).toUpperCase().replace(/\s/g, ""); const ks = ["KODEX", "TIGER", "ACE", "SOL", "KBSTAR", "HANARO", "RISE", "PLUS", "TIMEFOLIO", "ETF", "ETN", "인버스", "레버리지", "선물", "스팩", "SPAC"]; return ks.some((k) => n.includes(k)) || /우(B|C)?$/.test(String(name).trim()); }
function stripHtml(v = "") { return String(v).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").trim(); }
async function readKoreanHtml(response) { const b = await response.arrayBuffer(); const e = new TextDecoder("euc-kr").decode(b); return !e.includes("�") ? e : new TextDecoder("utf-8").decode(b); }
function toCsv(rows) { if (!rows.length) return ""; const cols = Object.keys(rows[0]); return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n"); }
function csvCell(v) { if (v === null || v === undefined) return ""; const t = String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }
function parseCsvLine(line) { const out = []; let cur = "", q = false; for (let i = 0; i < line.length; i += 1) { const c = line[i]; if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i += 1; } else q = !q; } else if (c === "," && !q) { out.push(cur); cur = ""; } else cur += c; } out.push(cur); return out; }

function runSelfTest() {
  const assert = (cond, msg) => { if (!cond) throw new Error(`SELF-TEST FAIL: ${msg}`); };
  assert(leaderGrade(85) === "A" && leaderGrade(84.9) === "B" && leaderGrade(70) === "B" && leaderGrade(50) === "C" && leaderGrade(49.9) === "D", "Leader grade boundaries");
  const liq = calcLiquidityScore({ tradingValue: 3000 * eok, bodyTurnoverPct: 5, tradingValueRatio20: 3, smartMoneyBodyPct: 0.3, smartMoneyTradingSharePct: 10 });
  assert(liq >= 65 && liq <= 75, `Liquidity score anchor expected ~70, got ${liq}`);
  const flags = buildFlags({ liquidityScore: 65, change3dPct: 0, dayChangePct: 1, foreignStreak: 2, instStreak: 0, totalNetAmount: 1, reboundFromLowPct: 1, vwapRecovered: true, tradingValueRatio20: 1, bodyTurnoverPct: 1 });
  assert(flags.R && flags.F && flags.F2 && flags.B, "R/F/F2/B nesting");
  const scout = { stabilizeScore: 70, riskScore: 30, cheapScore: 80 };
  const row = { price: 100, tradingValue: 100000000000, marketCap: 1000000000000, flags, liquidityScore: 65, totalNetAmount: 1, foreignStreak: 2, instStreak: 0, smartMoneyBodyPct: 0.4, smartMoneyTradingSharePct: 12, vwapRecovered: true, change3dPct: 0, bullishTurn: true, dayChangePct: 1 };
  const c = buildCombinedDecision(row, scout);
  assert(c.mainScore >= 50 && c.score >= c.mainScore && c.label === "종합 최우선", "Combined decision structure");
  assert(binLabel(70, LIQUIDITY_BINS) === "70-79" && rankBin(5) === "1-5" && rankBin(6) === "6-10", "Binning");
  console.log("SELF-TEST PASS");
  console.log({ liquidityAnchor: liq, combinedExample: c });
}
