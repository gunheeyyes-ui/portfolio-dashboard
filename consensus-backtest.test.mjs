import test from "node:test";
import assert from "node:assert/strict";

import { annotateConsensusRows } from "./backtest-v3/consensus.mjs";
import { CONSENSUS_STRATEGIES } from "./public/strategy-consensus-cohorts.js";

function matrixRow(code, rs20, overrides = {}) {
  return {
    date: "20260820",
    market: "KOSPI",
    code,
    name: `테스트${code}`,
    combinedScore: 88,
    combinedRank: 1,
    combinedLabel: "종합 최우선",
    leaderScore: 92,
    leaderGrade: "A",
    leaderRank: 1,
    rs20,
    rankingTier: 1,
    rankingV2Rank: 1,
    scoutRank: 1,
    scoutStatus: "하락 정지 확인",
    reboundStateKey: "ready",
    drawdownFromHighPct: -25,
    scoutRiskScore: 20,
    scoutStabilizeScore: 85,
    liquidityScore: 80,
    foreignStreak: 3,
    instStreak: 2,
    R: true,
    F: true,
    F2: true,
    B: true,
    C: false,
    H2: false,
    H3: false,
    I: false,
    overheat: false,
    cafePass: true,
    minerviniPass: true,
    leaderReboundPass: true,
    deepRecoveryPass: true,
    ...overrides
  };
}

test("historical matrix gets base-strategy overlap and six-axis consensus without network data", () => {
  const rows = [matrixRow("000001", 95), matrixRow("000002", 85, { leaderRank: 2, combinedRank: 2, rankingV2Rank: 2, scoutRank: 2 })];
  annotateConsensusRows(rows);

  assert.ok(rows[0].strategyMatchCount >= 5);
  assert.equal(rows[0].strategyAxisCount, 6);
  assert.equal(rows[0].strategyHasLeaderAxis, true);
  assert.equal(rows[0].strategyHasRsAxis, true);
  assert.equal(rows[0].strategyHasTimingAxis, true);
  assert.equal(rows[0].strategyHasEntryAxis, true);
  assert.equal(rows[0].strategyHasReboundAxis, true);
  assert.equal(rows[0].strategyHasConfirmAxis, true);
  assert.equal(rows[0].actionable, true);
});

test("consensus cohort selectors consume the same annotated counts and never add themselves to the count", () => {
  const rows = [matrixRow("000001", 95)];
  annotateConsensusRows(rows);
  const row = rows[0];
  const before = row.strategyMatchCount;

  const expectedPassing = [
    "CONSENSUS_STRATEGY_5_PLUS",
    "CONSENSUS_AXIS_4_PLUS",
    "CONSENSUS_5S_3A",
    "CONSENSUS_5S_4A",
    "CONSENSUS_4A_LEADER_RS",
    "CONSENSUS_4A_ACTIONABLE",
    "CONSENSUS_5S_3A_ACTIONABLE"
  ];
  for (const id of expectedPassing) {
    const strategy = CONSENSUS_STRATEGIES.find((item) => item.id === id);
    assert.ok(strategy, `${id} missing`);
    assert.equal(strategy.selector(row), true, `${id} should pass`);
  }
  assert.equal(row.strategyMatchCount, before);
});

test("historical actionable annotation follows the live simulator hard blocks", () => {
  const rows = [
    matrixRow("000001", 95, { I: true }),
    matrixRow("000002", 90, { overheat: true, leaderRank: 2, combinedRank: 2, rankingV2Rank: 2, scoutRank: 2 }),
    matrixRow("000003", 85, { R: false, F: false, F2: false, B: true, liquidityScore: 55, leaderRank: 3, combinedRank: 3, rankingV2Rank: 3, scoutRank: 3 })
  ];
  annotateConsensusRows(rows);
  assert.equal(rows[0].actionable, false);
  assert.equal(rows[1].actionable, false);
  assert.equal(rows[2].actionable, true);
});
