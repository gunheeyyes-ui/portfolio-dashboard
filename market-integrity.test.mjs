import assert from "node:assert/strict";
import test from "node:test";

import { buildMarketStatusFromKisQuote, buildMarketStatusMap, classifyOutcomeIntegrity } from "./market-integrity.js";
import { buildPaperAutoIntegrityArena } from "./paper-auto-integrity-arena.js";
import { buildSimulationIntegrityModel } from "./simulation-integrity-service.js";

function record({ code = "000001", outcome3 = null, outcome10 = null }) {
  return {
    signalDate: "2026-09-07",
    market: "KOSPI",
    code,
    name: `종목${code}`,
    signalPrice: 10_000,
    entryDate: "20260908",
    entryOpen: 10_000,
    factors: {
      leaderRank: 5,
      leaderGrade: "A",
      rs20: 90,
      liquidityScore: 80,
      combinedTier: 2,
      combinedScore: 70,
      riskScore: 30,
      stabilizeScore: 70,
      flags: {}, cafe: false, mtt: false, leaderRebound: false, deepRecovery: false
    },
    frozenConsensus: { strategyCount: 6, axisCount: 3 },
    entryDayOutcome: null,
    outcomes: {
      ...(outcome3 ? { "3": outcome3 } : {}),
      ...(outcome10 ? { "10": outcome10 } : {})
    },
    live: null,
    status: "PENDING"
  };
}

function selection(strategyId, code = "000001") {
  return { signalDate: "2026-09-07", market: "KOSPI", strategyId, members: [{ code, rank: 1 }] };
}

test("KIS special-market flags block only hard pre-entry statuses", () => {
  const status = buildMarketStatusFromKisQuote({
    sltr_yn: "Y",
    temp_stop_yn: "N",
    mang_issu_cls_code: "00",
    invt_caful_yn: "N",
    mrkt_warn_cls_code: "02",
    short_over_yn: "Y",
    stck_sdpr: "10000",
    stck_prdy_clpr: "10000"
  }, { signalDate: "2026-09-07", market: "KOSPI", code: "000001", phase: "EOD_PREENTRY" });
  assert.equal(status.blockEntry, true);
  assert.deepEqual(status.blockReasons, ["LIQUIDATION_TRADING"]);
  assert.deepEqual(status.riskFlags, ["MARKET_WARNING", "SHORT_TERM_OVERHEAT"]);
});

test("hard future discontinuity never leaks backward into an earlier horizon", () => {
  const row = record({
    outcome3: { targetTradingDate: "20260911", exitPrice: 10_200, grossReturnPct: 2, netReturnPct: 1.77 },
    outcome10: { targetTradingDate: "20260922", exitPrice: 500, grossReturnPct: -95, netReturnPct: -95.23 }
  });
  assert.equal(classifyOutcomeIntegrity(row, 3).comparable, true);
  const ten = classifyOutcomeIntegrity(row, 10);
  assert.equal(ten.comparable, false);
  assert(ten.reasons.includes("HARD_PRICE_DISCONTINUITY"));
});

test("Shadow Auto blocks known special-market status before next-open entry", () => {
  const row = record({ outcome3: { targetTradingDate: "20260911", exitPrice: 11_000, grossReturnPct: 10, netReturnPct: 9.77 } });
  const statuses = [{
    schemaVersion: "market-integrity-status-v1",
    signalDate: "2026-09-07", market: "KOSPI", code: "000001", name: row.name,
    checkedAt: "2026-09-07T07:00:00.000Z", phase: "EOD_PREENTRY",
    blockEntry: true, blockReasons: ["LIQUIDATION_TRADING"], flags: { liquidationTrading: true }
  }];
  const arena = buildPaperAutoIntegrityArena({ records: [row], selections: [selection("ACTIONABLE_ALL")], marketStatuses: statuses });
  const actual = arena.accounts.find((account) => account.id === "actual");
  assert.equal(actual.summary.signalCountBeforeIntegrity, 1);
  assert.equal(actual.summary.signalCount, 0);
  assert.equal(actual.summary.marketStatusBlockedOrders, 1);
  assert.equal(actual.blocked[0].code, "000001");
});

test("Simulation integrity preserves raw loss while quarantining a corporate-action-like discontinuity", () => {
  const bad = record({ outcome3: { targetTradingDate: "20260911", exitPrice: 50, grossReturnPct: -99.5, netReturnPct: -99.73 } });
  const good = record({ code: "000002", outcome3: { targetTradingDate: "20260911", exitPrice: 10_500, grossReturnPct: 5, netReturnPct: 4.77 } });
  const model = buildSimulationIntegrityModel({
    records: [bad, good],
    selections: [selection("ACTIONABLE_ALL", "000001"), selection("ACTIONABLE_ALL", "000002")]
  });
  const h3 = model.cohorts.actual.horizons["3"];
  assert.equal(h3.raw.n, 2);
  assert.equal(h3.comparable.n, 1);
  assert.equal(h3.quarantined, 1);
  assert.equal(h3.comparable.avgReturnPct, 4.77);
  assert(model.quarantinedRecent.some((row) => row.code === "000001"));
});

test("status map keeps the latest pre-entry snapshot for a signal key", () => {
  const rows = [
    { signalDate: "2026-09-07", market: "KOSPI", code: "000001", checkedAt: "2026-09-07T06:30:00Z", blockEntry: false },
    { signalDate: "2026-09-07", market: "KOSPI", code: "000001", checkedAt: "2026-09-07T07:00:00Z", blockEntry: true, blockReasons: ["MANAGED_ISSUE"] }
  ];
  const map = buildMarketStatusMap(rows);
  assert.equal(map.get("2026-09-07|KOSPI|000001").blockEntry, true);
});
