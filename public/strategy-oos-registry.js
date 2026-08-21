// Central registry for the live (out-of-sample) strategy comparison.
//
// Every strategy here is an *observation* of logic that already exists in the
// dashboard. Nothing in this file computes a new score, changes a threshold,
// or feeds back into Leader / RS20 / 종합타이밍 / Ranking V2 / Scout / CAFE /
// MTT / the simulator. Selectors only read the frozen feature snapshot built
// from one EOD market payload (see strategy-oos-tracker.js), so adding a
// strategy costs no extra KIS call.
//
// Deliberately NOT auto-generated: only combinations with an economic reason
// are listed. Do not machine-expand A+B+C powersets here - that manufactures
// overfitting.

export const STRATEGY_OOS_SCHEMA = "strategy-oos-1";

// 60D can be appended later without touching stored records: the evaluator
// fills whatever horizons are listed and leaves the rest PENDING.
export const STRATEGY_HORIZONS = [1, 3, 5, 10, 20];

// Same round-trip cost the Ranking V2 OOS tracker and backtest V2.1/V3 use.
export const STRATEGY_OOS_COST_PCT = 0.23;

export const STRATEGY_GROUPS = [
  { id: "ranking", label: "① 순위 전략", description: "상위 N개만 뽑는 방식 (Leader / RS / 종합타이밍 / Ranking V2 / Scout)" },
  { id: "entry", label: "② 실제 진입 전략", description: "현재 진입판정과 개별 전략 flag (C·I는 대조군)" },
  { id: "confirm", label: "③ 전략 확인", description: "CAFE · MTT · 반등 확인 배지" },
  { id: "combo", label: "④ 조합 전략", description: "기존 조건들을 AND로만 결합한 연구용 조합" }
];

// Ranking strategies reuse the rank the live dashboard already assigned, so a
// TOP-N selection is by construction the same list the screen shows.
export const RANKERS = {
  // row.leader.rank: leader score desc, RS score desc, trend desc (server.mjs)
  leader: { id: "leader", label: "Leader", field: "leaderRank" },
  // RS20 percentile desc. RS has no live ranked screen, so ties fall back to
  // the code so the order is deterministic across re-runs.
  rs: { id: "rs", label: "RS20", field: "rsRank" },
  // row.combined.rank: 종합타이밍 (Main 70 + Scout 30) order, rankable only
  timing: { id: "timing", label: "종합타이밍", field: "combinedRank" },
  // rankMarketRowsV2 order (반등우선 Ranking V2 comparator)
  rankingV2: { id: "rankingV2", label: "Ranking V2", field: "rankingV2Rank" },
  // row.scout.reboundRank: 반등후보 화면 정렬(compareReboundCandidate)
  scout: { id: "scout", label: "반등후보", field: "scoutRank" }
};

const leaderA = (f) => f.leaderGrade === "A";
const leaderAB = (f) => f.leaderGrade === "A" || f.leaderGrade === "B";
const flag = (f, key) => f.flags?.[key] === true;
const drawdownBetween = (f, from, to) => f.drawdownPct <= from && f.drawdownPct > to;

function ranking({ id, displayName, ranker, topN, description, requires = [] }) {
  return {
    id,
    displayName,
    type: "ranking",
    group: "ranking",
    subGroup: RANKERS[ranker].id,
    description,
    ranker,
    topN,
    requires,
    enabled: true
  };
}

function condition({ id, displayName, group, subGroup, description, requires = [], selector }) {
  return { id, displayName, type: "condition", group, subGroup, description, requires, selector, enabled: true };
}

