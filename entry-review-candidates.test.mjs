import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildEntryReviewCandidates,
  mergeEntryCandidates
} from "./public/entry-review-candidates.js";

function item({ leaderRank = 5, leaderGrade = "A", rs20 = 90, strategies = 5, axes = 3, code = "000001" } = {}) {
  return {
    row: {
      code,
      name: `테스트${code}`,
      changeRate: 1,
      changeRate3d: 2,
      quote: { price: 10000 }
    },
    feature: {
      code,
      name: `테스트${code}`,
      market: "KOSPI",
      signalPrice: 10000,
      leaderRank,
      leaderGrade,
      leaderScore: 90,
      rs20,
      drawdownPct: -20,
      riskScore: 25,
      stabilizeScore: 80,
      liquidityScore: 70,
      foreignStreak: 2,
      institutionStreak: 1,
      cafe: false,
      mtt: false,
      leaderRebound: false
    },
    matches: Array.from({ length: strategies }, (_, index) => ({ id: `S${index}` })),
    axesAll: Array.from({ length: axes }, (_, index) => ({ id: `A${index}`, label: `계열${index}` }))
  };
}

test("핵심후보는 Leader TOP10 + 5전략+ + 3계열+", () => {
  const rows = buildEntryReviewCandidates([item({ leaderGrade: "B", rs20: 70 })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].coreCandidate, true);
  assert.equal(rows[0].strongCandidate, false);
});

test("강한후보는 Leader A + RS80+ + 3계열+", () => {
  const rows = buildEntryReviewCandidates([item({ leaderRank: 20, strategies: 3 })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].coreCandidate, false);
  assert.equal(rows[0].strongCandidate, true);
});

test("독립 계열이 3개 미만이면 넓힌 진입후보에 추가하지 않는다", () => {
  assert.equal(buildEntryReviewCandidates([item({ axes: 2 })]).length, 0);
});

test("정렬은 핵심+실제진입 → 핵심 → 강한+실제진입 → 강한 → 기존 실제진입", () => {
  const review = buildEntryReviewCandidates([
    item({ code: "000001", leaderGrade: "B", rs20: 70 }),
    item({ code: "000002", leaderRank: 20, strategies: 3 }),
    item({ code: "000003", leaderGrade: "B", rs20: 70 })
  ]);
  const actual = [
    { code: "000003", name: "핵심실제", category: { label: "분할 후보" }, rankScore: 10 },
    { code: "000002", name: "강한실제", category: { label: "분할 후보" }, rankScore: 9 },
    { code: "000004", name: "실제만", category: { label: "분할 후보" }, rankScore: 8 }
  ];
  const merged = mergeEntryCandidates(actual, review);
  assert.deepEqual(merged.map((row) => row.code), ["000003", "000001", "000002", "000004"]);
});

test("넓힌 화면 후보가 기존 simulator 가상매수 actionable 판정을 바꾸지 않는다", () => {
  const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(server, /const actionableToday = collected\.candidates\s*\.filter\(\(candidate\) => candidate\.category\.actionable\)/);
  assert.match(server, /opened = actionableToday/);
});
