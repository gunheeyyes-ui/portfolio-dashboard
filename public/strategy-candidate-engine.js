import { rankMarketRowsV2, reboundRankingTier } from "./rebound-ranking-v2.js";
import { simulationCategory } from "./simulation-category.js";
import {
  FEATURED_STRATEGY_IDS,
  RANKERS,
  enabledStrategies,
  hasRequiredFields
} from "./strategy-oos-registry.js";

export const STRATEGY_AXES = [
  { id: "leader", label: "주도" },
  { id: "rs", label: "RS" },
  { id: "timing", label: "타이밍" },
  { id: "entry", label: "진입" },
  { id: "rebound", label: "반등/자리" },
  { id: "confirm", label: "CAFE/MTT" }
];

const AXIS_ORDER = new Map(STRATEGY_AXES.map((axis, index) => [axis.id, index]));
const AXIS_LABEL = new Map(STRATEGY_AXES.map((axis) => [axis.id, axis.label]));
const FEATURED_SET = new Set(FEATURED_STRATEGY_IDS);
const ALL_STRATEGIES = enabledStrategies();
const STRATEGY_INDEX = new Map(ALL_STRATEGIES.map((strategy, index) => [strategy.id, index]));
const SIGNAL_KEYS = ["R", "F", "F2", "B", "H2", "H3"];

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function numberOrNull(value) {
  return finite(value) ? Number(value) : null;
}

function boolOrNull(source, value) {
  return source ? value === true : null;
}

function baseValid(feature) {
  return Boolean(feature.code) && finite(feature.signalPrice) && Number(feature.signalPrice) > 0;
}

export function strategyAxes(strategy) {
  const id = String(strategy?.id ?? "");
  const subGroup = String(strategy?.subGroup ?? "");
  const axes = new Set();

  if (strategy?.ranker === "leader" || id.includes("LEADER") || subGroup.includes("leader")) axes.add("leader");
  if (strategy?.ranker === "rs" || id.startsWith("RS") || id.includes("_RS")) axes.add("rs");
  if (strategy?.ranker === "timing" || id.startsWith("TIMING_") || id.startsWith("COMBINED_")) axes.add("timing");

  // Entry is reserved for the live entry verdict / primitive entry flags and
  // combinations that explicitly depend on them. COMBINED_* stays timing-only
  // so one derived judgement cannot inflate the independent-axis count twice.
  if (
    id === "ACTIONABLE_ALL"
    || id === "SPECIAL_SHORT"
    || id.startsWith("FLAG_")
    || subGroup.includes("entry")
    || subGroup.includes("flag")
    || /_AND_(?:R|F|F2|B|H2|H3)(?:_|$)/.test(id)
  ) axes.add("entry");

  if (
    strategy?.ranker === "rankingV2"
    || strategy?.ranker === "scout"
    || /REBOUND|RECOVERY|DRAWDOWN|RISK|STAB|SCOUT|RANKING_T2/.test(id)
    || /rebound|risk|drawdown|ranking-leader/.test(subGroup)
  ) axes.add("rebound");

  if (/CAFE|MTT/.test(id)) axes.add("confirm");

  return [...axes]
    .sort((a, b) => (AXIS_ORDER.get(a) ?? 99) - (AXIS_ORDER.get(b) ?? 99));
}

export function axesForMatches(matches) {
  const axes = new Set();
  for (const match of matches ?? []) {
    for (const axis of strategyAxes(match)) axes.add(axis);
  }
  return [...axes]
    .sort((a, b) => (AXIS_ORDER.get(a) ?? 99) - (AXIS_ORDER.get(b) ?? 99))
    .map((id) => ({ id, label: AXIS_LABEL.get(id) ?? id }));
}

function featureFromRow(row, market) {
  const scout = row?.scout ?? null;
  const leader = row?.leader ?? null;
  const combined = row?.combined ?? null;
  const confirmation = row?.confirmation ?? null;
  const supply = row?.supply ?? null;
  const rawFlags = row?.strategy?.flags ?? null;
  const category = row?.strategy ? simulationCategory(row) : null;
  const price = numberOrNull(row?.price ?? row?.quote?.price);
  const leaderScore = numberOrNull(leader?.score);
  const grade = leader?.grade && leader.grade !== "계산불가" ? leader.grade : null;
  const combinedDecision = combined?.label && combined.label !== "계산불가" ? combined.label : null;

  return {
    code: String(row?.code ?? ""),
    name: row?.name ?? "",
    market,
    signalPrice: price,
    leaderScore,
    leaderGrade: grade,
    leaderRank: leaderScore === null ? null : numberOrNull(leader?.rank),
    rs20: numberOrNull(scout?.rs20),
    rsRank: null,
    combinedScore: numberOrNull(combined?.score),
    combinedRank: numberOrNull(combined?.rank),
    combinedDecision,
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

function strategyMatches(strategy, feature) {
  if (!hasRequiredFields(feature, strategy.requires)) return false;
  if (strategy.type === "ranking") {
    const field = RANKERS[strategy.ranker]?.field;
    return Boolean(field) && finite(feature[field]) && Number(feature[field]) <= strategy.topN;
  }
  return strategy.selector(feature) === true;
}

function orderMatches(matches) {
  return [...matches].sort((a, b) => {
    const featured = Number(FEATURED_SET.has(b.id)) - Number(FEATURED_SET.has(a.id));
    if (featured) return featured;
    return (STRATEGY_INDEX.get(a.id) ?? 9999) - (STRATEGY_INDEX.get(b.id) ?? 9999);
  });
}

function failedCodes(payload) {
  return new Set((payload?.errors ?? [])
    .map((error) => String(error?.code ?? ""))
    .filter(Boolean));
}

export function buildStrategyCandidates(payload) {
  const failed = failedCodes(payload);
  const result = [];

  for (const market of ["KOSPI", "KOSDAQ"]) {
    const rows = payload?.rows?.[market] ?? [];
    const v2Order = new Map(rankMarketRowsV2(rows).map((row, index) => [String(row?.code ?? ""), index + 1]));
    const contexts = rows.map((row) => {
      const feature = featureFromRow(row, market);
      feature.rankingV2Rank = v2Order.get(feature.code) ?? null;
      feature.rankingV2Tier = row?.scout ? reboundRankingTier(row) : null;
      return { row, feature };
    });

    const rsOrder = contexts
      .map((context) => context.feature)
      .filter((feature) => finite(feature.rs20))
      .sort((a, b) => Number(b.rs20) - Number(a.rs20) || a.code.localeCompare(b.code));
    rsOrder.forEach((feature, index) => {
      feature.rsRank = index + 1;
    });

    for (const context of contexts) {
      const { row, feature } = context;
      if (failed.has(feature.code) || !baseValid(feature)) continue;

      const matches = orderMatches(ALL_STRATEGIES.filter((strategy) => strategyMatches(strategy, feature)));
      const featuredMatches = matches.filter((strategy) => FEATURED_SET.has(strategy.id));
      if (!matches.length) continue;

      result.push({
        row,
        feature,
        matches,
        featuredMatches,
        axesAll: axesForMatches(matches),
        axesFeatured: axesForMatches(featuredMatches),
        signals: SIGNAL_KEYS.filter((key) => feature.flags?.[key] === true)
      });
    }
  }

  return result;
}

export function strategyCatalogInfo() {
  return {
    allCount: ALL_STRATEGIES.length,
    featuredCount: FEATURED_STRATEGY_IDS.length,
    featuredIds: [...FEATURED_STRATEGY_IDS]
  };
}
