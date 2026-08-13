import test from "node:test";
import assert from "node:assert/strict";
import { buildRelativeStrength20 } from "./relative-strength.js";

test("RS20 is a 0-99 percentile rank, higher ret20 gets higher RS", () => {
  const rows = [
    { code: "A", market: "KOSPI", ret20: -10 },
    { code: "B", market: "KOSPI", ret20: 0 },
    { code: "C", market: "KOSPI", ret20: 5 },
    { code: "D", market: "KOSPI", ret20: 20 }
  ];
  const rs = buildRelativeStrength20(rows);
  assert.equal(rs.get("A"), 0);
  assert.equal(rs.get("D"), 99);
  assert.ok(rs.get("A") < rs.get("B"));
  assert.ok(rs.get("B") < rs.get("C"));
  assert.ok(rs.get("C") < rs.get("D"));
  for (const value of rs.values()) {
    assert.ok(value >= 0 && value <= 99, `RS20 out of range: ${value}`);
  }
});

test("KOSPI and KOSDAQ are ranked independently of each other", () => {
  const rows = [
    { code: "K1", market: "KOSPI", ret20: 50 },
    { code: "K2", market: "KOSPI", ret20: -50 },
    { code: "Q1", market: "KOSDAQ", ret20: -1 },
    { code: "Q2", market: "KOSDAQ", ret20: 1 }
  ];
  const rs = buildRelativeStrength20(rows);
  // K1 is the strongest in a 2-name KOSPI group, Q2 the strongest in a
  // 2-name KOSDAQ group; a huge cross-market gap in raw ret20 must not
  // leak into the other market's ranking.
  assert.equal(rs.get("K1"), 99);
  assert.equal(rs.get("K2"), 0);
  assert.equal(rs.get("Q2"), 99);
  assert.equal(rs.get("Q1"), 0);
});

test("missing or non-finite ret20 is excluded, not scored as 0", () => {
  const rows = [
    { code: "A", market: "KOSPI", ret20: 10 },
    { code: "B", market: "KOSPI", ret20: null },
    { code: "C", market: "KOSPI", ret20: undefined },
    { code: "D", market: "KOSPI", ret20: NaN },
    { code: "E", market: "KOSPI" }
  ];
  const rs = buildRelativeStrength20(rows);
  assert.equal(rs.size, 1);
  assert.ok(rs.has("A"));
  assert.ok(!rs.has("B"));
  assert.ok(!rs.has("C"));
  assert.ok(!rs.has("D"));
  assert.ok(!rs.has("E"));
});

test("tied ret20 values receive the same RS20", () => {
  const rows = [
    { code: "A", market: "KOSPI", ret20: 1 },
    { code: "B", market: "KOSPI", ret20: 1 },
    { code: "C", market: "KOSPI", ret20: 2 }
  ];
  const rs = buildRelativeStrength20(rows);
  assert.equal(rs.get("A"), rs.get("B"));
  assert.ok(rs.get("C") > rs.get("A"));
});

test("a single-name market does not throw and returns a neutral value", () => {
  const rs = buildRelativeStrength20([{ code: "ONLY", market: "KOSDAQ", ret20: 7 }]);
  assert.equal(rs.get("ONLY"), 50);
});

test("does not require or read any field beyond code/market/ret20 (no look-ahead surface)", () => {
  const rows = [
    { code: "A", market: "KOSPI", ret20: 3, futureClose: 9999, tomorrowSignal: "buy" },
    { code: "B", market: "KOSPI", ret20: -3 }
  ];
  const rs = buildRelativeStrength20(rows);
  assert.equal(rs.get("A"), 99);
  assert.equal(rs.get("B"), 0);
});