const rankingStrategies = [
  ...[1, 3, 5, 10, 20].map((n) => ranking({
    id: `LEADER_TOP${n}`,
    displayName: `Leader TOP${n}`,
    ranker: "leader",
    topN: n,
    requires: ["leaderRank"],
    description: "주도주 화면과 동일한 Leader 점수 순위 상위 N"
  })),
  ...[3, 5, 10, 20].map((n) => ranking({
    id: `RS_TOP${n}`,
    displayName: `RS20 TOP${n}`,
    ranker: "rs",
    topN: n,
    requires: ["rs20"],
    description: "같은 시장 20일 수익률 백분위(RS20) 상위 N"
  })),
  ...[3, 5, 10, 20].map((n) => ranking({
    id: `TIMING_TOP${n}`,
    displayName: `종합타이밍 TOP${n}`,
    ranker: "timing",
    topN: n,
    requires: ["combinedRank"],
    description: "메인 종합타이밍(Main70+Scout30) 정렬 상위 N"
  })),
  ...[3, 5, 10, 20].map((n) => ranking({
    id: `RANKING_V2_TOP${n}`,
    displayName: `Ranking V2 TOP${n}`,
    ranker: "rankingV2",
    topN: n,
    requires: ["rankingV2Rank"],
    description: "반등우선 Ranking V2 comparator 상위 N"
  })),
  ...[3, 5, 10, 20].map((n) => ranking({
    id: `SCOUT_TOP${n}`,
    displayName: `반등후보 TOP${n}`,
    ranker: "scout",
    topN: n,
    requires: ["scoutRank"],
    description: "반등후보(Scout) 화면 정렬 상위 N"
  }))
];

const rsConditions = [
  condition({
    id: "RS80_PLUS", displayName: "RS20 80 이상", group: "ranking", subGroup: "rs",
    requires: ["rs20"], selector: (f) => f.rs20 >= 80,
    description: "RS20 백분위 80 이상 전체 (개수 제한 없음)"
  }),
  condition({
    id: "RS90_PLUS", displayName: "RS20 90 이상", group: "ranking", subGroup: "rs",
    requires: ["rs20"], selector: (f) => f.rs20 >= 90,
    description: "RS20 백분위 90 이상 전체"
  })
];

const entryStrategies = [
  condition({
    id: "ACTIONABLE_ALL", displayName: "진입후보 전체", group: "entry", subGroup: "entry",
    requires: ["actionable"], selector: (f) => f.actionable === true,
    description: "현재 시뮬레이터 진입판정(actionable) 전체"
  }),
  condition({
    id: "COMBINED_TOP", displayName: "종합 최우선", group: "entry", subGroup: "entry",
    requires: ["combinedDecision"], selector: (f) => f.combinedDecision === "종합 최우선",
    description: "종합타이밍 판정이 종합 최우선인 종목"
  }),
  condition({
    id: "COMBINED_SPLIT", displayName: "종합 분할후보", group: "entry", subGroup: "entry",
    requires: ["combinedDecision"], selector: (f) => f.combinedDecision === "종합 분할후보",
    description: "종합타이밍 판정이 종합 분할후보인 종목"
  }),
  condition({
    id: "SPECIAL_SHORT", displayName: "단기 특수", group: "entry", subGroup: "entry",
    requires: ["combinedDecision"], selector: (f) => f.combinedDecision === "단기 특수",
    description: "종합타이밍 판정이 단기 특수(H3 기반)인 종목"
  }),
  ...[
    ["R", "엄격 눌림 R"],
    ["F", "눌림 F"],
    ["F2", "연속수급 눌림 F2"],
    ["B", "수급 B"],
    ["C", "관심/관찰 C (대조군)"],
    ["H2", "낙주 H2"],
    ["H3", "강수급 낙주 H3"],
    ["I", "매수보류 I (대조군)"]
  ].map(([key, label]) => condition({
    id: `FLAG_${key}`, displayName: label, group: "entry", subGroup: "flag",
    requires: ["flags"], selector: (f) => flag(f, key),
    description: `현재 전략 flag ${key} 충족 종목 전체`
  }))
];

