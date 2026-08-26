// Live (out-of-sample) strategy tracker.
//
// Purpose: every trading day, after the EOD full refresh has produced the
// confirmed market payload, freeze what each existing strategy would have
// picked, then score those picks on future data only.
//
// Hard rules baked into this module:
//   1. It never computes a new investment score. Every selector reads factors
//      the live dashboard already produced (Leader / RS20 / 종합타이밍 /
//      Ranking V2 / Scout / flags / CAFE / MTT / simulator entry verdict).
//   2. It never writes into the simulator ledger or the Ranking V2 OOS files.
//      Its own files are strategy-oos-*.
//   3. A stored snapshot is immutable. Later runs may only fill in future
//      performance; factors, ranks and member lists are never recomputed.
//   4. A missing day stays missing. There is no back-fill from current data.
//   5. Missing factors are never coerced to 0/false. The stock is dropped from
//      the strategies that need that field and counted in diagnostics.
//
// Storage layout (one EOD row per stock, plus one row per strategy/day/market)
// instead of one row per strategy member, so ~94 strategies cost one shared
// feature set rather than 94 copies of every stock.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { freezeBaseConsensus } from "./public/strategy-consensus.js";
import { rankMarketRowsV2, reboundRankingTier } from "./public/rebound-ranking-v2.js";
import { simulationCategory } from "./simulation-category.js";
import {
  FEATURED_STRATEGY_IDS,
  RANKERS,
  STRATEGY_GROUPS,
  STRATEGY_HORIZONS,
  STRATEGY_OOS_COST_PCT,
  STRATEGY_OOS_SCHEMA,
  enabledStrategies,
  hasRequiredFields,
  strategyMeta
} from "./strategy-oos-registry.js";

export const MARKETS = ["KOSPI", "KOSDAQ"];

// Same degradation guard the Ranking V2 tracker uses: one transient KIS error
// must not discard a trading day, but a broadly broken run must not be stored.
export const STRATEGY_MAX_ERROR_RATIO = 0.1;
export const STRATEGY_MAX_ERROR_ABSOLUTE = 3;

// KST minute-of-day from which an EOD snapshot may be taken (15:30 close).
export const STRATEGY_EOD_MIN_KST_MINUTES = 15 * 60 + 30;

export const SAMPLE_GRADES = [
  { min: 50, label: "누적 의미 있음", key: "solid" },
  { min: 20, label: "비교 가능", key: "comparable" },
  { min: 10, label: "초기 참고", key: "early" },
  { min: 0, label: "표본 부족", key: "insufficient" }
];

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function numberOrNull(value) {
  return finite(value) ? Number(value) : null;
}

function boolOrNull(source, value) {
  return source ? value === true : null;
}

function ensureParent(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function atomicWrite(filePath, content) {
  ensureParent(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, content, "utf8");
  renameSync(tempPath, filePath);
}

export function readJsonl(filePath) {
  if (!existsSync(filePath)) return { records: [], invalidLines: 0 };
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  const records = [];
  let invalidLines = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      invalidLines += 1;
    }
  }
  return { records, invalidLines };
}

function writeJsonl(filePath, records) {
  atomicWrite(filePath, records.length ? `${records.map((row) => JSON.stringify(row)).join("\n")}\n` : "");
}

