// Derived validation cohorts built from the *existing* base strategy matches.
// These do not feed back into the base match count, scores, ranks, or simulator
// entry decision. They only ask whether broad agreement itself has predictive
// value. Keeping them separate prevents recursive "a consensus strategy counts
// as another matching strategy" inflation.

export const CONSENSUS_STRATEGY_GROUP = {
  id: "consensus",
  label: "⑤ 전략·계열 합의",
  description: "기존 전략 겹침 수와 독립 계열 수가 실제 미래수익에 도움이 되는지 검증"
};

function condition({ id, displayName, description, selector, requires = [] }) {
  return {
    id,
    displayName,
    type: "condition",
    group: "consensus",
    subGroup: "consensus",
    description,
    selector,
    requires,
    enabled: true
  };
}

const hasLeaderRs = (f) => f.strategyHasLeaderAxis === true && f.strategyHasRsAxis === true;

export const CONSENSUS_STRATEGIES = [
  condition({
    id: "CONSENSUS_STRATEGY_3_PLUS",
    displayName: "전략 3개+",
    requires: ["strategyMatchCount"],
    selector: (f) => f.strategyMatchCount >= 3,
    description: "기존 94개 기본 전략 중 3개 이상 동시 통과"
  }),
  condition({
    id: "CONSENSUS_STRATEGY_5_PLUS",
    displayName: "전략 5개+",
    requires: ["strategyMatchCount"],
    selector: (f) => f.strategyMatchCount >= 5,
    description: "기존 94개 기본 전략 중 5개 이상 동시 통과"
  }),
  condition({
    id: "CONSENSUS_STRATEGY_7_PLUS",
    displayName: "전략 7개+",
    requires: ["strategyMatchCount"],
    selector: (f) => f.strategyMatchCount >= 7,
    description: "기존 94개 기본 전략 중 7개 이상 동시 통과"
  }),
  condition({
    id: "CONSENSUS_AXIS_2_PLUS",
    displayName: "독립 2계열+",
    requires: ["strategyAxisCount"],
    selector: (f) => f.strategyAxisCount >= 2,
    description: "주도·RS·타이밍·진입·반등·CAFE/MTT 중 2개 이상 독립 계열 합의"
  }),
  condition({
    id: "CONSENSUS_AXIS_3_PLUS",
    displayName: "독립 3계열+",
    requires: ["strategyAxisCount"],
    selector: (f) => f.strategyAxisCount >= 3,
    description: "서로 다른 독립 계열 3개 이상 합의"
  }),
  condition({
    id: "CONSENSUS_AXIS_4_PLUS",
    displayName: "독립 4계열+",
    requires: ["strategyAxisCount"],
    selector: (f) => f.strategyAxisCount >= 4,
    description: "서로 다른 독립 계열 4개 이상 합의"
  }),
  condition({
    id: "CONSENSUS_5S_3A",
    displayName: "5전략+ · 3계열+",
    requires: ["strategyMatchCount", "strategyAxisCount"],
    selector: (f) => f.strategyMatchCount >= 5 && f.strategyAxisCount >= 3,
    description: "전략 수와 독립 계열 수가 모두 높은 핵심 합의군"
  }),
  condition({
    id: "CONSENSUS_5S_4A",
    displayName: "5전략+ · 4계열+",
    requires: ["strategyMatchCount", "strategyAxisCount"],
    selector: (f) => f.strategyMatchCount >= 5 && f.strategyAxisCount >= 4,
    description: "5개 이상 전략과 4개 이상 독립 계열이 동시에 합의"
  }),
  condition({
    id: "CONSENSUS_3A_LEADER_RS",
    displayName: "3계열+ · Leader+RS",
    requires: ["strategyAxisCount", "strategyHasLeaderAxis", "strategyHasRsAxis"],
    selector: (f) => f.strategyAxisCount >= 3 && hasLeaderRs(f),
    description: "독립 3계열 이상이며 Leader와 RS 계열을 모두 포함"
  }),
  condition({
    id: "CONSENSUS_4A_LEADER_RS",
    displayName: "4계열+ · Leader+RS",
    requires: ["strategyAxisCount", "strategyHasLeaderAxis", "strategyHasRsAxis"],
    selector: (f) => f.strategyAxisCount >= 4 && hasLeaderRs(f),
    description: "독립 4계열 이상이며 Leader와 RS 계열을 모두 포함"
  }),
  condition({
    id: "CONSENSUS_3A_ACTIONABLE",
    displayName: "3계열+ · 실제진입",
    requires: ["strategyAxisCount", "actionable"],
    selector: (f) => f.strategyAxisCount >= 3 && f.actionable === true,
    description: "독립 3계열 이상 합의 + 기존 시뮬레이터 실제 진입판정"
  }),
  condition({
    id: "CONSENSUS_4A_ACTIONABLE",
    displayName: "4계열+ · 실제진입",
    requires: ["strategyAxisCount", "actionable"],
    selector: (f) => f.strategyAxisCount >= 4 && f.actionable === true,
    description: "독립 4계열 이상 합의 + 기존 시뮬레이터 실제 진입판정"
  }),
  condition({
    id: "CONSENSUS_5S_3A_ACTIONABLE",
    displayName: "5전략+ · 3계열+ · 실제진입",
    requires: ["strategyMatchCount", "strategyAxisCount", "actionable"],
    selector: (f) => f.strategyMatchCount >= 5 && f.strategyAxisCount >= 3 && f.actionable === true,
    description: "다중 전략·다중 계열 합의와 실제 진입판정이 동시에 충족"
  })
];

export const CONSENSUS_FEATURED_STRATEGY_IDS = [
  "CONSENSUS_5S_3A",
  "CONSENSUS_5S_4A",
  "CONSENSUS_4A_LEADER_RS",
  "CONSENSUS_4A_ACTIONABLE",
  "CONSENSUS_5S_3A_ACTIONABLE"
];