const confirmStrategies = [
  condition({
    id: "CAFE", displayName: "CAFE", group: "confirm", subGroup: "confirm",
    requires: ["cafe"], selector: (f) => f.cafe === true,
    description: "CAFE 눌림 확인 배지 통과"
  }),
  condition({
    id: "MTT", displayName: "MTT", group: "confirm", subGroup: "confirm",
    requires: ["mtt"], selector: (f) => f.mtt === true,
    description: "Minervini 추세 템플릿 통과"
  }),
  condition({
    id: "CAFE_AND_MTT", displayName: "CAFE + MTT", group: "confirm", subGroup: "confirm",
    requires: ["cafe", "mtt"], selector: (f) => f.cafe === true && f.mtt === true,
    description: "CAFE와 MTT 동시 통과"
  }),
  condition({
    id: "LEADER_REBOUND", displayName: "좋은종목 반등", group: "confirm", subGroup: "confirm",
    requires: ["leaderRebound"], selector: (f) => f.leaderRebound === true,
    description: "Leader A + Scout 안정 구간 (현재 정의 그대로)"
  }),
  condition({
    id: "DEEP_RECOVERY", displayName: "깊은낙폭 회복", group: "confirm", subGroup: "confirm",
    requires: ["deepRecovery"], selector: (f) => f.deepRecovery === true,
    description: "낙폭 -35% 이하에서 안정·저위험 확인"
  }),
  condition({
    id: "REBOUND_READY", displayName: "반등 1차 후보", group: "confirm", subGroup: "confirm",
    requires: ["reboundStatus"], selector: (f) => f.reboundStatus === "ready",
    description: "전략확인 반등상태 = 반등 1차 후보"
  }),
  condition({
    id: "REBOUND_STOPPED", displayName: "하락 정지 확인", group: "confirm", subGroup: "confirm",
    requires: ["reboundStatus"], selector: (f) => f.reboundStatus === "stopped",
    description: "전략확인 반등상태 = 하락 정지 확인"
  })
];