function appendJsonl(filePath, records) {
  if (!records.length) return;
  ensureParent(filePath);
  appendFileSync(filePath, `${records.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function compactDate(date) {
  return String(date ?? "").replace(/-/g, "");
}

export function seoulParts(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

/**
 * A snapshot may only be taken once the session it describes is closed:
 * the payload's trading date must be today (KST) and the clock must be past
 * the 15:30 close. Anything else - an intraday refresh, a stale trading date,
 * a weekend re-run - is rejected, which is also what keeps a missing day
 * missing instead of being back-filled from later data.
 */
export function isEodSnapshotAllowed({ marketDataAsOf, now = new Date(), minMinutes = STRATEGY_EOD_MIN_KST_MINUTES }) {
  const { date, minuteOfDay } = seoulParts(now);
  if (!marketDataAsOf) return { allowed: false, reason: "NO_TRADING_DATE", today: date };
  if (marketDataAsOf !== date) return { allowed: false, reason: "NOT_TODAY_TRADING_DATE", today: date };
  if (minuteOfDay < minMinutes) return { allowed: false, reason: "BEFORE_MARKET_CLOSE", today: date };
  return { allowed: true, reason: "EOD_CONFIRMED", today: date };
}

/**
 * One shared feature set per stock. Every strategy selector reads this object,
 * so adding strategies never adds KIS calls or re-computation.
 *
 * Every field is either a real value from the payload or null. Nothing is
 * defaulted to 0 or false.
 */
export function featureFromRow(row, market) {
  const scout = row?.scout ?? null;
  const leader = row?.leader ?? null;
  const combined = row?.combined ?? null;
  const confirmation = row?.confirmation ?? null;
  const supply = row?.supply ?? null;
  const rawFlags = row?.strategy?.flags ?? null;
  const category = row?.strategy ? simulationCategory(row) : null;
  const price = numberOrNull(row?.price ?? row?.quote?.price);
  const grade = leader?.grade && leader.grade !== "계산불가" ? leader.grade : null;
  const leaderScore = numberOrNull(leader?.score);
  // leader.rank starts life as the screener's market-cap rank and is only
  // overwritten with the real Leader rank for stocks that actually have a
  // Leader score. Without this guard a "계산불가" stock would sneak into
  // LEADER_TOP-N carrying a market-cap rank of 1.
  const leaderRank = leaderScore === null ? null : numberOrNull(leader?.rank);
  const combinedLabel = combined?.label && combined.label !== "계산불가" ? combined.label : null;

  return {
    code: String(row?.code ?? ""),
    name: row?.name ?? "",
    market,
    signalPrice: price,
    baseValid: Boolean(row?.code) && finite(price) && Number(price) > 0,
    leaderScore,
    leaderGrade: grade,
    leaderRank,
    rs20: numberOrNull(scout?.rs20),
    rsRank: null,
    combinedScore: numberOrNull(combined?.score),
    combinedRank: numberOrNull(combined?.rank),
    combinedDecision: combinedLabel,
    combinedTier: numberOrNull(combined?.tier),
    rankingV2Tier: null,
    rankingV2Rank: null,
    scoutRank: numberOrNull(scout?.reboundRank),
    scoutStatus: scout?.status && scout.status !== "계산불가" ? scout.status : null,
    reboundStatus: confirmation?.reboundState?.key ?? null,
    drawdownPct: numberOrNull(scout?.drawdownFromHighPct),
    riskScore: numberOrNull(scout?.riskScore),
    stabilizeScore: numberOrNull(scout?.stabilizeScore),
    liquidityScore: numberOrNull(supply?.liquidityScore),
    foreignStreak: numberOrNull(supply?.foreignStreak),
    institutionStreak: numberOrNull(supply?.instStreak),
    flags: rawFlags
      ? Object.fromEntries(["R", "F", "F2", "B", "C", "H2", "H3", "I"].map((key) => [key, rawFlags[key] === true]))
      : null,
    cafe: boolOrNull(confirmation, confirmation?.cafePass),
    mtt: boolOrNull(confirmation, confirmation?.minerviniPass),
    leaderRebound: boolOrNull(confirmation, confirmation?.leaderReboundPass),
    deepRecovery: boolOrNull(confirmation, confirmation?.deepRecoveryPass),
    actionable: category ? category.actionable === true : null,
    simCategory: category?.key ?? null,
    simCategoryLabel: category?.label ?? null
  };
}

/**
 * Builds the per-market feature sets.
 *
 * Ranks are taken from the live payload (Leader / 종합타이밍 / Scout) or from
 * the live comparator (Ranking V2), computed over the *whole* market exactly
 * like the dashboard does, before any stock is dropped. Rows whose KIS data
 * failed are then removed, so a recorded rank always means the same thing as
 * the rank on screen.
 */
export function buildFeatureRows(payload, { failedCodes = new Set() } = {}) {
  const byMarket = {};
  const diagnostics = [];
  const rankedTotals = {};
  for (const market of MARKETS) {
    const rows = payload?.rows?.[market] ?? [];
    const v2Order = new Map(rankMarketRowsV2(rows).map((row, index) => [String(row?.code ?? ""), index + 1]));
    const features = rows.map((row) => {
      const feature = featureFromRow(row, market);
      feature.rankingV2Rank = v2Order.get(feature.code) ?? null;
      feature.rankingV2Tier = row?.scout ? reboundRankingTier(row) : null;
      return feature;
    });

    // RS20 has no live ranked screen; rank it here, deterministically.
    const rsOrder = features
      .filter((feature) => finite(feature.rs20))
      .sort((a, b) => Number(b.rs20) - Number(a.rs20) || a.code.localeCompare(b.code));
    rsOrder.forEach((feature, index) => {
      feature.rsRank = index + 1;
    });

    rankedTotals[market] = Object.fromEntries(Object.values(RANKERS).map((ranker) => [
      ranker.id,
      features.filter((feature) => finite(feature[ranker.field])).length
    ]));

    const kept = [];
    for (const feature of features) {
      if (failedCodes.has(feature.code)) {
        diagnostics.push({ market, code: feature.code, name: feature.name, reason: "KIS_DATA_ERROR" });
        continue;
      }
      if (!feature.baseValid) {
        diagnostics.push({ market, code: feature.code, name: feature.name, reason: "NO_PRICE" });
        continue;
      }
      kept.push(feature);
    }
    byMarket[market] = kept;
  }
  return { byMarket, diagnostics, rankedTotals };
}

function selectionMembers(strategy, features, rankedTotal) {
  const eligible = features.filter((feature) => hasRequiredFields(feature, strategy.requires));
  const naCount = features.length - eligible.length;

  if (strategy.type === "ranking") {
    const field = RANKERS[strategy.ranker].field;
    const targetCount = Math.min(strategy.topN, rankedTotal ?? strategy.topN);
    const members = eligible
      .filter((feature) => finite(feature[field]) && Number(feature[field]) <= strategy.topN)
      .sort((a, b) => Number(a[field]) - Number(b[field]))
      .map((feature) => ({ code: feature.code, name: feature.name, rank: Number(feature[field]) }));
    return { members, targetCount, eligibleCount: eligible.length, naCount };
  }

  // Condition strategies are never cut to a TOP-N: 2 stocks stay 2, 25 stay 25.
  const members = eligible
    .filter((feature) => strategy.selector(feature) === true)
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((feature) => ({ code: feature.code, name: feature.name, rank: null }));
  return { members, targetCount: members.length, eligibleCount: eligible.length, naCount };
}

function dedupeMembers(members) {
  const seen = new Set();
  const unique = [];
  for (const member of members) {
    if (seen.has(member.code)) continue;
    seen.add(member.code);
    unique.push(member);
  }
  return unique;
}

export function buildSelections({ byMarket, rankedTotals }, { signalDate, recordedAt, strategies = enabledStrategies() }) {
  const selections = [];
  for (const market of MARKETS) {
    const features = byMarket[market] ?? [];
    if (!features.length) continue;
    for (const strategy of strategies) {
      const { members, targetCount, eligibleCount, naCount } = selectionMembers(
        strategy,
        features,
        rankedTotals?.[market]?.[strategy.ranker ?? ""] ?? null
      );
      const unique = dedupeMembers(members);
      selections.push({
        schemaVersion: STRATEGY_OOS_SCHEMA,
        signalDate,
        recordedAt,
        market,
        strategyId: strategy.id,
        strategyType: strategy.type,
        group: strategy.group,
        subGroup: strategy.subGroup,
        targetCount,
        validCount: unique.length,
        eligibleCount,
        naCount,
        members: unique
      });
    }
  }
  return selections;
}

export function buildUniverseRecords({ byMarket }, { signalDate, recordedAt, universeMeta = null }) {
  const records = [];
  for (const market of MARKETS) {
    for (const feature of byMarket[market] ?? []) {
      const { code, name, market: featureMarket, signalPrice, baseValid, ...factors } = feature;
      records.push({
        schemaVersion: STRATEGY_OOS_SCHEMA,
        signalDate,
        recordedAt,
        market: featureMarket,
        code,
        name,
        signalPrice,
        factors,
        frozenConsensus: freezeBaseConsensus(factors),
        universeMeta,
        entryDate: null,
        entryOpen: null,
        entryGapPct: null,
        entryDayOutcome: null,
        outcomes: {},
        live: null,
        status: "PENDING"
      });
    }
  }
  return records;
}

export function latestTradingDate(history) {
  return (history ?? [])
    .map((row) => String(row?.date ?? ""))
    .filter((date) => /^\d{8}$/.test(date))
    .sort()
    .at(-1) ?? null;
}

export function deriveSignalDate(historyByCode) {
  const counts = new Map();
  for (const history of historyByCode?.values?.() ?? []) {
    const date = latestTradingDate(history);
    if (date) counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0]?.[0];
  return best ? `${best.slice(0, 4)}-${best.slice(4, 6)}-${best.slice(6, 8)}` : null;
}

function normalizedSeries(history) {
  const byDate = new Map();
  for (const row of history ?? []) {
    if (!/^\d{8}$/.test(String(row?.date ?? "")) || !finite(row.close)) continue;
    byDate.set(String(row.date), {
      date: String(row.date),
      open: numberOrNull(row.open),
      high: numberOrNull(row.high),
      low: numberOrNull(row.low),
      close: Number(row.close)
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Entry is always the next trading day's open after the signal date - never
 * the signal day's close - and the horizon exits are that entry day plus
 * 1/3/5/10/20 sessions, the same convention as the Ranking V2 tracker and
 * backtest V2.1/V3.
 *
 * `live` carries the still-running position: today's close, the return so far,
 * how many sessions have passed, and the running MFE/MAE. It is capped at the
 * longest horizon so a finished trade's "현재" value cannot drift past its
 * confirmed 20D result.
 */
export function evaluateUniverseRecord(record, history, {
  evaluatedAt = new Date().toISOString(),
  costPct = STRATEGY_OOS_COST_PCT,
  horizons = STRATEGY_HORIZONS
} = {}) {
  const series = normalizedSeries(history);
  const signalIndex = series.findIndex((row) => row.date === compactDate(record.signalDate));
  if (signalIndex < 0) return record;
  const entryIndex = signalIndex + 1;
  const entry = series[entryIndex];
  if (!entry?.open) return record;

  let changed = false;
  const next = { ...record, outcomes: { ...(record.outcomes ?? {}) } };
  if (!next.frozenConsensus && next.factors) {
    next.frozenConsensus = freezeBaseConsensus(next.factors);
    changed = true;
  }
  if (!next.entryDate || !finite(next.entryOpen)) {
    next.entryDate = entry.date;
    next.entryOpen = entry.open;
    changed = true;
  }
  if (!finite(next.entryGapPct) && finite(next.signalPrice) && Number(next.signalPrice) > 0) {
    next.entryGapPct = (entry.open / Number(next.signalPrice) - 1) * 100;
    changed = true;
  }
  if (!next.entryDayOutcome && finite(entry.close)) {
    const grossReturnPct = (entry.close / entry.open - 1) * 100;
    const high = finite(entry.high) ? Number(entry.high) : Number(entry.close);
    const low = finite(entry.low) ? Number(entry.low) : Number(entry.close);
    next.entryDayOutcome = {
      targetTradingDate: entry.date,
      evaluatedAt,
      exitPrice: entry.close,
      grossReturnPct,
      netReturnPct: grossReturnPct - costPct,
      returnPct: grossReturnPct - costPct,
      mfePct: (high / entry.open - 1) * 100,
      maePct: (low / entry.open - 1) * 100,
      benchmarkReturnPct: null,
      excessReturnPct: null
    };
    changed = true;
  }

  for (const horizon of horizons) {
    const key = String(horizon);
    if (next.outcomes[key]) continue; // stored results are never recomputed
    const exit = series[entryIndex + horizon];
    if (!exit?.close) continue;
    const window = series.slice(entryIndex, entryIndex + horizon + 1);
    const highs = window.map((row) => row.high ?? row.close).filter(finite).map(Number);
    const lows = window.map((row) => row.low ?? row.close).filter(finite).map(Number);
    const grossReturnPct = (exit.close / entry.open - 1) * 100;
    next.outcomes[key] = {
      targetTradingDate: exit.date,
      evaluatedAt,
      exitPrice: exit.close,
      grossReturnPct,
      netReturnPct: grossReturnPct - costPct,
      returnPct: grossReturnPct - costPct,
      mfePct: highs.length ? (Math.max(...highs) / entry.open - 1) * 100 : null,
      maePct: lows.length ? (Math.min(...lows) / entry.open - 1) * 100 : null,
      benchmarkReturnPct: null,
      excessReturnPct: null
    };
    changed = true;
  }

  const maxHorizon = Math.max(...horizons);
  const liveIndex = Math.min(series.length - 1, entryIndex + maxHorizon);
  const liveRow = series[liveIndex];
  if (liveRow) {
    const window = series.slice(entryIndex, liveIndex + 1);
    const highs = window.map((row) => row.high ?? row.close).filter(finite).map(Number);
    const lows = window.map((row) => row.low ?? row.close).filter(finite).map(Number);
    const grossReturnPct = (liveRow.close / entry.open - 1) * 100;
    const live = {
      currentPrice: liveRow.close,
      currentReturnPct: grossReturnPct - costPct,
      currentGrossReturnPct: grossReturnPct,
      tradingDaysElapsed: liveIndex - entryIndex,
      currentMFE: highs.length ? (Math.max(...highs) / entry.open - 1) * 100 : null,
      currentMAE: lows.length ? (Math.min(...lows) / entry.open - 1) * 100 : null,
      lastEvaluatedDate: liveRow.date
    };
    if (JSON.stringify(live) !== JSON.stringify(next.live)) {
      next.live = live;
      changed = true;
    }
  }

  const status = horizons.every((horizon) => next.outcomes[String(horizon)]) ? "COMPLETE" : "PENDING";
  if (status !== next.status) {
    next.status = status;
    changed = true;
  }
  return changed ? next : record;
}

/**
 * Same-day, same-market equal-weight universe return, so a strategy is judged
 * against the market it actually traded in rather than against zero.
 */
function attachOutcomeBenchmarks(records, readOutcome, writeOutcome) {
  const groups = new Map();
  for (const row of records) {
    const outcome = readOutcome(row);
    if (!finite(outcome?.netReturnPct)) continue;
    const groupKey = `${row.signalDate}|${row.market}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(Number(outcome.netReturnPct));
  }
  for (const row of records) {
    const outcome = readOutcome(row);
    if (!outcome) continue;
    const values = groups.get(`${row.signalDate}|${row.market}`) ?? [];
    const benchmarkReturnPct = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    writeOutcome(row, {
      ...outcome,
      benchmarkReturnPct,
      excessReturnPct: finite(benchmarkReturnPct) ? Number(outcome.netReturnPct) - benchmarkReturnPct : null
    });
  }
}

