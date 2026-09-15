import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { quarantineIncompleteOosDate } from "./deploy/cloud/oos-quality-cleanup.mjs";

function writeJsonl(filePath, rows) {
  writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

function readJsonl(filePath) {
  return readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function fixtureState(kospi = 29, kosdaq = 30) {
  return {
    schemaVersion: "strategy-oos-v1",
    recordedDates: ["2026-09-14", "2026-09-15"],
    lastSnapshotAt: "2026-09-15T07:51:32.763Z",
    lastEvaluatedAt: "2026-09-15T07:53:10.969Z",
    skipped: [],
    diagnostics: {
      "2026-09-14": { recordedAt: "2026-09-14T07:51:00.000Z", marketCounts: { KOSPI: 100, KOSDAQ: 100 } },
      "2026-09-15": { recordedAt: "2026-09-15T07:51:32.763Z", marketCounts: { KOSPI: kospi, KOSDAQ: kosdaq } }
    }
  };
}

function setup(kospi = 29, kosdaq = 30) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "oos-quality-cleanup-"));
  writeJsonl(path.join(dir, "strategy-oos-history.jsonl"), [
    { signalDate: "2026-09-14", recordedAt: "2026-09-14T07:51:00.000Z", market: "KOSPI", code: "005930", outcomes: {}, status: "PENDING" },
    { signalDate: "2026-09-15", recordedAt: "2026-09-15T07:51:32.763Z", market: "KOSPI", code: "000001", outcomes: {}, status: "PENDING" }
  ]);
  writeJsonl(path.join(dir, "strategy-oos-selections.jsonl"), [
    { signalDate: "2026-09-14", market: "KOSPI", strategyId: "ACTIONABLE_ALL", members: [], validCount: 0, targetCount: 0 },
    { signalDate: "2026-09-15", market: "KOSPI", strategyId: "ACTIONABLE_ALL", members: [{ code: "000001", name: "partial" }], validCount: 1, targetCount: 1 }
  ]);
  writeJsonl(path.join(dir, "ranking-live-history.jsonl"), [
    { signalDate: "2026-09-14", market: "KOSPI", ticker: "005930", reviewRank: 1, rankingTier: 1 },
    { signalDate: "2026-09-15", market: "KOSPI", ticker: "000001", reviewRank: 1, rankingTier: 1 }
  ]);
  writeFileSync(path.join(dir, "strategy-oos-state.json"), JSON.stringify(fixtureState(kospi, kosdaq)), "utf8");
  writeFileSync(path.join(dir, "strategy-oos-summary.json"), "{}", "utf8");
  writeFileSync(path.join(dir, "ranking-live-summary.json"), "{}", "utf8");
  return dir;
}

test("proven partial 2026-09-15 snapshot is backed up and removed from both OOS trackers", () => {
  const dir = setup();
  try {
    const result = quarantineIncompleteOosDate({
      dataDir: dir,
      targetDate: "2026-09-15",
      minMarketRows: 80,
      now: () => new Date("2026-09-16T00:00:00.000Z")
    });
    assert.equal(result.changed, true);
    assert.deepEqual(result.removed, { strategyRecords: 1, strategySelections: 1, rankingRecords: 1 });
    assert.deepEqual(readJsonl(path.join(dir, "strategy-oos-history.jsonl")).map((row) => row.signalDate), ["2026-09-14"]);
    assert.deepEqual(readJsonl(path.join(dir, "strategy-oos-selections.jsonl")).map((row) => row.signalDate), ["2026-09-14"]);
    assert.deepEqual(readJsonl(path.join(dir, "ranking-live-history.jsonl")).map((row) => row.signalDate), ["2026-09-14"]);

    const state = JSON.parse(readFileSync(path.join(dir, "strategy-oos-state.json"), "utf8"));
    assert.deepEqual(state.recordedDates, ["2026-09-14"]);
    assert.equal(state.diagnostics["2026-09-15"], undefined);
    assert.equal(state.lastSnapshotAt, "2026-09-14T07:51:00.000Z");
    assert.equal(state.skipped.at(-1).reason, "QUARANTINED_INCOMPLETE_MARKET_REFRESH");
    assert.equal(state.quarantinedSnapshots.at(-1).signalDate, "2026-09-15");
    assert.equal(JSON.parse(readFileSync(path.join(dir, "strategy-oos-summary.json"), "utf8")).meta.lastDate, "2026-09-14");
    assert.ok(existsSync(path.join(dir, "oos-quarantine-log.jsonl")));
    assert.equal(readdirSync(path.join(dir, "integrity-backups")).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup refuses to remove a date whose recorded market counts meet the quality gate", () => {
  const dir = setup(100, 100);
  try {
    const before = readFileSync(path.join(dir, "strategy-oos-history.jsonl"), "utf8");
    const result = quarantineIncompleteOosDate({ dataDir: dir, targetDate: "2026-09-15", minMarketRows: 80 });
    assert.equal(result.changed, false);
    assert.equal(result.reason, "SNAPSHOT_QUALITY_OK");
    assert.equal(readFileSync(path.join(dir, "strategy-oos-history.jsonl"), "utf8"), before);
    assert.equal(existsSync(path.join(dir, "integrity-backups")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
