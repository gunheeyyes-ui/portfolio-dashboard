import test from "node:test";
import assert from "node:assert/strict";

import {
  STRATEGY_REGISTRY as rootRegistry,
  strategyById
} from "./strategy-oos-registry.js";
import {
  STRATEGY_REGISTRY as browserRegistry
} from "./public/strategy-oos-registry.js";
import {
  axesForMatches,
  buildStrategyCandidates,
  strategyCatalogInfo
} from "./public/strategy-candidate-engine.js";

function strongRow(code, marketRank = 1) {
  return {
    code,
    name: `테스트${code}`,
    price: 10000,
    changeRate: 1.2,
    changeRate3d: -1,
    quote: { price: 10000, changeRate: 1.2 },
    leader: {
      score: 92,
      grade: "A",
      rank: marketRank
    },
    combined: {
      score: 88,
      rank: marketRank,
      tier: 4,
      label: "종합 최우선",
      blocked: false,
      gateReason: "PASS"
    },
    scout: {
      rs20: 95,
      reboundRank: marketRank,
      status: "하락 정지 확인",
      drawdownFromHighPct: -25,
      riskScore: 20,
      stabilizeScore: 85
    },
    confirmation: {
      cafePass: true,
      minerviniPass: true,
      leaderReboundPass: true,
      deepRecoveryPass: true,
      reboundState: { key: "ready" }
    },
    supply: {
      liquidityScore: 80,
      foreignStreak: 3,
      instStreak: 2,
      totalNetAmount: 100000000,
      smartMoneyBodyPct: 0.5,
      smartMoneyTradingSharePct: 12
    },
    strategy: {
      overheat: false,
      flags: {
        R: true,
        F: true,
        F2: true,
        B: true,
        C: false,
        H2: false,
        H3: false,
        I: false
      }
    },
    simCategory: {
      key: "split",
      label: "분할 후보",
      actionable: true
    }
  };
}

test("Node and browser use the exact same strategy registry module", () => {
  assert.strictEqual(rootRegistry, browserRegistry);
  assert.equal(rootRegistry.length, 94);
  assert.equal(strategyCatalogInfo().featuredCount, 14);
  assert.equal(strategyCatalogInfo().allCount, 94);
});

test("nested ranking strategies count separately but collapse to one independent axis", () => {
  const axes = axesForMatches([
    strategyById("LEADER_TOP3"),
    strategyById("LEADER_TOP10")
  ]);
  assert.deepEqual(axes.map((axis) => axis.id), ["leader"]);
});

test("a stock matching all featured dimensions reports 14 strategies across 6 independent axes", () => {
  const payload = {
    rows: {
      KOSPI: [strongRow("000001")],
      KOSDAQ: []
    },
    errors: []
  };

  const rows = buildStrategyCandidates(payload);
  assert.equal(rows.length, 1);
  const item = rows[0];
  assert.equal(item.featuredMatches.length, 14);
  assert.deepEqual(
    item.axesFeatured.map((axis) => axis.id),
    ["leader", "rs", "timing", "entry", "rebound", "confirm"]
  );
  assert.ok(item.matches.length >= item.featuredMatches.length);
  assert.equal(item.feature.actionable, true);
});

test("market-screener errors exclude the affected code like the OOS feature builder", () => {
  const payload = {
    rows: {
      KOSPI: [strongRow("000001"), strongRow("000002", 2)],
      KOSDAQ: []
    },
    errors: [{ code: "000001", type: "history", message: "synthetic failure" }]
  };

  const rows = buildStrategyCandidates(payload);
  assert.equal(rows.some((item) => item.feature.code === "000001"), false);
  assert.equal(rows.some((item) => item.feature.code === "000002"), true);
});
