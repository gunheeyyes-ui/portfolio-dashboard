import assert from "node:assert/strict";
import test from "node:test";

import { buildSimulationV2ServerModel, marketRegimeForDate, simulatePortfolio } from "./simulation-v2-service.js";

function frozen() {
  return {
    version: "test-v1",
    strategyCount: 7,
    axisCount: 4,
    strategyIds: ["S1", "S2", "S3", "S4", "S5", "S6", "S7"],
    strategyNames: ["전략1", "전략2", "전략3", "전략4", "전략5", "전략6", "전략7"],
    axisIds: ["leader", "rs", "timing", "entry"],
    axisLabels: ["주도", "RS", "타이밍", "진입"]
  };
}

function record(code, overrides = {}) {
  return {
    signalDate: "2026-08-20",
    market: "KOSPI",
    code,
    name: `테스트${code}`,
    signalPrice: 10_000,
    entryDate: "20260821",
    entryOpen: 10_200,
    entryGapPct: 2,
    entryDayOutcome: {
      targetTradingDate: "20260821",
      exitPrice: 10_300,
      netReturnPct: 0.75,
      mfePct: 2.5,
      maePct: -1.2,
      excessReturnPct: 0.2
    },
    outcomes: {
      "1": { targetTradingDate: "20260824", netReturnPct: 1.2, mfePct: 3, maePct: -1, excessReturnPct: 0.5 },
      "3": { targetTradingDate: "20260826", netReturnPct: 2.2, mfePct: 4, maePct: -1.5, excessReturnPct: 1.0 },
      "5": { targetTradingDate: "20260828", netReturnPct: 5, mfePct: 8, maePct: -2, excessReturnPct: 3 },
      "10": { targetTradingDate: "20260904", netReturnPct: 7, mfePct: 10, maePct: -3, excessReturnPct: 4 },
      "20": { targetTradingDate: "20260918", netReturnPct: 9, mfePct: 14, maePct: -4, excessReturnPct: 5 }
    },
    live: { currentReturnPct: 5, tradingDaysElapsed: 5 },
    status: "COMPLETE",
    frozenConsensus: frozen(),
    factors: { leaderRank: 3, rs20: 95 },
    universeMeta: { version: "screener-v1-mcap100-vol30" },
    ...overrides
  };
}

function selection(strategyId, members, signalDate = "2026-08-20", market = "KOSPI") {
  return { signalDate, market, strategyId, members: members.map((code) => ({ code })) };
}

function indexData() {
  const rows = [];
  const start = new Date("2026-07-20T00:00:00Z");
  for (let index = 0; index < 60; index += 1) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    if ([0, 6].includes(date.getUTCDay())) continue;
    const close = 1000 + rows.length * 5;
    rows.push({
      date: date.toISOString().slice(0, 10).replace(/-/g, ""),
      open: close - 1,
      high: close + 5,
      low: close - 5,
      close,
      volume: 1_000_000
    });
  }
  return { updatedAt: "2026-09-20T00:00:00Z", markets: { KOSPI: rows, KOSDAQ: rows } };
}

test("Simulation V2 server uses all stored OOS rows and reconstructs exact cohorts", () => {
  const records = [record("000001"), record("000002", { market: "KOSDAQ" })];
  const selections = [
    selection("ACTIONABLE_ALL", ["000001"]),
    selection("LEADER_TOP10", ["000001"]),
    selection("CONSENSUS_5S_3A", ["000001"]),
    selection("LEADER_A_AND_RS80", ["000001"]),
    selection("CONSENSUS_AXIS_3_PLUS", ["000001"]),
    selection("ACTIONABLE_ALL", ["000002"], "2026-08-20", "KOSDAQ"),
    selection("LEADER_A_AND_RS80", ["000002"], "2026-08-20", "KOSDAQ"),
    selection("CONSENSUS_AXIS_3_PLUS", ["000002"], "2026-08-20", "KOSDAQ")
  ];
  const model = buildSimulationV2ServerModel({ records, selections, indexData: indexData(), limit: 1 });
  assert.equal(model.meta.totalCandidateRows, 2);
  assert.equal(model.rows.length, 1, "only response rows are paginated");
  assert.equal(model.cohorts.actual.trades, 2, "aggregate still uses full history");
  assert.equal(model.cohorts.core.trades, 1);
  assert.equal(model.cohorts.strong.trades, 2);
  const first = model.rows[0];
  assert.equal(first.frozenConsensus.source, "frozen");
  assert.equal(first.strategyCount, 7);
});

