import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStrategyOosTracker } from "./strategy-oos-tracker.js";

test("complete legacy rows persist the new 0D universe benchmark without fetching price history", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sim-v2-entryday-upgrade-"));
  const historyFile = path.join(dir, "history.jsonl");
  const selectionFile = path.join(dir, "selections.jsonl");
  const summaryFile = path.join(dir, "summary.json");
  const stateFile = path.join(dir, "state.json");
  const outcomes = Object.fromEntries([1, 3, 5, 10, 20].map((horizon) => [String(horizon), {
    targetTradingDate: `202608${String(21 + Math.min(horizon, 7)).padStart(2, "0")}`,
    netReturnPct: horizon / 10,
    benchmarkReturnPct: 0,
    excessReturnPct: horizon / 10
  }]));
  const record = {
    schemaVersion: "test",
    signalDate: "2026-08-20",
    recordedAt: "2026-08-20T07:00:00Z",
    market: "KOSPI",
    code: "000001",
    name: "테스트",
    signalPrice: 100,
    entryDate: "20260821",
    entryOpen: 101,
    entryGapPct: 1,
    entryDayOutcome: {
      targetTradingDate: "20260821",
      netReturnPct: 2,
      benchmarkReturnPct: null,
      excessReturnPct: null
    },
    outcomes,
    live: null,
    status: "COMPLETE",
    frozenConsensus: {
      version: "test",
      strategyCount: 0,
      axisCount: 0,
      strategyIds: [],
      strategyNames: [],
      axisIds: [],
      axisLabels: []
    }
  };
  writeFileSync(historyFile, `${JSON.stringify(record)}\n`, "utf8");
  writeFileSync(selectionFile, "", "utf8");

  const tracker = createStrategyOosTracker({
    historyFile,
    selectionFile,
    summaryFile,
    stateFile,
    now: () => new Date("2026-08-30T07:00:00Z")
  });
  const result = await tracker.evaluatePending(async () => {
    throw new Error("price history must not be fetched for a local benchmark upgrade");
  });

  assert.equal(result.entryDayBenchmarkUpgraded, 1);
  assert.ok(result.updated >= 1);
  const saved = JSON.parse(readFileSync(historyFile, "utf8").trim());
  assert.equal(saved.entryDayOutcome.benchmarkReturnPct, 2);
  assert.equal(saved.entryDayOutcome.excessReturnPct, 0);
});
