// Phase 1 of V3: turn cached price/investor history into a point-in-time
// feature matrix, one row per (date, code). Filters are never evaluated here.
//
// Two deliberate choices:
//   * Production modules are imported and used directly for Leader, CAFE/MTT,
//     Ranking V2 and RS20, so the backtest cannot drift from the dashboard.
//   * Only backtest-cache-v2 is read. Nothing here calls KIS; if a ticker is
//     not cached it is reported as skipped rather than downloaded.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildStrategyConfirmation } from "../strategy-confirmation.js";
import { rankMarketRowsV2, reboundRankingTier } from "../public/rebound-ranking-v2.js";
import { buildRelativeStrength20 } from "../relative-strength.js";

import {
  calcScoutBaseAt, calcLeaderBaseAt, enrichCrossSection,
  rankScout, rankCombined, buildFlags, buildCombinedDecision, buildOutcomes,
  calcLiquidityScore, groupBy, avg, sum, runtime
} from "./v2-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "backtest-cache-v2");

/** Picks the cached file for a code that covers the widest date range. */
function findCacheFile(prefix, code) {
  if (!existsSync(CACHE_DIR)) return null;
  const matches = readdirSync(CACHE_DIR)
    .filter((f) => f.startsWith(`${prefix}-${code}-`) && f.endsWith(".json"))
    .map((f) => {
      const m = f.match(/-(\d{8})-(\d{8})\.json$/);
      return m ? { file: f, from: m[1], to: m[2], span: Number(m[2]) - Number(m[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.span - a.span || b.to.localeCompare(a.to));
  return matches[0] ? path.join(CACHE_DIR, matches[0].file) : null;
}

function readCacheFile(file) {
  if (!file || !existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed.value ?? parsed;
  } catch {
    return null;
  }
}

function readQuote(code) {
  return readCacheFile(path.join(CACHE_DIR, `quote-${code}.json`));
}

export function loadUniverseFromCache(limit) {
  const out = [];
  for (const market of ["KOSPI", "KOSDAQ"]) {
    const rows = readCacheFile(path.join(CACHE_DIR, `universe-${market}-100.json`)) ?? [];
    out.push(...rows.slice(0, limit).map((r) => ({ code: r.code, name: r.name, market: r.market || market })));
  }
  return out;
}

/**
 * Builds the per-ticker series and the raw per-day rows. Mirrors V2's
 * buildTickerSeries but sources everything from cache.
 */
function buildTickerRows(item, { startDate, endDate, holds, costPct }) {
  const prices = readCacheFile(findCacheFile("price", item.code));
  if (!Array.isArray(prices) || prices.length < 60) return null;
  const investors = readCacheFile(findCacheFile("investor", item.code)) ?? [];
  const quote = readQuote(item.code);
  const listedShares = quote?.listedShares || null;
  const investorByDate = new Map(investors.map((x) => [x.date, x]));
  // Investor history is shorter than price history; days outside it are NA
  // rather than zero, so "no net buying" is never confused with "unknown".
  const investorFrom = investors.length ? investors[0].date : null;

  let foreignStreak = 0;
  let instStreak = 0;
  const series = prices.map((p) => {
    const known = investorFrom && p.date >= investorFrom;
    const inv = investorByDate.get(p.date) ?? (known ? { foreignNetAmount: 0, instNetAmount: 0 } : null);
    if (inv) {
      foreignStreak = inv.foreignNetAmount > 0 ? foreignStreak + 1 : 0;
      instStreak = inv.instNetAmount > 0 ? instStreak + 1 : 0;
    }
    return {
      ...p,
      foreignNetAmount: inv ? inv.foreignNetAmount : null,
      instNetAmount: inv ? inv.instNetAmount : null,
      investorKnown: Boolean(inv),
      foreignStreak: inv ? foreignStreak : null,
      instStreak: inv ? instStreak : null
    };
  });

  const rows = [];
  for (let i = 25; i < series.length; i += 1) {
    const r = series[i];
    if (r.date < startDate || r.date > endDate) continue;
    const historyRows = series.slice(0, i + 1);
    const prev = series[i - 1];
    const base3 = series[i - 3];
    const tradingValue20 = avg(series.slice(Math.max(0, i - 20), i).map((x) => x.tradingValue));
    const marketCap = listedShares && r.close ? listedShares * r.close : null;
    const bodyTurnoverPct = marketCap ? (r.tradingValue / marketCap) * 100 : 0;
    const tradingValueRatio20 = tradingValue20 ? r.tradingValue / tradingValue20 : 0;
    const hasInvestor = r.investorKnown;
    const totalNetAmount = hasInvestor ? r.foreignNetAmount + r.instNetAmount : null;
    const smartMoneyBodyPct = hasInvestor && marketCap ? (totalNetAmount / marketCap) * 100 : (hasInvestor ? 0 : null);
    const smartMoneyTradingSharePct = hasInvestor && r.tradingValue ? (totalNetAmount / r.tradingValue) * 100 : (hasInvestor ? 0 : null);
    const liquidityScore = calcLiquidityScore({
      tradingValue: r.tradingValue, bodyTurnoverPct, tradingValueRatio20,
      smartMoneyBodyPct: smartMoneyBodyPct ?? 0, smartMoneyTradingSharePct: smartMoneyTradingSharePct ?? 0
    });
    const vwap = r.volume ? r.tradingValue / r.volume : null;
    const reboundFromLowPct = r.low ? (r.close / r.low - 1) * 100 : 0;
    const vwapRecovered = Boolean(vwap && r.close >= vwap);
    const window5 = series.slice(Math.max(0, i - 4), i + 1);
    const known5 = window5.every((x) => x.investorKnown);
    const foreign5 = known5 ? sum(window5.map((x) => x.foreignNetAmount)) : null;
    const inst5 = known5 ? sum(window5.map((x) => x.instNetAmount)) : null;
    const dayChangePct = prev?.close ? (r.close / prev.close - 1) * 100 : 0;
    const change3dPct = base3?.close ? (r.close / base3.close - 1) * 100 : 0;

    const flags = buildFlags({
      liquidityScore, change3dPct, dayChangePct,
      foreignStreak: r.foreignStreak ?? 0,
      instStreak: r.instStreak ?? 0,
      totalNetAmount: totalNetAmount ?? 0,
      reboundFromLowPct, vwapRecovered, tradingValueRatio20, bodyTurnoverPct
    });

    rows.push({
      code: item.code, name: item.name, market: item.market || "UNKNOWN",
      date: r.date, seriesIndex: i,
      price: r.close, open: r.open, high: r.high, low: r.low, close: r.close,
      volume: r.volume, tradingValue: r.tradingValue, marketCap,
      foreignNetAmount: r.foreignNetAmount, instNetAmount: r.instNetAmount,
      foreign5, inst5, totalNetAmount,
      foreignStreak: r.foreignStreak, instStreak: r.instStreak,
      investorKnown: hasInvestor,
      bodyTurnoverPct, tradingValueRatio20, smartMoneyBodyPct, smartMoneyTradingSharePct,
      liquidityScore, dayChangePct, change3dPct, vwap, vwapRecovered, reboundFromLowPct,
      flags,
      scoutBase: calcScoutBaseAt(historyRows),
      leaderBase: calcLeaderBaseAt(historyRows),
      outcomes: buildOutcomes(series, i, { holds, costPct })
    });
  }
  return { series, rows };
}

/**
 * Cross-sectional work happens per (date, market) so KOSPI and KOSDAQ are
 * never ranked against each other, and only that day's universe is visible.
 */
export function buildFeatureMatrix(universe, options) {
  const { startDate, endDate, holds, costPct, onProgress } = options;
  runtime.holdingDaysList = holds;
  runtime.roundTripCostPct = costPct;

  const baseRows = [];
  const skipped = [];
  const seriesByCode = new Map();
  universe.forEach((item, index) => {
    const built = buildTickerRows(item, { startDate, endDate, holds, costPct });
    if (!built) {
      skipped.push({ code: item.code, name: item.name, reason: "no cached price history" });
    } else {
      seriesByCode.set(item.code, built.series);
      baseRows.push(...built.rows);
    }
    onProgress?.(index + 1, universe.length, item, built ? built.rows.length : 0);
  });

  const byDateMarket = groupBy(baseRows, (r) => `${r.date}|${r.market}`);
  const observations = [];
  for (const key of [...byDateMarket.keys()].sort()) {
    const dayRows = byDateMarket.get(key);
    enrichCrossSection(dayRows);
    rankScout(dayRows);
    for (const row of dayRows) row.combined = buildCombinedDecision(row, row.scout);
    rankCombined(dayRows);

    // Ranking V2 / RS20 / Leader rank, each within this market-day only.
    const shaped = dayRows.map((row) => shapeForProduction(row));
    const rs20 = buildRelativeStrength20(dayRows.map((row) => ({
      code: row.code, market: row.market, ret20: row.scout?.ret20 ?? row.scoutBase?.ret20 ?? null
    })));
    const rankedV2 = rankMarketRowsV2(shaped);
    const v2RankByCode = new Map(rankedV2.map((row, i) => [row.code, i + 1]));
    const leaderRanked = [...dayRows]
      .filter((row) => Number.isFinite(row.leader?.score))
      .sort((a, b) => b.leader.score - a.leader.score);
    const leaderRankByCode = new Map(leaderRanked.map((row, i) => [row.code, i + 1]));

    for (const row of dayRows) {
      const shapedRow = shaped.find((s) => s.code === row.code);
      const confirmation = buildStrategyConfirmation(shapedRow);
      observations.push(flatten(row, {
        confirmation,
        rankingTier: reboundRankingTier(shapedRow),
        rankingV2Rank: v2RankByCode.get(row.code) ?? null,
        leaderRank: leaderRankByCode.get(row.code) ?? null,
        rs20: rs20.get(row.code) ?? null,
        holds
      }));
    }
  }
  return { observations, skipped, seriesByCode };
}

/** Adapts a backtest row into the shape the production modules expect. */
function shapeForProduction(row) {
  return {
    code: row.code,
    name: row.name,
    market: row.market,
    price: row.close,
    changeRate: row.dayChangePct,
    changeRate3d: row.change3dPct,
    leader: row.leader ?? {},
    scout: row.scout ?? {},
    supply: {
      liquidityScore: row.liquidityScore,
      foreignStreak: row.foreignStreak ?? 0,
      instStreak: row.instStreak ?? 0,
      totalNetAmount: row.totalNetAmount ?? 0,
      smartMoneyBodyPct: row.smartMoneyBodyPct ?? 0,
      smartMoneyTradingSharePct: row.smartMoneyTradingSharePct ?? 0
    },
    investor: { foreignNetAmount5d: row.foreign5, instNetAmount5d: row.inst5 },
    combined: row.combined ?? {},
    strategy: { flags: row.flags ?? {}, dayChangePct: row.dayChangePct, change3dPct: row.change3dPct }
  };
}

function flatten(row, extra) {
  const scout = row.scout ?? {};
  const leader = row.leader ?? {};
  const c = extra.confirmation ?? {};
  const out = {
    date: row.date, code: row.code, name: row.name, market: row.market,

    combinedScore: row.combined?.score ?? null,
    mainScore: row.combined?.mainScore ?? null,
    scoutContribution: row.combined?.scoutScore ?? null,
    combinedRank: row.combined?.rank ?? null,
    combinedLabel: row.combined?.label ?? "",
    gateReason: row.combined?.gateReason ?? "",
    gatePass: row.combined?.gateReason === "PASS",

    rankingTier: extra.rankingTier ?? null,
    rankingV2Rank: extra.rankingV2Rank,
    leaderRank: extra.leaderRank,
    rs20: extra.rs20,

    leaderScore: leader.score ?? null,
    leaderGrade: leader.grade ?? "계산불가",
    leaderTrendScore: leader.trendScore ?? null,
    leaderRsScore: leader.relativeStrengthScore ?? null,
    leaderHighScore: leader.highRetentionScore ?? null,
    leaderPersistenceScore: leader.persistenceScore ?? null,

    scoutStatus: scout.status ?? "계산불가",
    scoutCheapScore: scout.cheapScore ?? null,
    scoutStabilizeScore: scout.stabilizeScore ?? null,
    scoutRiskScore: scout.riskScore ?? null,
    scoutRank: scout.rank ?? null,
    drawdownFromHighPct: scout.drawdownFromHighPct ?? null,
    noNewLow5: scout.noNewLow5 ?? null,
    slope5: scout.slope5 ?? null,
    ret5: scout.ret5 ?? null,
    ret20: scout.ret20 ?? null,

    reboundStateKey: c.reboundState?.key ?? null,
    leaderReboundPass: c.leaderReboundPass === true,
    deepRecoveryPass: c.deepRecoveryPass === true,
    experimentalNakjuPass: c.experimentalNakjuPass === true,
    cafePass: c.cafePass === true,
    minerviniPass: c.minerviniPass === true,

    R: Boolean(row.flags?.R), F: Boolean(row.flags?.F), F2: Boolean(row.flags?.F2),
    B: Boolean(row.flags?.B), C: Boolean(row.flags?.C), H2: Boolean(row.flags?.H2),
    H3: Boolean(row.flags?.H3), I: Boolean(row.flags?.I),

    liquidityScore: row.liquidityScore,
    tradingValueRatio20: row.tradingValueRatio20,
    bodyTurnoverPct: row.bodyTurnoverPct,
    smartMoneyBodyPct: row.smartMoneyBodyPct,
    smartMoneyTradingSharePct: row.smartMoneyTradingSharePct,
    foreignStreak: row.foreignStreak,
    instStreak: row.instStreak,
    totalNetAmount: row.totalNetAmount,
    foreignNet5d: row.foreign5,
    instNet5d: row.inst5,
    investorKnown: row.investorKnown,

    changeRate: row.dayChangePct,
    changeRate3d: row.change3dPct,
    vwapRecovered: row.vwapRecovered,
    overheat: row.dayChangePct >= 10 || row.change3dPct >= 12
  };
  for (const h of extra.holds) {
    const x = row.outcomes?.[h];
    out[`r${h}`] = x?.netReturnPct ?? null;
    out[`mfe${h}`] = x?.mfePct ?? null;
    out[`mae${h}`] = x?.maePct ?? null;
    out[`entryDate${h}`] = x?.entryDate ?? null;
    out[`exitDate${h}`] = x?.exitDate ?? null;
  }
  return out;
}

/** Market-relative excess return, added after the matrix exists. */
export function attachExcessReturns(observations, holds) {
  const byDateMarket = groupBy(observations, (r) => `${r.date}|${r.market}`);
  for (const rows of byDateMarket.values()) {
    for (const h of holds) {
      const mean = avg(rows.map((r) => r[`r${h}`]));
      for (const r of rows) {
        r[`x${h}`] = Number.isFinite(r[`r${h}`]) && Number.isFinite(mean) ? r[`r${h}`] - mean : null;
      }
    }
  }
  return observations;
}
