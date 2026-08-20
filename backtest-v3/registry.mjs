// The catalogue of conditions V3 can test, and the named presets built from
// them. Every field referenced here must exist on the feature matrix rows
// produced by features.mjs — nothing is derived at filter time.

import { defineFilter, bucketFilters, thresholdFilters } from "./filters.mjs";

const F = defineFilter;

// ---------------------------------------------------------------- 종합/타이밍
const combined = [
  ...bucketFilters("종합점수", "combined", "combinedScore",
    [[40, 49], [50, 59], [60, 69], [70, 79], [80, 999, "80+"]]),
  ...thresholdFilters("종합점수", "combined", "combinedScore", [40, 50, 60, 70, 80]),
  F("종합순위_1-3", "combinedRank", { field: "combinedRank", op: "between", value: [1, 3] }),
  F("종합순위_1-5", "combinedRank", { field: "combinedRank", op: "between", value: [1, 5] }),
  F("종합순위_1-10", "combinedRank", { field: "combinedRank", op: "between", value: [1, 10] }),
  F("종합순위_6-10", "combinedRank", { field: "combinedRank", op: "between", value: [6, 10] }),
  F("종합순위_11-20", "combinedRank", { field: "combinedRank", op: "between", value: [11, 20] }),
  F("종합순위_21-50", "combinedRank", { field: "combinedRank", op: "between", value: [21, 50] }),
  F("종합순위_51+", "combinedRank", { field: "combinedRank", op: "gte", value: 51 }),
  F("Gate_PASS", "gate", { field: "gatePass", op: "true" }),
  F("Gate_BLOCK", "gate", { field: "gatePass", op: "false" })
];

// combinedLabel / gateReason values are discovered from the data at runtime,
// so their filters are generated in buildDynamicFilters().

// ---------------------------------------------------------------- Ranking V2
const rankingV2 = [
  ...[1, 2, 3, 4, 5, 6].map((t) => F(`RankingV2_T${t}`, "rankingTier", { field: "rankingTier", op: "eq", value: t })),
  F("RankingV2_TOP3", "rankingV2Rank", { field: "rankingV2Rank", op: "between", value: [1, 3] }),
  F("RankingV2_TOP5", "rankingV2Rank", { field: "rankingV2Rank", op: "between", value: [1, 5] }),
  F("RankingV2_TOP10", "rankingV2Rank", { field: "rankingV2Rank", op: "between", value: [1, 10] }),
  F("RankingV2_TOP20", "rankingV2Rank", { field: "rankingV2Rank", op: "between", value: [1, 20] })
];

// ---------------------------------------------------------------- Leader
const leader = [
  F("Leader_A", "leaderGrade", { field: "leaderGrade", op: "in", value: ["A"] }),
  F("Leader_AB", "leaderGrade", { field: "leaderGrade", op: "in", value: ["A", "B"] }),
  F("Leader_B", "leaderGrade", { field: "leaderGrade", op: "in", value: ["B"] }),
  F("Leader_C", "leaderGrade", { field: "leaderGrade", op: "in", value: ["C"] }),
  F("Leader_D", "leaderGrade", { field: "leaderGrade", op: "in", value: ["D"] }),
  ...thresholdFilters("Leader점수", "leaderScore", "leaderScore", [50, 60, 70, 80, 85, 90]),
  ...bucketFilters("Leader추세", "leaderTrend", "leaderTrendScore", [[0, 33, "하"], [34, 66, "중"], [67, 100, "상"]]),
  ...bucketFilters("Leader상대강도", "leaderRs", "leaderRsScore", [[0, 33, "하"], [34, 66, "중"], [67, 100, "상"]]),
  ...bucketFilters("Leader고점유지", "leaderHigh", "leaderHighScore", [[0, 33, "하"], [34, 66, "중"], [67, 100, "상"]]),
  ...bucketFilters("Leader지속성", "leaderPersist", "leaderPersistenceScore", [[0, 33, "하"], [34, 66, "중"], [67, 100, "상"]]),
  F("Leader_TOP3", "leaderRank", { field: "leaderRank", op: "between", value: [1, 3] }),
  F("Leader_TOP5", "leaderRank", { field: "leaderRank", op: "between", value: [1, 5] }),
  F("Leader_TOP10", "leaderRank", { field: "leaderRank", op: "between", value: [1, 10] }),
  F("Leader_TOP20", "leaderRank", { field: "leaderRank", op: "between", value: [1, 20] })
];

