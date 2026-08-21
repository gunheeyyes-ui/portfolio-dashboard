import {
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

const BASE_STRATEGIES = enabledStrategies();
const AXIS_ORDER = new Map(STRATEGY_AXES.map((axis, index) => [axis.id, index]));
const AXIS_LABEL = new Map(STRATEGY_AXES.map((axis) => [axis.id, axis.label]));

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

export function strategyAxes(strategy) {
  const id = String(strategy?.id ?? "");
  const subGroup = String(strategy?.subGroup ?? "");
  const axes = new Set();

  if (strategy?.ranker === "leader" || id.includes("LEADER") || subGroup.includes("leader")) axes.add("leader");
  if (strategy?.ranker === "rs" || id.startsWith("RS") || id.includes("_RS")) axes.add("rs");
  if (strategy?.ranker === "timing" || id.startsWith("TIMING_") || id.startsWith("COMBINED_")) axes.add("timing");

  // COMBINED_* is intentionally timing-only. Entry means a live entry verdict,
  // an entry flag, or a combination that explicitly depends on one of them.
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

  return [...axes].sort((a, b) => (AXIS_ORDER.get(a) ?? 99) - (AXIS_ORDER.get(b) ?? 99));
}

export function axesForStrategies(strategies) {
  const axes = new Set();
  for (const strategy of strategies ?? []) {
    for (const axis of strategyAxes(strategy)) axes.add(axis);
  }
  return [...axes]
    .sort((a, b) => (AXIS_ORDER.get(a) ?? 99) - (AXIS_ORDER.get(b) ?? 99))
    .map((id) => ({ id, label: AXIS_LABEL.get(id) ?? id }));
}

export function strategyMatchesFeature(strategy, feature) {
  if (!hasRequiredFields(feature, strategy.requires)) return false;
  if (strategy.type === "ranking") {
    const field = RANKERS[strategy.ranker]?.field;
    return Boolean(field) && finite(feature[field]) && Number(feature[field]) <= strategy.topN;
  }
  return strategy.selector(feature) === true;
}

export function evaluateBaseConsensus(feature) {
  const matches = BASE_STRATEGIES.filter((strategy) => strategyMatchesFeature(strategy, feature));
  const axes = axesForStrategies(matches);
  const axisIds = axes.map((axis) => axis.id);
  const axisSet = new Set(axisIds);
  return {
    strategyMatchCount: matches.length,
    strategyAxisCount: axes.length,
    strategyAxisIds: axisIds,
    strategyHasLeaderAxis: axisSet.has("leader"),
    strategyHasRsAxis: axisSet.has("rs"),
    strategyHasTimingAxis: axisSet.has("timing"),
    strategyHasEntryAxis: axisSet.has("entry"),
    strategyHasReboundAxis: axisSet.has("rebound"),
    strategyHasConfirmAxis: axisSet.has("confirm"),
    matches,
    axes
  };
}
