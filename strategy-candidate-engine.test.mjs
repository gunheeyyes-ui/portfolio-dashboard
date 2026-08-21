import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  BASE_STRATEGY_REGISTRY,
  CONSENSUS_DEFINITION_VERSION,
  STRATEGY_DEFINITION_VERSION,
  STRATEGY_OOS_SCHEMA,
  STRATEGY_REGISTRY_HASH,
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
import {
  buildFeatureRows,
  buildSelections
} from "./strategy-oos-tracker.js";

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
    }
  };
}

function canonicalGitBlobSha1(content) {
  const normalized = String(content).replace(/\r\n/g, "\n");
  const body = Buffer.from(normalized, "utf8");
  return createHash("sha1")
    .update(`blob ${body.length}\0`)
    .update(body)
    .digest("hex");
}

test("browser candidate registry stays at the exact 94 base strategies while Node OOS adds consensus cohorts", () => {
  assert.strictEqual(BASE_STRATEGY_REGISTRY, browserRegistry);
  assert.equal(browserRegistry.length, 94);
  assert.equal(rootRegistry.length, 107);
  assert.equal(strategyCatalogInfo().featuredCount, 14);
  assert.equal(strategyCatalogInfo().allCount, 94);
  assert.equal(strategyById("CONSENSUS_5S_3A")?.group, "consensus");
});

test("OOS schema locks base registry plus consensus-definition version", () => {
  const registryText = readFileSync(new URL("./public/strategy-oos-registry.js", import.meta.url), "utf8");
  assert.equal(STRATEGY_DEFINITION_VERSION, 2);
  assert.equal(CONSENSUS_DEFINITION_VERSION, 1);
  assert.equal(STRATEGY_REGISTRY_HASH, canonicalGitBlobSha1(registryText));
  assert.equal(
    STRATEGY_OOS_SCHEMA,
    `strategy-oos-1-def${STRATEGY_DEFINITION_VERSION}-${STRATEGY_REGISTRY_HASH.slice(0, 12)}-cons${CONSENSUS_DEFINITION_VERSION}`
  );
});

test("nested ranking strategies count separately but collapse to one independent axis", () => {
  const axes = axesForMatches([
    strategyById("LEADER_TOP3"),
    strategyById("LEADER_TOP10")
  ]);
  assert.deepEqual(axes.map((axis) => axis.id), ["leader"]);
});

test("a stock matching all featured dimensions reports 14 base strategies across 6 independent axes", () => {
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

test("candidate panel and OOS tracker keep identical membership for all 94 base strategies", () => {
  const payload = {
    rows: {
      KOSPI: [strongRow("000001"), strongRow("000002", 2)],
      KOSDAQ: [strongRow("100001")]
    },
    errors: []
  };

  const candidates = buildStrategyCandidates(payload);
  const features = buildFeatureRows(payload, { failedCodes: new Set() });
  const selections = buildSelections(features, {
    signalDate: "2026-08-21",
    recordedAt: "2026-08-21T15:50:00+09:00"
  });
  const baseIds = new Set(browserRegistry.map((strategy) => strategy.id));
  const baseSelections = selections.filter((selection) => baseIds.has(selection.strategyId));

  assert.equal(new Set(selections.map((selection) => selection.strategyId)).size, 107);
  assert.equal(new Set(baseSelections.map((selection) => selection.strategyId)).size, 94);

  for (const selection of baseSelections) {
    const expected = selection.members.map((member) => member.code).sort();
    const actual = candidates
      .filter((item) => item.feature.market === selection.market)
      .filter((item) => item.matches.some((strategy) => strategy.id === selection.strategyId))
      .map((item) => item.feature.code)
      .sort();
    assert.deepEqual(
      actual,
      expected,
      `${selection.market} ${selection.strategyId} candidate/OOS membership drifted`
    );
  }
});

test("consensus OOS cohorts are derived from base matches and do not inflate browser counts", () => {
  const payload = {
    rows: {
      KOSPI: [strongRow("000001")],
      KOSDAQ: []
    },
    errors: []
  };
  const candidates = buildStrategyCandidates(payload);
  const features = buildFeatureRows(payload, { failedCodes: new Set() });
  const selections = buildSelections(features, {
    signalDate: "2026-08-21",
    recordedAt: "2026-08-21T15:50:00+09:00"
  });

  assert.equal(candidates[0].matches.some((strategy) => strategy.id.startsWith("CONSENSUS_")), false);
  for (const id of ["CONSENSUS_5S_3A", "CONSENSUS_5S_4A", "CONSENSUS_4A_LEADER_RS", "CONSENSUS_4A_ACTIONABLE", "CONSENSUS_5S_3A_ACTIONABLE"]) {
    const selection = selections.find((row) => row.strategyId === id && row.market === "KOSPI");
    assert.ok(selection, `${id} selection missing`);
    assert.deepEqual(selection.members.map((member) => member.code), ["000001"]);
  }
});