// ---------------------------------------------------------------- RS20
const rs20 = [
  F("RS20_<30", "rs20", { field: "rs20", op: "lt", value: 30 }),
  ...bucketFilters("RS20", "rs20", "rs20", [[30, 49], [50, 69], [70, 79], [80, 89], [90, 99]]),
  ...thresholdFilters("RS20", "rs20", "rs20", [50, 60, 70, 80, 90]),
  F("RS20_TOP10%", "rs20", { field: "rs20", op: "gte", value: 90 }),
  F("RS20_TOP20%", "rs20", { field: "rs20", op: "gte", value: 80 })
];

// ---------------------------------------------------------------- Scout / 반등
const drawdownRanges = [
  [-5, 0, "0~-5"], [-10, -5.0001, "-5~-10"], [-15, -10.0001, "-10~-15"],
  [-20, -15.0001, "-15~-20"], [-30, -20.0001, "-20~-30"], [-40, -30.0001, "-30~-40"],
  [-50, -40.0001, "-40~-50"], [-60, -50.0001, "-50~-60"], [-999, -60.0001, "-60이하"]
];

const scout = [
  ...drawdownRanges.map(([min, max, label]) =>
    F(`낙폭_${label}`, "drawdown", { field: "drawdownFromHighPct", op: "between", value: [min, max] })),
  ...thresholdFilters("낙폭", "drawdownCut", "drawdownFromHighPct", [-10, -15, -20, -30, -40, -50, -60], "lte"),
  ...bucketFilters("Risk", "risk", "scoutRiskScore", [[0, 24], [25, 39], [40, 50], [51, 64], [65, 100, "65+"]]),
  ...thresholdFilters("Risk", "riskCut", "scoutRiskScore", [24, 39, 50, 64], "lte"),
  F("Stab_<45", "stab", { field: "scoutStabilizeScore", op: "lt", value: 45 }),
  ...bucketFilters("Stab", "stab", "scoutStabilizeScore", [[45, 64], [65, 79], [80, 89], [90, 100, "90+"]]),
  ...thresholdFilters("Stab", "stabCut", "scoutStabilizeScore", [45, 65, 80, 90]),
  ...bucketFilters("Cheap", "cheap", "scoutCheapScore", [[0, 39], [40, 59], [60, 79], [80, 100, "80+"]]),
  F("Scout_TOP3", "scoutRank", { field: "scoutRank", op: "between", value: [1, 3] }),
  F("Scout_TOP5", "scoutRank", { field: "scoutRank", op: "between", value: [1, 5] }),
  F("Scout_TOP10", "scoutRank", { field: "scoutRank", op: "between", value: [1, 10] }),
  F("Scout_TOP20", "scoutRank", { field: "scoutRank", op: "between", value: [1, 20] }),
  F("noNewLow5", "noNewLow5", { field: "noNewLow5", op: "true" })
];

// ------------------------------------------------------- confirmation / 반등상태
const confirmation = [
  ...["ready", "stopped", "early", "falling", "risk"].map((k) =>
    F(`반등상태_${k}`, "reboundState", { field: "reboundStateKey", op: "eq", value: k })),
  F("leaderReboundPass", "confirmPass", { field: "leaderReboundPass", op: "true" }),
  F("deepRecoveryPass", "confirmPass", { field: "deepRecoveryPass", op: "true" }),
  F("experimentalNakjuPass", "confirmPass", { field: "experimentalNakjuPass", op: "true" })
];

// ---------------------------------------------------------------- 전략 flags
const flags = ["R", "F", "F2", "B", "C", "H2", "H3", "I"].map((f) =>
  F(`flag_${f}`, "flag", { field: f, op: "true" }));