const comboStrategies = [
  // Leader + 진입
  condition({
    id: "LEADER_A_AND_ACTIONABLE", displayName: "Leader A + 진입후보", group: "combo", subGroup: "leader-entry",
    requires: ["leaderGrade", "actionable"], selector: (f) => leaderA(f) && f.actionable === true,
    description: "Leader A 등급이면서 진입판정 통과"
  }),
  condition({
    id: "LEADER_AB_AND_ACTIONABLE", displayName: "Leader A·B + 진입후보", group: "combo", subGroup: "leader-entry",
    requires: ["leaderGrade", "actionable"], selector: (f) => leaderAB(f) && f.actionable === true,
    description: "Leader A 또는 B이면서 진입판정 통과"
  }),
  // Leader + RS
  condition({
    id: "LEADER_A_AND_RS80", displayName: "Leader A + RS80", group: "combo", subGroup: "leader-rs",
    requires: ["leaderGrade", "rs20"], selector: (f) => leaderA(f) && f.rs20 >= 80,
    description: "Leader A + RS20 80 이상"
  }),
  condition({
    id: "LEADER_A_AND_RS90", displayName: "Leader A + RS90", group: "combo", subGroup: "leader-rs",
    requires: ["leaderGrade", "rs20"], selector: (f) => leaderA(f) && f.rs20 >= 90,
    description: "Leader A + RS20 90 이상"
  }),
  condition({
    id: "LEADER_AB_AND_RS80", displayName: "Leader A·B + RS80", group: "combo", subGroup: "leader-rs",
    requires: ["leaderGrade", "rs20"], selector: (f) => leaderAB(f) && f.rs20 >= 80,
    description: "Leader A 또는 B + RS20 80 이상"
  }),
  condition({
    id: "LEADER_90_AND_RS90", displayName: "Leader 90점 + RS90", group: "combo", subGroup: "leader-rs",
    requires: ["leaderScore", "rs20"], selector: (f) => f.leaderScore >= 90 && f.rs20 >= 90,
    description: "Leader 점수 90 이상 + RS20 90 이상"
  }),
  // Leader + RS + 진입
  condition({
    id: "LEADER_A_AND_RS80_AND_ACTIONABLE", displayName: "Leader A + RS80 + 진입후보", group: "combo", subGroup: "leader-rs-entry",
    requires: ["leaderGrade", "rs20", "actionable"], selector: (f) => leaderA(f) && f.rs20 >= 80 && f.actionable === true,
    description: "핵심 조합: 주도주 + 상대강도 + 실제 진입판정"
  }),
  condition({
    id: "LEADER_A_AND_RS90_AND_ACTIONABLE", displayName: "Leader A + RS90 + 진입후보", group: "combo", subGroup: "leader-rs-entry",
    requires: ["leaderGrade", "rs20", "actionable"], selector: (f) => leaderA(f) && f.rs20 >= 90 && f.actionable === true,
    description: "Leader A + RS20 90 이상 + 진입판정"
  }),
  condition({
    id: "LEADER_AB_AND_RS80_AND_ACTIONABLE", displayName: "Leader A·B + RS80 + 진입후보", group: "combo", subGroup: "leader-rs-entry",
    requires: ["leaderGrade", "rs20", "actionable"], selector: (f) => leaderAB(f) && f.rs20 >= 80 && f.actionable === true,
    description: "Leader A·B + RS20 80 이상 + 진입판정"
  }),
  // Leader + 기존 눌림 전략
  ...[
    ["R", "LEADER_A_AND_R", "Leader A + R"],
    ["F", "LEADER_A_AND_F", "Leader A + F"],
    ["F2", "LEADER_A_AND_F2", "Leader A + F2"],
    ["H3", "LEADER_A_AND_H3", "Leader A + H3"]
  ].map(([key, id, displayName]) => condition({
    id, displayName, group: "combo", subGroup: "leader-flag",
    requires: ["leaderGrade", "flags"], selector: (f) => leaderA(f) && flag(f, key),
    description: `Leader A + 전략 flag ${key}`
  })),
  condition({
    id: "LEADER_AB_AND_F2", displayName: "Leader A·B + F2", group: "combo", subGroup: "leader-flag",
    requires: ["leaderGrade", "flags"], selector: (f) => leaderAB(f) && flag(f, "F2"),
    description: "Leader A 또는 B + 전략 flag F2"
  }),
  // Leader + 반등
  condition({
    id: "LEADER_A_AND_REBOUND_READY", displayName: "Leader A + 반등 1차", group: "combo", subGroup: "leader-rebound",
    requires: ["leaderGrade", "reboundStatus"], selector: (f) => leaderA(f) && f.reboundStatus === "ready",
    description: "Leader A + 반등상태 ready"
  }),
  condition({
    id: "LEADER_A_AND_REBOUND_STOPPED", displayName: "Leader A + 하락정지", group: "combo", subGroup: "leader-rebound",
    requires: ["leaderGrade", "reboundStatus"], selector: (f) => leaderA(f) && f.reboundStatus === "stopped",
    description: "Leader A + 반등상태 stopped"
  }),
  condition({
    id: "LEADER_AB_AND_REBOUND_READY", displayName: "Leader A·B + 반등 1차", group: "combo", subGroup: "leader-rebound",
    requires: ["leaderGrade", "reboundStatus"], selector: (f) => leaderAB(f) && f.reboundStatus === "ready",
    description: "Leader A·B + 반등상태 ready"
  }),
  condition({
    id: "LEADER_AB_AND_REBOUND_STOPPED", displayName: "Leader A·B + 하락정지", group: "combo", subGroup: "leader-rebound",
    requires: ["leaderGrade", "reboundStatus"], selector: (f) => leaderAB(f) && f.reboundStatus === "stopped",
    description: "Leader A·B + 반등상태 stopped"
  }),
  // Leader + Risk / Stabilize (연구용 조합, 라이브 기준 변경 아님)
  condition({
    id: "LEADER_A_AND_RISK24", displayName: "Leader A + Risk≤24", group: "combo", subGroup: "leader-risk",
    requires: ["leaderGrade", "riskScore"], selector: (f) => leaderA(f) && f.riskScore <= 24,
    description: "Leader A + Scout Risk 24 이하"
  }),
  condition({
    id: "LEADER_A_AND_RISK39", displayName: "Leader A + Risk≤39", group: "combo", subGroup: "leader-risk",
    requires: ["leaderGrade", "riskScore"], selector: (f) => leaderA(f) && f.riskScore <= 39,
    description: "Leader A + Scout Risk 39 이하"
  }),
  ...[65, 80, 90].map((threshold) => condition({
    id: `LEADER_A_AND_STAB${threshold}`, displayName: `Leader A + Stab≥${threshold}`, group: "combo", subGroup: "leader-risk",
    requires: ["leaderGrade", "stabilizeScore"], selector: (f) => leaderA(f) && f.stabilizeScore >= threshold,
    description: `Leader A + Stabilize ${threshold} 이상`
  })),
  condition({
    id: "LEADER_A_AND_RISK24_AND_STAB80", displayName: "Leader A + Risk≤24 + Stab≥80", group: "combo", subGroup: "leader-risk",
    requires: ["leaderGrade", "riskScore", "stabilizeScore"],
    selector: (f) => leaderA(f) && f.riskScore <= 24 && f.stabilizeScore >= 80,
    description: "Leader A + 저위험 + 고안정"
  }),
  condition({
    id: "LEADER_AB_AND_RISK24_AND_STAB80", displayName: "Leader A·B + Risk≤24 + Stab≥80", group: "combo", subGroup: "leader-risk",
    requires: ["leaderGrade", "riskScore", "stabilizeScore"],
    selector: (f) => leaderAB(f) && f.riskScore <= 24 && f.stabilizeScore >= 80,
    description: "Leader A·B + 저위험 + 고안정"
  }),
  // Ranking / Scout + Leader
  condition({
    id: "RANKING_T2_AND_LEADER_A", displayName: "Ranking T2 + Leader A", group: "combo", subGroup: "ranking-leader",
    requires: ["rankingV2Tier", "leaderGrade"], selector: (f) => f.rankingV2Tier === 2 && leaderA(f),
    description: "Ranking V2 T2 + Leader A"
  }),
  condition({
    id: "RANKING_T2_AND_LEADER_AB", displayName: "Ranking T2 + Leader A·B", group: "combo", subGroup: "ranking-leader",
    requires: ["rankingV2Tier", "leaderGrade"], selector: (f) => f.rankingV2Tier === 2 && leaderAB(f),
    description: "Ranking V2 T2 + Leader A·B"
  }),
  condition({
    id: "SCOUT_READY_AND_LEADER_A", displayName: "Scout 1차매수 + Leader A", group: "combo", subGroup: "ranking-leader",
    requires: ["scoutStatus", "leaderGrade"], selector: (f) => f.scoutStatus === "1차 매수 검토" && leaderA(f),
    description: "Scout 상태 1차 매수 검토 + Leader A"
  }),
  condition({
    id: "SCOUT_READY_AND_LEADER_AB", displayName: "Scout 1차매수 + Leader A·B", group: "combo", subGroup: "ranking-leader",
    requires: ["scoutStatus", "leaderGrade"], selector: (f) => f.scoutStatus === "1차 매수 검토" && leaderAB(f),
    description: "Scout 상태 1차 매수 검토 + Leader A·B"
  }),
  condition({
    id: "SCOUT_STOPPED_AND_LEADER_A", displayName: "Scout 하락정지 + Leader A", group: "combo", subGroup: "ranking-leader",
    requires: ["scoutStatus", "leaderGrade"], selector: (f) => f.scoutStatus === "하락 정지 확인" && leaderA(f),
    description: "Scout 상태 하락 정지 확인 + Leader A"
  }),
  condition({
    id: "DEEP_RECOVERY_AND_LEADER_AB", displayName: "깊은낙폭 회복 + Leader A·B", group: "combo", subGroup: "ranking-leader",
    requires: ["deepRecovery", "leaderGrade"], selector: (f) => f.deepRecovery === true && leaderAB(f),
    description: "깊은낙폭 회복 배지 + Leader A·B"
  }),
  // CAFE / MTT 조합
  condition({
    id: "CAFE_AND_ACTIONABLE", displayName: "CAFE + 진입후보", group: "combo", subGroup: "cafe-mtt",
    requires: ["cafe", "actionable"], selector: (f) => f.cafe === true && f.actionable === true,
    description: "CAFE 통과 + 진입판정"
  }),
  condition({
    id: "MTT_AND_ACTIONABLE", displayName: "MTT + 진입후보", group: "combo", subGroup: "cafe-mtt",
    requires: ["mtt", "actionable"], selector: (f) => f.mtt === true && f.actionable === true,
    description: "MTT 통과 + 진입판정"
  }),
  condition({
    id: "CAFE_AND_MTT_AND_ACTIONABLE", displayName: "CAFE + MTT + 진입후보", group: "combo", subGroup: "cafe-mtt",
    requires: ["cafe", "mtt", "actionable"], selector: (f) => f.cafe === true && f.mtt === true && f.actionable === true,
    description: "CAFE·MTT 동시 통과 + 진입판정"
  }),
  condition({
    id: "CAFE_AND_F2", displayName: "CAFE + F2", group: "combo", subGroup: "cafe-mtt",
    requires: ["cafe", "flags"], selector: (f) => f.cafe === true && flag(f, "F2"),
    description: "CAFE + 전략 flag F2"
  }),
  condition({
    id: "MTT_AND_F2", displayName: "MTT + F2", group: "combo", subGroup: "cafe-mtt",
    requires: ["mtt", "flags"], selector: (f) => f.mtt === true && flag(f, "F2"),
    description: "MTT + 전략 flag F2"
  }),
  condition({
    id: "CAFE_AND_MTT_AND_F2", displayName: "CAFE + MTT + F2", group: "combo", subGroup: "cafe-mtt",
    requires: ["cafe", "mtt", "flags"], selector: (f) => f.cafe === true && f.mtt === true && flag(f, "F2"),
    description: "CAFE·MTT 동시 통과 + F2"
  }),
  condition({
    id: "CAFE_AND_LEADER_A", displayName: "CAFE + Leader A", group: "combo", subGroup: "cafe-mtt",
    requires: ["cafe", "leaderGrade"], selector: (f) => f.cafe === true && leaderA(f),
    description: "CAFE + Leader A"
  }),
  condition({
    id: "MTT_AND_LEADER_A", displayName: "MTT + Leader A", group: "combo", subGroup: "cafe-mtt",
    requires: ["mtt", "leaderGrade"], selector: (f) => f.mtt === true && leaderA(f),
    description: "MTT + Leader A"
  }),
  condition({
    id: "CAFE_AND_MTT_AND_LEADER_A", displayName: "CAFE + MTT + Leader A", group: "combo", subGroup: "cafe-mtt",
    requires: ["cafe", "mtt", "leaderGrade"], selector: (f) => f.cafe === true && f.mtt === true && leaderA(f),
    description: "CAFE·MTT 동시 통과 + Leader A"
  }),
  condition({
    id: "MTT_AND_LEADER_A_AND_RS80", displayName: "MTT + Leader A + RS80", group: "combo", subGroup: "cafe-mtt",
    requires: ["mtt", "leaderGrade", "rs20"], selector: (f) => f.mtt === true && leaderA(f) && f.rs20 >= 80,
    description: "MTT + Leader A + RS20 80 이상"
  }),
  condition({
    id: "CAFE_AND_LEADER_A_AND_RS80", displayName: "CAFE + Leader A + RS80", group: "combo", subGroup: "cafe-mtt",
    requires: ["cafe", "leaderGrade", "rs20"], selector: (f) => f.cafe === true && leaderA(f) && f.rs20 >= 80,
    description: "CAFE + Leader A + RS20 80 이상"
  }),
  // 낙폭 구간 (연구용. V3에서 -60% 이하가 fragile했으므로 매수규칙으로 승격하지 않는다)
  condition({
    id: "DRAWDOWN_10_20", displayName: "낙폭 10~20%", group: "combo", subGroup: "drawdown",
    requires: ["drawdownPct"], selector: (f) => drawdownBetween(f, -10, -20),
    description: "고점 대비 -10% ~ -20% 구간"
  }),
  condition({
    id: "DRAWDOWN_20_30", displayName: "낙폭 20~30%", group: "combo", subGroup: "drawdown",
    requires: ["drawdownPct"], selector: (f) => drawdownBetween(f, -20, -30),
    description: "고점 대비 -20% ~ -30% 구간"
  }),
  condition({
    id: "DRAWDOWN_30_40", displayName: "낙폭 30~40%", group: "combo", subGroup: "drawdown",
    requires: ["drawdownPct"], selector: (f) => drawdownBetween(f, -30, -40),
    description: "고점 대비 -30% ~ -40% 구간"
  }),
  condition({
    id: "DRAWDOWN_40_50", displayName: "낙폭 40~50%", group: "combo", subGroup: "drawdown",
    requires: ["drawdownPct"], selector: (f) => drawdownBetween(f, -40, -50),
    description: "고점 대비 -40% ~ -50% 구간"
  }),
  condition({
    id: "DRAWDOWN_50_60", displayName: "낙폭 50~60%", group: "combo", subGroup: "drawdown",
    requires: ["drawdownPct"], selector: (f) => drawdownBetween(f, -50, -60),
    description: "고점 대비 -50% ~ -60% 구간"
  }),
  condition({
    id: "DRAWDOWN_60_PLUS", displayName: "낙폭 60% 이상", group: "combo", subGroup: "drawdown",
    requires: ["drawdownPct"], selector: (f) => f.drawdownPct <= -60,
    description: "고점 대비 -60% 이하 (연구용 · 매수규칙 아님)"
  }),
  condition({
    id: "LEADER_A_AND_DRAWDOWN_10_20", displayName: "Leader A + 낙폭 10~20%", group: "combo", subGroup: "drawdown",
    requires: ["leaderGrade", "drawdownPct"], selector: (f) => leaderA(f) && drawdownBetween(f, -10, -20),
    description: "Leader A + 얕은 조정"
  }),
  condition({
    id: "LEADER_A_AND_DRAWDOWN_20_30", displayName: "Leader A + 낙폭 20~30%", group: "combo", subGroup: "drawdown",
    requires: ["leaderGrade", "drawdownPct"], selector: (f) => leaderA(f) && drawdownBetween(f, -20, -30),
    description: "Leader A + 중간 조정"
  }),
  condition({
    id: "LEADER_A_AND_DRAWDOWN_30_40", displayName: "Leader A + 낙폭 30~40%", group: "combo", subGroup: "drawdown",
    requires: ["leaderGrade", "drawdownPct"], selector: (f) => leaderA(f) && drawdownBetween(f, -30, -40),
    description: "Leader A + 깊은 조정"
  }),
  condition({
    id: "LEADER_AB_AND_DRAWDOWN_40_PLUS", displayName: "Leader A·B + 낙폭 40% 이상", group: "combo", subGroup: "drawdown",
    requires: ["leaderGrade", "drawdownPct"], selector: (f) => leaderAB(f) && f.drawdownPct <= -40,
    description: "Leader A·B + -40% 이하 낙폭 (연구용)"
  })
];