test("0D, index excess, gap and cost stress are exposed without changing base net return", () => {
  const records = [record("000001")];
  const selections = [
    selection("ACTIONABLE_ALL", ["000001"]),
    selection("LEADER_TOP10", ["000001"]),
    selection("CONSENSUS_5S_3A", ["000001"]),
    selection("LEADER_A_AND_RS80", ["000001"]),
    selection("CONSENSUS_AXIS_3_PLUS", ["000001"])
  ];
  const model = buildSimulationV2ServerModel({ records, selections, indexData: indexData() });
  const row = model.rows[0];
  assert.equal(row.outcomesV2["0"].netReturnPct, 0.75);
  assert.equal(row.entryGapPct, 2);
  assert.equal(row.outcomesV2["5"].stress["0.2"], 4.8);
  assert.equal(row.outcomesV2["5"].stress["0.5"], 4.5);
  assert.ok(Number.isFinite(row.outcomesV2["5"].indexReturnPct));
  assert.ok(Number.isFinite(row.outcomesV2["5"].indexExcessReturnPct));
  assert.equal(row.outcomes["5"].netReturnPct, 5, "stored OOS result is untouched");
});

test("daily baskets are counted separately from stock trades", () => {
  const records = [
    record("000001"),
    record("000002", { outcomes: { ...record("x").outcomes, "5": { targetTradingDate: "20260828", netReturnPct: -1, mfePct: 2, maePct: -4, excessReturnPct: -2 } } })
  ];
  const selections = [selection("ACTIONABLE_ALL", ["000001", "000002"])];
  const model = buildSimulationV2ServerModel({ records, selections, indexData: indexData() });
  assert.equal(model.cohorts.actual.horizons["5"].trades.n, 2);
  assert.equal(model.cohorts.actual.horizons["5"].signalDays.n, 1);
  assert.equal(model.cohorts.actual.horizons["5"].signalDays.avgReturnPct, 2);
});

test("portfolio simulation rejects duplicate signals and respects position capacity", () => {
  const base = record("000001");
  const duplicate = record("000001", { signalDate: "2026-08-21", entryDate: "20260824", outcomes: { ...base.outcomes, "10": { targetTradingDate: "20260907", netReturnPct: 4 } } });
  const second = record("000002", { signalDate: "2026-08-21", entryDate: "20260824", outcomes: { ...base.outcomes, "10": { targetTradingDate: "20260907", netReturnPct: 3 } } });
  const rows = [base, duplicate, second].map((row) => ({ ...row, actual: true, outcomesV2: row.outcomes }));
  const portfolio = simulatePortfolio(rows, { cohortId: "actual", horizon: 10, maxPositions: 1, initialCapital: 100_000_000 });
  assert.equal(portfolio.completedTrades, 1);
  assert.ok(portfolio.skippedDuplicate + portfolio.skippedCapacity >= 1);
  assert.ok(Number.isFinite(portfolio.totalReturnPct));
  assert.ok(Number.isFinite(portfolio.realizedMaxDrawdownPct));
});

test("market regime and health diagnostics are deterministic", () => {
  const data = indexData();
  const regime = marketRegimeForDate("KOSPI", "2026-08-20", data);
  assert.ok(["bull", "neutral", "bear", "high-vol"].includes(regime.key));
  const records = [record("000001")];
  const selections = [selection("ACTIONABLE_ALL", ["000001"])];
  const model = buildSimulationV2ServerModel({
    records,
    selections,
    invalidLines: 1,
    state: { missingSnapshotDates: ["2026-08-19"], lastSnapshotAt: "2026-08-20T07:00:00Z" },
    indexData: data
  });
  assert.equal(model.health.status, "warn");
  assert.deepEqual(model.health.missingSnapshotDates, ["2026-08-19"]);
  assert.equal(model.health.frozenConsensusCoveragePct, 100);
  assert.equal(model.health.entryDayCoveragePct, 100);
});