// ---------------------------------------------------------------- 수급
const supply = [
  ...[2, 3, 5].map((d) => F(`외인연속_${d}일+`, "foreignStreak", { field: "foreignStreak", op: "gte", value: d })),
  ...[2, 3, 5].map((d) => F(`기관연속_${d}일+`, "instStreak", { field: "instStreak", op: "gte", value: d })),
  F("외인or기관_2일+", "streakCombo", { any: [{ field: "foreignStreak", op: "gte", value: 2 }, { field: "instStreak", op: "gte", value: 2 }] }),
  F("외인and기관_2일+", "streakCombo", { all: [{ field: "foreignStreak", op: "gte", value: 2 }, { field: "instStreak", op: "gte", value: 2 }] }),
  F("순매수_합계+", "netAmount", { field: "totalNetAmount", op: "gt", value: 0 }),
  F("5일누적_외인+", "net5", { field: "foreignNet5d", op: "gt", value: 0 }),
  F("5일누적_기관+", "net5", { field: "instNet5d", op: "gt", value: 0 }),
  F("5일누적_둘중하나+", "net5", { any: [{ field: "foreignNet5d", op: "gt", value: 0 }, { field: "instNet5d", op: "gt", value: 0 }] }),
  F("5일누적_둘다+", "net5", { all: [{ field: "foreignNet5d", op: "gt", value: 0 }, { field: "instNet5d", op: "gt", value: 0 }] })
];

// ---------------------------------------------------------------- 거래강도/자금
const liquidity = [
  ...bucketFilters("거래강도", "liquidity", "liquidityScore",
    [[0, 29], [30, 39], [40, 49], [50, 59], [60, 69], [70, 79], [80, 89], [90, 100, "90+"]]),
  ...thresholdFilters("거래강도", "liquidityCut", "liquidityScore", [40, 50, 60, 70, 80, 90]),
  F("거래대금비_<1", "tvRatio", { field: "tradingValueRatio20", op: "lt", value: 1 }),
  ...bucketFilters("거래대금비", "tvRatio", "tradingValueRatio20", [[1, 1.5], [1.5001, 3, "1.5~3"], [3.0001, 5, "3~5"]]),
  F("거래대금비_5+", "tvRatio", { field: "tradingValueRatio20", op: "gte", value: 5 }),
  F("회전율_<1", "turnover", { field: "bodyTurnoverPct", op: "lt", value: 1 }),
  ...bucketFilters("회전율", "turnover", "bodyTurnoverPct", [[1, 5], [5.0001, 10, "5~10"]]),
  F("회전율_10+", "turnover", { field: "bodyTurnoverPct", op: "gte", value: 10 }),
  F("스마트머니_본문", "smartMoney", { field: "smartMoneyBodyPct", op: "gte", value: 0.3 }),
  F("스마트머니_거래비중", "smartMoney", { field: "smartMoneyTradingSharePct", op: "gte", value: 10 }),
  F("스마트머니_둘중하나", "smartMoney", { any: [{ field: "smartMoneyBodyPct", op: "gte", value: 0.3 }, { field: "smartMoneyTradingSharePct", op: "gte", value: 10 }] }),
  F("스마트머니_둘다", "smartMoney", { all: [{ field: "smartMoneyBodyPct", op: "gte", value: 0.3 }, { field: "smartMoneyTradingSharePct", op: "gte", value: 10 }] })
];

// ---------------------------------------------------------------- 기술/가격
const technical = [
  F("당일_-10이하", "dayChange", { field: "changeRate", op: "lte", value: -10 }),
  ...bucketFilters("당일", "dayChange", "changeRate",
    [[-9.9999, -5, "-10~-5"], [-4.9999, -2, "-5~-2"], [-1.9999, 0, "-2~0"], [0.0001, 2, "0~2"], [2.0001, 5, "2~5"], [5.0001, 9.9999, "5~10"]]),
  F("당일_10+", "dayChange", { field: "changeRate", op: "gte", value: 10 }),
  F("3일_-10이하", "change3d", { field: "changeRate3d", op: "lte", value: -10 }),
  ...bucketFilters("3일", "change3d", "changeRate3d",
    [[-9.9999, -5, "-10~-5"], [-4.9999, 0, "-5~0"], [0.0001, 5, "0~5"], [5.0001, 12, "5~12"]]),
  F("3일_12+", "change3d", { field: "changeRate3d", op: "gte", value: 12 }),
  F("VWAP회복", "vwap", { field: "vwapRecovered", op: "true" }),
  F("과열", "overheat", { field: "overheat", op: "true" }),
  F("과열아님", "overheat", { field: "overheat", op: "false" })
];

