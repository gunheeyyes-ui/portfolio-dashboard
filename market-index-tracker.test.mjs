import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMarketIndexTracker, mergeMarketBars } from "./market-index-tracker.js";

test("market index history merges by date and keeps corrected incoming bars", () => {
  const merged = mergeMarketBars(
    [{ date: "20260820", open: 100, high: 102, low: 99, close: 101 }],
    [
      { date: "20260820", open: 100, high: 103, low: 98, close: 102 },
      { date: "20260821", open: 102, high: 104, low: 101, close: 103 }
    ]
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].close, 102);
  assert.equal(merged[1].date, "20260821");
});

test("market index tracker persists both markets without deleting older history", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "market-index-"));
  const file = path.join(dir, "market-index-history.json");
  const tracker = createMarketIndexTracker({ file });
  tracker.mergeMany({
    KOSPI: [{ date: "20260820", open: 100, high: 102, low: 99, close: 101 }],
    KOSDAQ: [{ date: "20260820", open: 200, high: 202, low: 199, close: 201 }]
  }, { updatedAt: "2026-08-20T07:00:00Z" });
  tracker.mergeMany({
    KOSPI: [{ date: "20260821", open: 101, high: 103, low: 100, close: 102 }]
  }, { updatedAt: "2026-08-21T07:00:00Z" });
  const data = tracker.read();
  assert.equal(data.markets.KOSPI.length, 2);
  assert.equal(data.markets.KOSDAQ.length, 1);
  assert.equal(data.updatedAt, "2026-08-21T07:00:00Z");
  assert.ok(JSON.parse(readFileSync(file, "utf8")).markets.KOSPI.length === 2);
});
