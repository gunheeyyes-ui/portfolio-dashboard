import assert from "node:assert/strict";
import test from "node:test";

import { buildPaperAutoModel, PAPER_AUTO_POLICY, resolvePaperExit } from "./paper-auto-service.js";
import { buildPaperAutoArena, PAPER_AUTO_ACCOUNTS, PAPER_AUTO_EXIT_VARIANTS } from "./paper-auto-arena.js";

const STOP_TAKE_POLICY = {
  ...PAPER_AUTO_POLICY,
  sourceStrategyId: "TEST",
  exitMode: "stop-take",
  stopLossPct: -5,
  takeProfitPct: 8,
  sameWindowTieBreak: "stop-first",
  holdTradingDays: 3,
  trackerRoundTripCostPct: 0.23,
  extraExecutionSlippagePct: 0.20
};

function row(overrides = {}) {
  return {
    signalDate: "2026-09-07",
    market: "KOSPI",
    code: "000001",
    name: "테스트",
    signalPrice: 10_000,
    entryDate: "20260908",
    entryOpen: 10_000,
    factors: { liquidityScore: 60, leaderRank: 5, leaderGrade: "A", rs20: 90 },
    frozenConsensus: { strategyCount: 6, axisCount: 3 },
    entryDayOutcome: { targetTradingDate: "20260908", mfePct: 3, maePct: -2 },
    outcomes: {
      "1": { targetTradingDate: "20260909", exitPrice: 10_300, grossReturnPct: 3, netReturnPct: 2.77, mfePct: 4, maePct: -2 },
      "3": { targetTradingDate: "20260911", exitPrice: 10_500, grossReturnPct: 5, netReturnPct: 4.77, mfePct: 9, maePct: -4 }
    },
    live: null,
    ...overrides
  };
}

function selection(code = "000001") {
  return [{ signalDate: "2026-09-07", market: "KOSPI", strategyId: "TEST", members: [{ code, rank: 1 }] }];
}

test("SL5/TP8 takes profit at the earliest stored OOS window that proves the threshold", () => {
  const exit = resolvePaperExit(row(), STOP_TAKE_POLICY);
  assert.equal(exit.reason, "TAKE_PROFIT");
  assert.equal(exit.targetTradingDate, "20260911");
  assert.equal(exit.grossReturnPct, 8);
  assert.equal(exit.sourceNetReturnPct, 7.77);
  assert.equal(exit.exitPrice, 10_800);
});

test("SL5/TP8 uses stop-first when both thresholds occur inside the same stored window", () => {
  const exit = resolvePaperExit(row({
    entryDayOutcome: { targetTradingDate: "20260908", mfePct: 9, maePct: -6 }
  }), STOP_TAKE_POLICY);
  assert.equal(exit.reason, "STOP_LOSS_AMBIGUOUS");
  assert.equal(exit.targetTradingDate, "20260908");
  assert.equal(exit.grossReturnPct, -5);
  assert.equal(exit.sourceNetReturnPct, -5.23);
  assert.equal(exit.ambiguousBothHit, true);
});

test("earlier take-profit evidence wins over a later stop because OOS windows are processed in time order", () => {
  const exit = resolvePaperExit(row({
    outcomes: {
      "1": { targetTradingDate: "20260909", mfePct: 8.4, maePct: -2, netReturnPct: 1 },
      "3": { targetTradingDate: "20260911", mfePct: 10, maePct: -7, netReturnPct: -1 }
    }
  }), STOP_TAKE_POLICY);
  assert.equal(exit.reason, "TAKE_PROFIT");
  assert.equal(exit.targetTradingDate, "20260909");
});

test("paper portfolio applies threshold return, transaction cost and execution slippage", () => {
  const model = buildPaperAutoModel({ records: [row()], selections: selection(), policy: STOP_TAKE_POLICY });
  assert.equal(model.closed.length, 1);
  assert.equal(model.closed[0].exitReason, "TAKE_PROFIT");
  assert.equal(model.closed[0].sourceNetReturnPct, 7.77);
  assert.equal(model.closed[0].paperReturnPct, 7.57);
  assert.equal(model.summary.takeProfitExits, 1);
  assert.equal(model.summary.stopLossExits, 0);
});

test("arena preserves the original ten 3D accounts and adds ten isolated SL5/TP8 comparison accounts", () => {
  const arena = buildPaperAutoArena({ records: [], selections: [] });
  assert.equal(arena.accounts.length, PAPER_AUTO_ACCOUNTS.length);
  assert.equal(arena.accounts.length, 10);
  assert.equal(PAPER_AUTO_EXIT_VARIANTS.length, 2);
  assert.equal(arena.comparisonAccounts.length, 20);
  assert.equal(arena.diagnostics.comparisonAccountCount, 20);
  const fixed = arena.comparisonAccounts.find((account) => account.id === "core");
  const stopTake = arena.comparisonAccounts.find((account) => account.id === "core-sl5tp8");
  assert.equal(fixed.exitVariant, "fixed3d");
  assert.equal(stopTake.exitVariant, "sl5tp8");
  assert.equal(stopTake.policy.stopLossPct, -5);
  assert.equal(stopTake.policy.takeProfitPct, 8);
});
