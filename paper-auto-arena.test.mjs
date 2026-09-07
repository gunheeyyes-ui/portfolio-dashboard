import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPaperAutoArena,
  PAPER_AUTO_ACCOUNTS,
  PAPER_AUTO_ARENA_POLICY
} from "./paper-auto-arena.js";

function record({ signalDate = "2026-09-07", code, leaderRank = 20, leaderGrade = "B", rs20 = 50, strategyCount = 2, axisCount = 2, liquidityScore = 60, factors = {}, outcome = null }) {
  return {
    signalDate,
    market: "KOSPI",
    code,
    name: `종목${code}`,
    signalPrice: 10_000,
    entryDate: signalDate === "2026-09-07" ? "20260908" : "20260905",
    entryOpen: 10_000,
    factors: {
      leaderRank,
      leaderGrade,
      rs20,
      liquidityScore,
      combinedTier: 2,
      combinedScore: 70,
      riskScore: 30,
      stabilizeScore: 70,
      flags: {},
      cafe: false,
      mtt: false,
      leaderRebound: false,
      deepRecovery: false,
      ...factors
    },
    frozenConsensus: { strategyCount, axisCount },
    outcomes: outcome ? { "3": outcome } : {},
    live: null
  };
}

function selection(strategyId, members, signalDate = "2026-09-07") {
  return {
    signalDate,
    market: "KOSPI",
    strategyId,
    members: members.map((member, index) => typeof member === "string" ? { code: member, rank: index + 1 } : member)
  };
}

test("Shadow Auto Arena V2 runs ten isolated forward-only accounts", () => {
  const outcome = { targetTradingDate: "20260911", exitPrice: 11_000, netReturnPct: 9.77 };
  const records = [
    record({ signalDate: "2026-09-04", code: "000000", leaderRank: 1, leaderGrade: "A", rs20: 99, strategyCount: 9, axisCount: 5, outcome }),
    record({ code: "000001", leaderRank: 5, leaderGrade: "A", rs20: 90, strategyCount: 6, axisCount: 3, liquidityScore: 80, outcome }),
    record({ code: "000002", leaderRank: 15, leaderGrade: "A", rs20: 85, strategyCount: 4, axisCount: 3, liquidityScore: 50, outcome }),
    record({ code: "000003", leaderRank: 30, leaderGrade: "B", rs20: 60, strategyCount: 1, axisCount: 1, liquidityScore: 20, factors: { cafe: true }, outcome })
  ];
  const selections = [
    selection("ACTIONABLE_ALL", ["000001"]),
    selection("TIMING_TOP10", ["000001", "000002"]),
    selection("RANKING_V2_TOP10", ["000001"]),
    selection("LEADER_TOP10", ["000001"]),
    selection("SCOUT_TOP10", ["000002"]),
    selection("CAFE", ["000003"]),
    selection("MTT", [])
  ];

  const arena = buildPaperAutoArena({ records, selections });
  assert.equal(arena.schemaVersion, "paper-auto-arena-v2");
  assert.equal(arena.accounts.length, PAPER_AUTO_ACCOUNTS.length);
  assert.equal(arena.accounts.length, 10);
  assert.equal(arena.arenaPolicy.id, PAPER_AUTO_ARENA_POLICY.id);
  assert.equal(arena.diagnostics.realOrderApiUsed, false);
  assert.equal(arena.diagnostics.aiAffectsOrders, false);

  const byId = Object.fromEntries(arena.accounts.map((account) => [account.id, account]));
  assert.equal(byId.actual.summary.signalCount, 1);
  assert.equal(byId.core.summary.signalCount, 1);
  assert.equal(byId.strong.summary.signalCount, 1);
  assert.equal(byId.strategy.summary.signalCount, 1);
  assert.equal(byId.cafe.summary.signalCount, 1);
  assert.equal(byId.mtt.summary.signalCount, 0);
  assert.equal(byId.core.closed[0].executionSlippagePct, 0.1);
  assert.equal(byId.strong.closed[0].executionSlippagePct, 0.2);
  assert.equal(byId.strategy.closed[0].executionSlippagePct, 0.35);
  assert.equal(byId.core.closed[0].paperReturnPct, 9.67);
  assert.equal(byId.core.closed[0].quantity, 999);
  assert.equal(byId.core.diagnostics.noBackfillBefore, "2026-09-07");
});

test("core and strong paper cohorts mirror the home candidate definitions without overlap", () => {
  const records = [
    record({ code: "100001", leaderRank: 3, leaderGrade: "A", rs20: 95, strategyCount: 7, axisCount: 4 }),
    record({ code: "100002", leaderRank: 18, leaderGrade: "A", rs20: 88, strategyCount: 4, axisCount: 3 }),
    record({ code: "100003", leaderRank: 8, leaderGrade: "B", rs20: 50, strategyCount: 6, axisCount: 3 })
  ];
  const arena = buildPaperAutoArena({ records, selections: [] });
  const core = arena.accounts.find((account) => account.id === "core");
  const strong = arena.accounts.find((account) => account.id === "strong");
  assert.equal(core.summary.signalCount, 2);
  assert.equal(strong.summary.signalCount, 1);
  assert.equal(strong.queued.some((row) => row.code === "100001"), false);
});