// ---------------------------------------------------------------- CAFE / MTT
const external = [
  F("CAFE", "cafe", { field: "cafePass", op: "true" }),
  F("MTT", "mtt", { field: "minerviniPass", op: "true" }),
  F("CAFE_AND_MTT", "cafeMtt", { all: [{ field: "cafePass", op: "true" }, { field: "minerviniPass", op: "true" }] }),
  F("CAFE_only", "cafeMtt", { all: [{ field: "cafePass", op: "true" }, { field: "minerviniPass", op: "false" }] }),
  F("MTT_only", "cafeMtt", { all: [{ field: "minerviniPass", op: "true" }, { field: "cafePass", op: "false" }] })
];

export const FILTERS = [
  ...combined, ...rankingV2, ...leader, ...rs20, ...scout,
  ...confirmation, ...flags, ...supply, ...liquidity, ...technical, ...external
];

/** Label filters discovered from the data (combinedLabel, gateReason, scoutStatus). */
export function buildDynamicFilters(rows) {
  const uniq = (field) => [...new Set(rows.map((r) => r[field]).filter((v) => v !== null && v !== undefined && v !== ""))];
  return [
    ...uniq("combinedLabel").map((v) => F(`종합판정_${v}`, "combinedLabel", { field: "combinedLabel", op: "eq", value: v })),
    ...uniq("gateReason").map((v) => F(`Gate사유_${v}`, "gateReason", { field: "gateReason", op: "eq", value: v })),
    ...uniq("scoutStatus").map((v) => F(`정찰상태_${v}`, "scoutStatus", { field: "scoutStatus", op: "eq", value: v }))
  ];
}

const cond = (name) => {
  const found = FILTERS.find((f) => f.name === name);
  if (!found) throw new Error(`Preset references unknown filter: ${name}`);
  return found.condition;
};

/** Named presets. `all` composes existing registry conditions, never new maths. */
export const PRESETS = {
  COMBINED_TOP: { all: [cond("종합순위_1-3")] },
  COMBINED_SPLIT: { all: [cond("종합점수_gte60")] },
  TIMING_TOP10: { all: [cond("종합순위_1-10")] },

  LEADER_A: { all: [cond("Leader_A")] },
  LEADER_AB: { all: [cond("Leader_AB")] },
  LEADER_A_RS80: { all: [cond("Leader_A"), cond("RS20_gte80")] },
  LEADER_A_RS90: { all: [cond("Leader_A"), cond("RS20_gte90")] },

  REBOUND_READY: { all: [cond("반등상태_ready")] },
  REBOUND_STOPPED: { all: [cond("반등상태_stopped")] },
  LEADER_REBOUND: { all: [cond("leaderReboundPass")] },
  DEEP_RECOVERY: { all: [cond("deepRecoveryPass")] },
  DEEP_RECOVERY_LEADER_AB: { all: [cond("deepRecoveryPass"), cond("Leader_AB")] },
  RANKING_V2_T1: { all: [cond("RankingV2_T1")] },
  RANKING_V2_T2: { all: [cond("RankingV2_T2")] },
  RANKING_V2_T3: { all: [cond("RankingV2_T3")] },

  LEADER_A_REBOUND_READY: { all: [cond("Leader_A"), cond("반등상태_ready")] },
  LEADER_A_STOPPED: { all: [cond("Leader_A"), cond("반등상태_stopped")] },
  LEADER_AB_STOPPED: { all: [cond("Leader_AB"), cond("반등상태_stopped")] },
  REBOUND_RS70: { all: [cond("반등상태_ready"), cond("RS20_gte70")] },
  DEEP_RS70: { all: [cond("deepRecoveryPass"), cond("RS20_gte70")] },
  TIMING_TOP10_RS70: { all: [cond("종합순위_1-10"), cond("RS20_gte70")] },

  DD20_40_STAB65_RISK39: { all: [cond("낙폭_-20~-30"), cond("Stab_gte65"), cond("Risk_lte39")] },
  DD40_50_STAB65_RISK39: { all: [cond("낙폭_-40~-50"), cond("Stab_gte65"), cond("Risk_lte39")] },
  DD50_STAB65_RISK39: { all: [cond("낙폭_lte-50"), cond("Stab_gte65"), cond("Risk_lte39")] },

  STREAK_2: { all: [cond("외인or기관_2일+")] },
  STREAK_3: { all: [cond("외인연속_3일+")] },
  SMART_MONEY: { all: [cond("스마트머니_둘중하나")] },
  LIQ70: { all: [cond("거래강도_gte70")] },

  R: { all: [cond("flag_R")] },
  F: { all: [cond("flag_F")] },
  F2: { all: [cond("flag_F2")] },
  B: { all: [cond("flag_B")] },
  C: { all: [cond("flag_C")] },
  H2: { all: [cond("flag_H2")] },
  H3: { all: [cond("flag_H3")] },
  I_CONTROL: { all: [cond("flag_I")] },

  CAFE: { all: [cond("CAFE")] },
  MTT: { all: [cond("MTT")] },
  CAFE_MTT: { all: [cond("CAFE_AND_MTT")] },
  CAFE_TIMING_TOP: { all: [cond("CAFE"), cond("종합순위_1-10")] },
  CAFE_F2: { all: [cond("CAFE"), cond("flag_F2")] },
  CAFE_LEADER_A: { all: [cond("CAFE"), cond("Leader_A")] },
  CAFE_RS80: { all: [cond("CAFE"), cond("RS20_gte80")] },
  MTT_TIMING_TOP: { all: [cond("MTT"), cond("종합순위_1-10")] },
  MTT_F2: { all: [cond("MTT"), cond("flag_F2")] },
  MTT_RISK39: { all: [cond("MTT"), cond("Risk_lte39")] },
  MTT_STAB65: { all: [cond("MTT"), cond("Stab_gte65")] },
  MTT_DD5_20: { all: [cond("MTT"), { field: "drawdownFromHighPct", op: "between", value: [-20, -5] }] },
  MTT_T1: { all: [cond("MTT"), cond("RankingV2_T1")] },
  MTT_T2: { all: [cond("MTT"), cond("RankingV2_T2")] }
};

