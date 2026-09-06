import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAiReviewStore } from "./ai-review-store.js";

test("AI history is separate and immutable per signalDate/code", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-review-store-"));
  const store = createAiReviewStore({ dataDir: dir });
  const batch = {
    signalDate: "2026-09-07",
    createdAt: "2026-09-07T07:00:00Z",
    model: "gpt-5.6-luna",
    inputHash: "abc",
    recordEligible: true,
    candidateByCode: {
      "000001": { name: "테스트", market: "KOSPI", candidateLabel: "core" }
    },
    reviews: [{
      code: "000001",
      verdict: "POSITIVE",
      confidence: 80,
      bull_case: "bull",
      bear_case: "bear",
      key_risks: ["risk"],
      invalidation: "inv",
      summary: "sum"
    }]
  };
  assert.equal(store.recordBatchOnce(batch).recorded, true);
  assert.equal(store.recordBatchOnce(batch).recorded, false);
  const lines = readFileSync(store.paths.historyFile, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
});

test("summary joins existing strategy OOS outcomes without mutating them", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-review-summary-"));
  const store = createAiReviewStore({ dataDir: dir });
  store.recordBatchOnce({
    signalDate: "2026-09-07",
    createdAt: "2026-09-07T07:00:00Z",
    model: "gpt-5.6-luna",
    inputHash: "abc",
    recordEligible: true,
    candidateByCode: { "000001": { name: "테스트", market: "KOSPI", candidateLabel: "core" } },
    reviews: [{ code: "000001", verdict: "POSITIVE", confidence: 80, bull_case: "b", bear_case: "x", key_risks: [], invalidation: "i", summary: "s" }]
  });
  const original = JSON.stringify({
    signalDate: "2026-09-07",
    code: "000001",
    outcomes: {
      "3": { netReturnPct: 2 },
      "5": { netReturnPct: -1 },
      "10": { netReturnPct: 4 }
    }
  });
  writeFileSync(store.paths.strategyHistoryFile, `${original}\n`, "utf8");
  const before = readFileSync(store.paths.strategyHistoryFile, "utf8");
  const summary = store.buildSummary();
  const after = readFileSync(store.paths.strategyHistoryFile, "utf8");
  assert.equal(before, after);
  assert.equal(summary.groups.core_positive.horizons["3"].avgReturnPct, 2);
  assert.equal(summary.groups.core_positive.horizons["5"].avgReturnPct, -1);
  assert.equal(summary.groups.core_positive.horizons["10"].avgReturnPct, 4);
});