export function attachBenchmarks(records, horizons = STRATEGY_HORIZONS) {
  attachOutcomeBenchmarks(
    records,
    (row) => row.entryDayOutcome,
    (row, outcome) => { row.entryDayOutcome = outcome; }
  );
  for (const horizon of horizons) {
    const key = String(horizon);
    attachOutcomeBenchmarks(
      records,
      (row) => row.outcomes?.[key],
      (row, outcome) => { row.outcomes[key] = outcome; }
    );
  }
  return records;
}

// Summary numbers are display metrics: 3 decimals keeps the JSON small
// without changing any decision. Stored outcomes keep full precision.
function round(value, digits = 3) {
  return finite(value) ? Number(Number(value).toFixed(digits)) : null;
}

function average(values) {
  const clean = values.filter(finite).map(Number);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function median(values) {
  const clean = values.filter(finite).map(Number).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function profitFactor(values) {
  const clean = values.filter(finite).map(Number);
  if (!clean.length) return null;
  const gains = clean.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(clean.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  if (!losses) return gains ? null : null; // undefined PF (no losing trade) stays null
  return gains / losses;
}

export function sampleGrade(n) {
  return SAMPLE_GRADES.find((grade) => n >= grade.min) ?? SAMPLE_GRADES.at(-1);
}

function emptyTradeBlock() {
  return {
    n: 0,
    avgReturnPct: null,
    medianReturnPct: null,
    winRatePct: null,
    profitFactor: null,
    avgMfePct: null,
    avgMaePct: null,
    avgExcessReturnPct: null,
    medianExcessReturnPct: null,
    avgBenchmarkReturnPct: null
  };
}

function emptyCohortBlock() {
  return {
    n: 0,
    avgReturnPct: null,
    medianReturnPct: null,
    winRatePct: null,
    avgExcessReturnPct: null,
    best: null,
    worst: null
  };
}

/**
 * @param {Array} records universe rows (frozen factors + filled outcomes)
 * @param {Array} selections one row per signalDate/market/strategy
 */
export function buildStrategyOosSummary(records, selections, {
  markets = ["ALL", ...MARKETS],
  horizons = STRATEGY_HORIZONS,
  strategies = enabledStrategies(),
  invalidLines = 0,
  state = null,
  generatedAt = new Date().toISOString()
} = {}) {
  const recordIndex = new Map(records.map((row) => [`${row.signalDate}|${row.market}|${row.code}`, row]));
  const signalDates = [...new Set(selections.map((row) => row.signalDate))].sort();
  const universeDates = [...new Set(records.map((row) => row.signalDate))].sort();
  const maxHorizon = Math.max(...horizons);

  const marketSummaries = {};
  for (const market of markets) {
    const scoped = selections.filter((row) => market === "ALL" || row.market === market);
    const byStrategy = new Map();
    for (const selection of scoped) {
      if (!byStrategy.has(selection.strategyId)) byStrategy.set(selection.strategyId, []);
      byStrategy.get(selection.strategyId).push(selection);
    }

    marketSummaries[market] = strategies.map((strategy) => {
      const cohortRows = (byStrategy.get(strategy.id) ?? [])
        .slice()
        .sort((a, b) => a.signalDate.localeCompare(b.signalDate) || a.market.localeCompare(b.market));
      const memberRecords = cohortRows.map((cohort) => ({
        cohort,
        rows: cohort.members
          .map((member) => recordIndex.get(`${cohort.signalDate}|${cohort.market}|${member.code}`))
          .filter(Boolean)
      }));

      const horizonBlocks = {};
      for (const horizon of horizons) {
        const key = String(horizon);
        const tradeReturns = [];
        const tradeExcess = [];
        const tradeMfe = [];
        const tradeMae = [];
        const tradeBenchmark = [];
        const cohortStats = [];
        for (const { cohort, rows } of memberRecords) {
          const outcomes = rows.map((row) => row.outcomes?.[key]).filter((outcome) => finite(outcome?.netReturnPct));
          if (!outcomes.length) continue;
          for (const outcome of outcomes) {
            tradeReturns.push(Number(outcome.netReturnPct));
            tradeExcess.push(outcome.excessReturnPct);
            tradeMfe.push(outcome.mfePct);
            tradeMae.push(outcome.maePct);
            tradeBenchmark.push(outcome.benchmarkReturnPct);
          }
          // Cohort = that day's picks bought equal-weight as one basket.
          cohortStats.push({
            signalDate: cohort.signalDate,
            market: cohort.market,
            members: outcomes.length,
            returnPct: average(outcomes.map((outcome) => outcome.netReturnPct)),
            excessReturnPct: average(outcomes.map((outcome) => outcome.excessReturnPct))
          });
        }
        const cohortReturns = cohortStats.map((item) => item.returnPct);
        const sortedCohorts = cohortStats.filter((item) => finite(item.returnPct)).sort((a, b) => b.returnPct - a.returnPct);
        horizonBlocks[key] = {
          trades: tradeReturns.length ? {
            n: tradeReturns.length,
            avgReturnPct: round(average(tradeReturns)),
            medianReturnPct: round(median(tradeReturns)),
            winRatePct: round((tradeReturns.filter((value) => value > 0).length / tradeReturns.length) * 100, 1),
            profitFactor: round(profitFactor(tradeReturns), 2),
            avgMfePct: round(average(tradeMfe)),
            avgMaePct: round(average(tradeMae)),
            avgExcessReturnPct: round(average(tradeExcess)),
            medianExcessReturnPct: round(median(tradeExcess)),
            avgBenchmarkReturnPct: round(average(tradeBenchmark))
          } : emptyTradeBlock(),
          cohorts: cohortStats.length ? {
            n: cohortStats.length,
            avgReturnPct: round(average(cohortReturns)),
            medianReturnPct: round(median(cohortReturns)),
            winRatePct: round((cohortReturns.filter((value) => finite(value) && Number(value) > 0).length / cohortStats.length) * 100, 1),
            avgExcessReturnPct: round(average(cohortStats.map((item) => item.excessReturnPct))),
            best: sortedCohorts[0] ? { ...sortedCohorts[0], returnPct: round(sortedCohorts[0].returnPct), excessReturnPct: round(sortedCohorts[0].excessReturnPct) } : null,
            worst: sortedCohorts.at(-1) ? { ...sortedCohorts.at(-1), returnPct: round(sortedCohorts.at(-1).returnPct), excessReturnPct: round(sortedCohorts.at(-1).excessReturnPct) } : null
          } : emptyCohortBlock(),
          sampleGrade: sampleGrade(cohortStats.length)
        };
      }

      // 진행중: cohorts whose longest horizon is not confirmed yet, valued at
      // the latest close. Never mixed with the confirmed N-day numbers.
      const pendingCohorts = [];
      let pendingTrades = 0;
      const pendingElapsed = [];
      for (const { cohort, rows } of memberRecords) {
        const liveRows = rows.filter((row) => row.live && row.status !== "COMPLETE");
        if (!liveRows.length) continue;
        pendingTrades += liveRows.length;
        for (const row of liveRows) pendingElapsed.push(row.live.tradingDaysElapsed);
        pendingCohorts.push({
          signalDate: cohort.signalDate,
          market: cohort.market,
          members: liveRows.length,
          returnPct: average(liveRows.map((row) => row.live.currentReturnPct)),
          lastEvaluatedDate: liveRows.map((row) => row.live.lastEvaluatedDate).sort().at(-1) ?? null
        });
      }

      const latest = cohortRows.at(-1) ?? null;
      const latestSameDate = latest
        ? cohortRows.filter((row) => row.signalDate === latest.signalDate)
        : [];
      return {
        ...strategyMeta(strategy),
        cohortCount: cohortRows.length,
        tradeCount: cohortRows.reduce((sum, row) => sum + row.members.length, 0),
        firstDate: cohortRows[0]?.signalDate ?? null,
        lastDate: latest?.signalDate ?? null,
        latest: latest ? {
          signalDate: latest.signalDate,
          count: latestSameDate.reduce((sum, row) => sum + row.members.length, 0),
          validCount: latestSameDate.reduce((sum, row) => sum + row.validCount, 0),
          targetCount: latestSameDate.reduce((sum, row) => sum + row.targetCount, 0),
          byMarket: latestSameDate.map((row) => ({ market: row.market, count: row.members.length, targetCount: row.targetCount }))
        } : null,
        pending: {
          cohorts: pendingCohorts.length,
          trades: pendingTrades,
          avgReturnPct: round(average(pendingCohorts.map((item) => item.returnPct))),
          avgTradingDaysElapsed: round(average(pendingElapsed), 1),
          lastEvaluatedDate: pendingCohorts.map((item) => item.lastEvaluatedDate).filter(Boolean).sort().at(-1) ?? null,
          maxHorizon
        },
        horizons: horizonBlocks
      };
    });
  }

  return {
    schemaVersion: STRATEGY_OOS_SCHEMA,
    generatedAt,
    horizons,
    costPct: STRATEGY_OOS_COST_PCT,
    groups: STRATEGY_GROUPS,
    featured: FEATURED_STRATEGY_IDS,
    meta: {
      strategyCount: strategies.length,
      rankingStrategyCount: strategies.filter((strategy) => strategy.type === "ranking").length,
      conditionStrategyCount: strategies.filter((strategy) => strategy.type === "condition").length,
      signalDates,
      firstDate: signalDates[0] ?? null,
      lastDate: signalDates.at(-1) ?? null,
      universeDates,
      universeRecordCount: records.length,
      completedRecordCount: records.filter((row) => row.status === "COMPLETE").length,
      pendingRecordCount: records.filter((row) => row.status !== "COMPLETE").length,
      invalidLines,
      missingSnapshotDates: state?.missingSnapshotDates ?? [],
      lastSnapshotAt: state?.lastSnapshotAt ?? null,
      lastEvaluatedAt: state?.lastEvaluatedAt ?? null,
      skipped: (state?.skipped ?? []).slice(-10)
    },
    markets: marketSummaries
  };
}

export function buildStrategyDetail(records, selections, { strategyId, market = "ALL", limit = 40, horizons = STRATEGY_HORIZONS } = {}) {
  const recordIndex = new Map(records.map((row) => [`${row.signalDate}|${row.market}|${row.code}`, row]));
  const scoped = selections
    .filter((row) => row.strategyId === strategyId && (market === "ALL" || row.market === market))
    .sort((a, b) => b.signalDate.localeCompare(a.signalDate) || a.market.localeCompare(b.market))
    .slice(0, limit);
  const cohorts = scoped.map((selection) => {
    const rows = selection.members.map((member) => {
      const record = recordIndex.get(`${selection.signalDate}|${selection.market}|${member.code}`);
      return {
        code: member.code,
        name: record?.name ?? member.name ?? "",
        strategyRank: member.rank,
        signalPrice: record?.signalPrice ?? null,
        entryDate: record?.entryDate ?? null,
        entryOpen: record?.entryOpen ?? null,
        status: record?.status ?? "MISSING",
        factors: record?.factors ?? null,
        live: record?.live ?? null,
        outcomes: Object.fromEntries(horizons.map((horizon) => [String(horizon), record?.outcomes?.[String(horizon)] ?? null]))
      };
    });
    return {
      signalDate: selection.signalDate,
      market: selection.market,
      recordedAt: selection.recordedAt,
      targetCount: selection.targetCount,
      validCount: selection.validCount,
      naCount: selection.naCount,
      cohortReturns: Object.fromEntries(horizons.map((horizon) => {
        const values = rows.map((row) => row.outcomes[String(horizon)]?.netReturnPct);
        const excess = rows.map((row) => row.outcomes[String(horizon)]?.excessReturnPct);
        return [String(horizon), { returnPct: average(values), excessReturnPct: average(excess), members: values.filter(finite).length }];
      })),
      liveReturnPct: average(rows.map((row) => row.live?.currentReturnPct)),
      rows
    };
  });
  return { strategyId, market, cohorts };
}

function weekdaysBetween(startDate, endDate) {
  const days = [];
  if (!startDate || !endDate) return days;
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * Weekdays between the first and last recorded snapshot that have no snapshot.
 * Korean market holidays land here too, so the label is deliberately soft:
 * this is a "no record" list, never a reason to synthesise a day.
 */
export function missingSnapshotDates(recordedDates) {
  const recorded = new Set(recordedDates);
  const sorted = [...recorded].sort();
  return weekdaysBetween(sorted[0], sorted.at(-1)).filter((date) => !recorded.has(date));
}

export function createStrategyOosTracker({
  historyFile,
  selectionFile,
  summaryFile,
  stateFile,
  costPct = STRATEGY_OOS_COST_PCT,
  horizons = STRATEGY_HORIZONS,
  now = () => new Date()
}) {
  function readAll() {
    const universe = readJsonl(historyFile);
    const selections = readJsonl(selectionFile);
    return {
      records: universe.records,
      selections: selections.records,
      invalidLines: universe.invalidLines + selections.invalidLines
    };
  }

  function readState() {
    return readJson(stateFile, {
      schemaVersion: STRATEGY_OOS_SCHEMA,
      recordedDates: [],
      lastSnapshotAt: null,
      lastEvaluatedAt: null,
      skipped: [],
      diagnostics: {}
    });
  }

  function writeState(state) {
    atomicWrite(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }

  function writeSummary(records, selections, invalidLines, state) {
    if (!summaryFile) return null;
    const summary = buildStrategyOosSummary(records, selections, { invalidLines, horizons, state });
    atomicWrite(summaryFile, `${JSON.stringify(summary)}\n`);
    return summary;
  }

  function recordSkip(state, reason, detail) {
    const skipped = [...(state.skipped ?? []), { at: now().toISOString(), reason, ...detail }];
    writeState({ ...state, skipped: skipped.slice(-50) });
  }

  /**
   * Idempotent: the unique keys are `signalDate|market|code` for the universe
   * and `signalDate|market|strategyId` for the selections. Running the EOD job
   * twice adds nothing the second time.
   */
  function recordSnapshot(payload, historyByCode, { dryRun = false } = {}) {
    const state = readState();
    const signalDate = deriveSignalDate(historyByCode) ?? payload?.marketDataAsOf ?? null;
    const gate = isEodSnapshotAllowed({ marketDataAsOf: signalDate, now: now() });
    if (!gate.allowed) {
      if (!dryRun) recordSkip(state, gate.reason, { signalDate });
      return { recorded: false, reason: gate.reason, signalDate, addedRecords: 0, addedSelections: 0 };
    }

    const rows = MARKETS.flatMap((market) => payload?.rows?.[market] ?? []);
    if (!rows.length || MARKETS.some((market) => !(payload?.rows?.[market] ?? []).length)) {
      if (!dryRun) recordSkip(state, "EMPTY_MARKET_ROWS", { signalDate });
      return { recorded: false, reason: "EMPTY_MARKET_ROWS", signalDate, addedRecords: 0, addedSelections: 0 };
    }

    const errors = payload?.errors ?? [];
    const budget = Math.max(STRATEGY_MAX_ERROR_ABSOLUTE, rows.length * STRATEGY_MAX_ERROR_RATIO);
    if (errors.length > budget) {
      if (!dryRun) recordSkip(state, "DEGRADED_REFRESH", { signalDate, errors: errors.length });
      return { recorded: false, reason: "DEGRADED_REFRESH", signalDate, addedRecords: 0, addedSelections: 0 };
    }

    const failedCodes = new Set(errors.map((error) => String(error?.code ?? "")).filter(Boolean));
    const features = buildFeatureRows(payload, { failedCodes });
    const recordedAt = now().toISOString();
    const baseLimit = Math.max(1, Number(payload?.limit ?? 100));
    const volumeExtra = Math.min(30, baseLimit);
    const universeMeta = {
      version: `screener-v1-mcap${baseLimit}-vol${volumeExtra}`,
      baseLimit,
      volumeExtra,
      marketCounts: Object.fromEntries(MARKETS.map((market) => [market, (features.byMarket[market] ?? []).length]))
    };
    const universeRecords = buildUniverseRecords(features, { signalDate, recordedAt, universeMeta });
    const selections = buildSelections(features, { signalDate, recordedAt });

    if (dryRun) {
      return {
        recorded: false,
        dryRun: true,
        reason: "DRY_RUN",
        signalDate,
        universe: universeRecords,
        selections,
        diagnostics: features.diagnostics,
        addedRecords: universeRecords.length,
        addedSelections: selections.length
      };
    }

    const loaded = readAll();
    const recordKeys = new Set(loaded.records.map((row) => `${row.signalDate}|${row.market}|${row.code}`));
    const selectionKeys = new Set(loaded.selections.map((row) => `${row.signalDate}|${row.market}|${row.strategyId}`));
    const freshRecords = universeRecords.filter((row) => !recordKeys.has(`${row.signalDate}|${row.market}|${row.code}`));
    const freshSelections = selections.filter((row) => !selectionKeys.has(`${row.signalDate}|${row.market}|${row.strategyId}`));
    appendJsonl(historyFile, freshRecords);
    appendJsonl(selectionFile, freshSelections);

    const recordedDates = [...new Set([...(state.recordedDates ?? []), signalDate])].sort();
    const nextState = {
      ...state,
      schemaVersion: STRATEGY_OOS_SCHEMA,
      recordedDates,
      missingSnapshotDates: missingSnapshotDates(recordedDates),
      lastSnapshotAt: recordedAt,
      diagnostics: {
        ...(state.diagnostics ?? {}),
        [signalDate]: {
          recordedAt,
          universeCount: universeRecords.length,
          marketCounts: Object.fromEntries(MARKETS.map((market) => [market, (features.byMarket[market] ?? []).length])),
          droppedRows: features.diagnostics,
          kisErrors: errors.length,
          universeMeta
        }
      }
    };
    writeState(nextState);
    writeSummary([...loaded.records, ...freshRecords], [...loaded.selections, ...freshSelections], loaded.invalidLines, nextState);
    return {
      recorded: freshRecords.length > 0 || freshSelections.length > 0,
      reason: freshRecords.length ? "RECORDED" : "ALREADY_RECORDED",
      signalDate,
      addedRecords: freshRecords.length,
      addedSelections: freshSelections.length,
      universeCount: universeRecords.length,
      selectionCount: selections.length
    };
  }

  /**
   * Fills entry prices, horizon outcomes and today's live value for every
   * record that is not finished yet. Price history is taken from the payload
   * the EOD refresh already loaded whenever possible, so this adds no KIS
   * calls for stocks that are still in the universe.
   */
  async function evaluatePending(loadHistory) {
    const loaded = readAll();
    if (!loaded.records.length) return { updated: 0, total: 0 };
    const today = seoulParts(now()).date;
    const historyNeeded = loaded.records.filter((row) => row.signalDate < today && (
      row.status !== "COMPLETE"
      || !row.entryDayOutcome
      || !finite(row.entryGapPct)
      || !row.entryDate
      || !finite(row.entryOpen)
    ));
    const localUpgradeNeeded = loaded.records.some((row) => !row.frozenConsensus && row.factors);
    if (!historyNeeded.length && !localUpgradeNeeded) return { updated: 0, total: loaded.records.length };
    const historySet = new Set(historyNeeded);
    const codes = [...new Set(historyNeeded.map((row) => row.code))];
    const histories = new Map();
    for (let index = 0; index < codes.length; index += 3) {
      const batch = codes.slice(index, index + 3);
      const resolved = await Promise.all(batch.map(async (code) => [code, await loadHistory(code)]));
      resolved.forEach(([code, history]) => histories.set(code, history));
    }
    const evaluatedAt = now().toISOString();
    let updated = 0;
    const records = loaded.records.map((row) => {
      let next = row;
      if (!next.frozenConsensus && next.factors) next = { ...next, frozenConsensus: freezeBaseConsensus(next.factors) };
      if (historySet.has(row)) next = evaluateUniverseRecord(next, histories.get(row.code), { evaluatedAt, costPct, horizons });
      if (next !== row) updated += 1;
      return next;
    });
    attachBenchmarks(records, horizons);
    if (updated || loaded.invalidLines) writeJsonl(historyFile, records);
    const state = { ...readState(), lastEvaluatedAt: evaluatedAt };
    writeState(state);
    writeSummary(records, loaded.selections, 0, state);
    return { updated, total: records.length };
  }

  // Serves one market's rows, not all three: the cached file holds ALL/KOSPI/
  // KOSDAQ so the page can switch instantly, but sending every market on every
  // request would triple the payload for nothing.
  function summary({ market = "ALL" } = {}) {
    const cached = readJson(summaryFile, null);
    let built = cached?.markets?.[market] ? cached : null;
    if (!built) {
      const loaded = readAll();
      built = buildStrategyOosSummary(loaded.records, loaded.selections, {
        invalidLines: loaded.invalidLines,
        horizons,
        state: readState()
      });
    }
    const { markets, ...rest } = built;
    return { ...rest, market, strategies: markets[market] ?? markets.ALL ?? [] };
  }

  function detail(options) {
    const loaded = readAll();
    return buildStrategyDetail(loaded.records, loaded.selections, { ...options, horizons });
  }

  return { readAll, readState, recordSnapshot, evaluatePending, summary, detail };
}

export function safeStrategyTask(task, onError = () => {}) {
  try {
    return { ok: true, value: task() };
  } catch (error) {
    onError(error);
    return { ok: false, error };
  }
}