/**
 * Axis pairs crossed automatically for the 2-factor pass. Only pairs where a
 * combination is meaningful — never two buckets of the same measure.
 */
export const CROSS_AXES = [
  ["leaderGrade", "risk"], ["leaderGrade", "stab"], ["leaderGrade", "drawdown"],
  ["leaderGrade", "rs20"], ["leaderGrade", "combinedRank"], ["leaderGrade", "reboundState"],
  ["drawdown", "stab"], ["drawdown", "risk"], ["drawdown", "rs20"],
  ["stab", "risk"], ["liquidity", "foreignStreak"], ["liquidity", "instStreak"],
  ["liquidity", "smartMoney"], ["mtt", "flag"], ["cafe", "combinedRank"],
  ["rankingTier", "rs20"], ["rankingTier", "leaderGrade"], ["combinedRank", "rs20"]
];

/** 3-factor combinations are enumerated explicitly, never searched. */
export const CORE_TRIPLES = [
  ["Leader_A", "Risk_lte39", "Stab_gte65"],
  ["Leader_AB", "Risk_lte39", "Stab_gte65"],
  ["Leader_A", "낙폭_-20~-30", "RS20_gte70"],
  ["Leader_A", "낙폭_-30~-40", "RS20_gte70"],
  ["Leader_AB", "낙폭_-40~-50", "Stab_gte65"],
  ["MTT", "거래강도_gte60", "RS20_gte70"],
  ["CAFE", "Leader_A", "RS20_gte80"],
  ["flag_F2", "거래강도_gte60", "MTT"],
  ["RankingV2_T2", "RS20_gte70", "거래강도_gte60"],
  ["RankingV2_T3", "RS20_gte70", "거래강도_gte60"],
  ["종합순위_1-10", "Leader_AB", "Risk_lte39"],
  ["반등상태_stopped", "Leader_AB", "RS20_gte70"],
  ["deepRecoveryPass", "Leader_AB", "거래강도_gte60"],
  ["외인or기관_2일+", "거래강도_gte60", "과열아님"]
];

/** Rank systems compared head-to-head in the TOP-N analysis. */
export const RANK_SYSTEMS = [
  { name: "종합타이밍", field: "combinedRank" },
  { name: "RankingV2", field: "rankingV2Rank" },
  { name: "Leader", field: "leaderRank" },
  { name: "Scout반등", field: "scoutRank" }
];

export const TOP_N_LIST = [3, 5, 10, 20];
