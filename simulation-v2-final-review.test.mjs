import assert from "node:assert/strict";
import test from "node:test";

import { attachBenchmarks } from "./strategy-oos-tracker.js";
import { buildSimulationV2ServerModel, simulatePortfolio } from "./simulation-v2-service.js";

function selection(strategyId, code, signalDate, market = "KOSPI") {
  return { signalDate, market, strategyId, members: [{ code }] };
}

function baseRecord(code, signalDate, net5, overrides = {}) {
  return {
    signalDate,
    market: "KOSPI",
    code,
    name: code,
    signalPrice: 100,
    entryDate: signalDate.replace(/-/g, ""),
    entryOpen: 100,
    entryGapPct: 0,
    entryDayOutcome: { targetTradingDate: signalDate.replace(/-/g, ""), netReturnPct: 0 },
    outcomes: {
      "5": { targetTradingDate: signalDate.replace(/-/g, ""), netReturnPct: net5, mfePct: 2, maePct: -1 }
    },
    live: null,
    status: "COMPLETE",
    frozenConsensus: {
      version: "test",
      strategyCount: 5,
      axisCount: 3,
      strategyIds: [],
      strategyNames: [],
      axisIds: [],
      axisLabels: []
    },
    factors: { leaderRank: 5, rs20: 90 },
    ...overrides
  };
}

test("0D outcomes receive the same same-market universe benchmark convention", () => {
  const records = [
    { signalDate: "2026-08-20", market: "KOSPI", entryDayOutcome: { netReturnPct: 2 }, outcomes: {} },
    { signalDate: "2026-08-20", market: "KOSPI", entryDayOutcome: { netReturnPct: -1 }, outcomes: {} }
  ];
  attachBenchmarks(records, []);
  assert.equal(records[0].entryDayOutcome.benchmarkReturnPct, 0.5);
  assert.equal(records[0].entryDayOutcome.excessReturnPct, 1.5);
  assert.equal(records[1].entryDayOutcome.excessReturnPct, -1.5);
});

test("portfolio simulation skips a new full-weight entry when realized losses leave insufficient cash", () => {
  const rows = [
    {
      code: "A", name: "A", actual: true, strategyCount: 5, axisCount: 3, factors: { leaderRank: 1, rs20: 95 },
      entryDate: "20260101", outcomesV2: { "5": { targetTradingDate: "20260110", netReturnPct: -90 } }
    },
    {
      code: "B", name: "B", actual: true, strategyCount: 5, axisCount: 3, factors: { leaderRank: 2, rs20: 90 },
      entryDate: "20260102", outcomesV2: { "5": { targetTradingDate: "20260120", netReturnPct: 0 } }
    },
    {
      code: "C", name: "C", actual: true, strategyCount: 5, axisCount: 3, factors: { leaderRank: 3, rs20: 85 },
      entryDate: "20260111", outcomesV2: { "5": { targetTradingDate: "20260121", netReturnPct: 10 } }
    }
  ];
  const result = simulatePortfolio(rows, { cohortId: "actual", horizon: 5, initialCapital: 100_000_000, maxPositions: 2 });
  assert.equal(result.completedTrades, 2);
  assert.equal(result.skippedCash, 1);
  assert.equal(result.endingEquity, 55_000_000);
  assert.equal(result.totalReturnPct, -45);
  assert.equal(result.peakPositions, 2);
});

test("health keeps weekday gaps unverified until index calendar coverage exists", () => {
  const record1 = baseRecord("A", "2026-08-18", 1);
  const record2 = baseRecord("B", "2026-08-20", 2);
  const model = buildSimulationV2ServerModel({
    records: [record1, record2],
    selections: [
      selection("ACTIONABLE_ALL", "A", "2026-08-18"),
      selection("ACTIONABLE_ALL", "B", "2026-08-20")
    ],
    state: { missingSnapshotDates: ["2026-08-19"] },
    indexData: { markets: { KOSPI: [], KOSDAQ: [] } }
  });
  assert.equal(model.health.status, "warn");
  assert.deepEqual(model.health.missingSnapshotDates, []);
  assert.deepEqual(model.health.nonTradingNoRecordDates, []);
  assert.deepEqual(model.health.unverifiedNoRecordDates, ["2026-08-19"]);
  assert.equal(model.health.indexBenchmarkReady, false);
});

test("signal-day basket statistics expose a 95 percent mean interval once multiple days exist", () => {
  const records = [
    baseRecord("A", "2026-08-18", 2),
    baseRecord("B", "2026-08-19", 4),
    baseRecord("C", "2026-08-20", -1)
  ];
  const selections = records.map((row) => selection("ACTIONABLE_ALL", row.code, row.signalDate));
  const model = buildSimulationV2ServerModel({ records, selections, indexData: { markets: { KOSPI: [], KOSDAQ: [] } } });
  const days = model.cohorts.actual.horizons["5"].signalDays;
  assert.equal(days.n, 3);
  assert.ok(Number.isFinite(days.stddevPct));
  assert.ok(Number.isFinite(days.ci95LowPct));
  assert.ok(Number.isFinite(days.ci95HighPct));
  assert.equal(days.confidenceLabel, "표본 부족");
  assert.ok(days.ci95LowPct < days.avgReturnPct);
  assert.ok(days.ci95HighPct > days.avgReturnPct);
});