export const STRATEGY_REGISTRY = [
  ...rankingStrategies,
  ...rsConditions,
  ...entryStrategies,
  ...confirmStrategies,
  ...comboStrategies
];

// 대표 비교표 (실전검증 첫 화면). 나머지는 "전체전략 보기"에서 확인한다.
export const FEATURED_STRATEGY_IDS = [
  "LEADER_TOP3",
  "LEADER_TOP10",
  "RS_TOP10",
  "LEADER_A_AND_RS80",
  "LEADER_A_AND_RS80_AND_ACTIONABLE",
  "ACTIONABLE_ALL",
  "FLAG_F2",
  "TIMING_TOP10",
  "RANKING_V2_TOP10",
  "SCOUT_TOP10",
  "CAFE",
  "MTT",
  "CAFE_AND_ACTIONABLE",
  "MTT_AND_ACTIONABLE"
];

const byId = new Map(STRATEGY_REGISTRY.map((strategy) => [strategy.id, strategy]));

export function strategyById(id) {
  return byId.get(id) ?? null;
}

export function enabledStrategies() {
  return STRATEGY_REGISTRY.filter((strategy) => strategy.enabled !== false);
}

/**
 * A feature field counts as available only when it is neither null nor
 * undefined. Missing data is never coerced to 0 / false: the stock is simply
 * not eligible for that strategy and is reported in diagnostics instead.
 */
export function hasRequiredFields(feature, requires = []) {
  return requires.every((field) => feature?.[field] !== null && feature?.[field] !== undefined);
}

export function strategyMeta(strategy) {
  return {
    id: strategy.id,
    displayName: strategy.displayName,
    type: strategy.type,
    group: strategy.group,
    subGroup: strategy.subGroup,
    description: strategy.description,
    topN: strategy.topN ?? null,
    ranker: strategy.ranker ?? null
  };
}

export function registryDuplicateIds() {
  const seen = new Set();
  const duplicates = [];
  for (const strategy of STRATEGY_REGISTRY) {
    if (seen.has(strategy.id)) duplicates.push(strategy.id);
    seen.add(strategy.id);
  }
  return duplicates;
}
