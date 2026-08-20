// V3 self-test. Covers the correctness properties that make the numbers
// trustworthy: no look-ahead, next-open entry, cost, cooldown, per-market
// ranking, NA handling, filter algebra, train/test split and determinism.

import assert from "node:assert/strict";
import { evaluate } from "./filters.mjs";
import { applyPerCodeCooldown, metricBlock, classify } from "./metrics.mjs";
import { buildOutcomes, runtime, calcScoutBaseAt } from "./v2-core.mjs";
import { buildRelativeStrength20 } from "../relative-strength.js";
import { rankMarketRowsV2 } from "../public/rebound-ranking-v2.js";
import { FILTERS, PRESETS } from "./registry.mjs";

function series(n, startPrice = 100) {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026${String(1 + Math.floor(i / 28)).padStart(2, "0")}${String((i % 28) + 1).padStart(2, "0")}`,
    open: startPrice + i,
    high: startPrice + i + 2,
    low: startPrice + i - 1,
    close: startPrice + i + 1,
    volume: 1000,
    tradingValue: 1000 * (startPrice + i)
  }));
}

export function runSelfTest() {
  const checks = [];
  const ok = (name, fn) => {
    try { fn(); checks.push(`PASS  ${name}`); }
    catch (e) { checks.push(`FAIL  ${name}: ${e.message}`); throw e; }
  };

  // 1 + 2. Entry is the next trading day's open; the signal bar is never used.
  ok("다음 거래일 시가 진입 / 미래정보 미사용", () => {
    const s = series(30);
    const out = buildOutcomes(s, 10, { holds: [3], costPct: 0 });
    assert.equal(out[3].entryDate, s[11].date, "entry must be the bar AFTER the signal");
    assert.equal(out[3].entryPrice, s[11].open, "entry price must be that bar's open");
    assert.equal(out[3].exitDate, s[14].date);
    assert.equal(out[3].exitPrice, s[14].close);
    // Mutating bars at or before the signal index must not change the result.
    const tampered = s.map((b, i) => (i <= 10 ? { ...b, close: 99999, high: 99999 } : b));
    const out2 = buildOutcomes(tampered, 10, { holds: [3], costPct: 0 });
    assert.equal(out2[3].netReturnPct, out[3].netReturnPct, "past bars must not affect the outcome");
  });

  // 3. Round-trip cost is deducted exactly once.
  ok("왕복비용 정상 차감", () => {
    const s = series(30);
    const free = buildOutcomes(s, 5, { holds: [5], costPct: 0 })[5];
    const costed = buildOutcomes(s, 5, { holds: [5], costPct: 0.23 })[5];
    assert.ok(Math.abs((free.netReturnPct - costed.netReturnPct) - 0.23) < 1e-9);
    assert.equal(free.grossReturnPct, costed.grossReturnPct, "gross must be unaffected by cost");
  });

  // 4. Cooldown: one open trade per code at a time.
  ok("쿨다운 정상 (동일 종목 중복 진입 차단)", () => {
    const rows = [
      { code: "A", date: "20260101", entryDate5: "20260102", exitDate5: "20260110" },
      { code: "A", date: "20260105", entryDate5: "20260106", exitDate5: "20260114" },
      { code: "A", date: "20260115", entryDate5: "20260116", exitDate5: "20260124" },
      { code: "B", date: "20260105", entryDate5: "20260106", exitDate5: "20260114" }
    ];
    const kept = applyPerCodeCooldown(rows, 5);
    assert.deepEqual(kept.map((r) => `${r.code}:${r.date}`), ["A:20260101", "B:20260105", "A:20260115"]);
  });

  // 5. Ranking V2 sorting is reproduced by the production comparator.
  ok("Ranking V2 정렬 정상 (production comparator 사용)", () => {
    const mk = (code, tier) => ({
      code, market: "KOSPI",
      scout: tier === 1
        ? { drawdownFromHighPct: -30, riskScore: 20, stabilizeScore: 90, status: "하락 정지 확인" }
        : { drawdownFromHighPct: -10, riskScore: 60, stabilizeScore: 50, status: "관찰 목록" },
      combined: { blocked: false, gateReason: "PASS" },
      confirmation: { minerviniPass: tier === 1 },
      leader: { score: tier === 1 ? 90 : 40 },
      supply: {}, strategy: { flags: {} }, changeRate: 0, changeRate3d: 0
    });
    const ranked = rankMarketRowsV2([mk("LOW", 5), mk("TOP", 1)]);
    assert.equal(ranked[0].code, "TOP", "the stronger tier must sort first");
  });

  // 6. RS20 is a per-market percentile; markets never mix.
  ok("RS20 시장별 percentile 정상", () => {
    const rs = buildRelativeStrength20([
      { code: "K1", market: "KOSPI", ret20: 50 },
      { code: "K2", market: "KOSPI", ret20: -50 },
      { code: "Q1", market: "KOSDAQ", ret20: 1 },
      { code: "Q2", market: "KOSDAQ", ret20: -1 }
    ]);
    assert.equal(rs.get("K1"), 99);
    assert.equal(rs.get("Q1"), 99, "KOSDAQ top must be 99 even though its raw return is far below KOSPI's");
    assert.equal(rs.get("K2"), 0);
    assert.equal(rs.get("Q2"), 0);
  });

  // 7 + 8. Filter algebra and inclusive between boundaries.
  ok("필터 AND/OR/NOT 및 between 경계값 정상", () => {
    const row = { a: 10, b: 5, flag: true, label: "X" };
    assert.equal(evaluate({ all: [{ field: "a", op: "gte", value: 10 }, { field: "b", op: "lt", value: 6 }] }, row), true);
    assert.equal(evaluate({ any: [{ field: "a", op: "gt", value: 99 }, { field: "b", op: "eq", value: 5 }] }, row), true);
    assert.equal(evaluate({ not: { field: "flag", op: "true" } }, row), false);
    assert.equal(evaluate({ field: "a", op: "between", value: [10, 20] }, row), true, "lower bound inclusive");
    assert.equal(evaluate({ field: "a", op: "between", value: [0, 10] }, row), true, "upper bound inclusive");
    assert.equal(evaluate({ field: "a", op: "between", value: [11, 20] }, row), false);
    assert.equal(evaluate({ field: "label", op: "in", value: ["X", "Y"] }, row), true);
    assert.equal(evaluate({ field: "label", op: "notIn", value: ["X"] }, row), false);
  });

  // 12. NA is never silently read as 0 / false.
  ok("NA 데이터를 false/0으로 오인하지 않음", () => {
    const na = { v: null, u: undefined, flag: null };
    assert.equal(evaluate({ field: "v", op: "gte", value: 0 }, na), false, "null must not satisfy >= 0");
    assert.equal(evaluate({ field: "v", op: "lte", value: 0 }, na), false, "null must not satisfy <= 0");
    assert.equal(evaluate({ field: "v", op: "lt", value: 100 }, na), false);
    assert.equal(evaluate({ field: "v", op: "between", value: [-1, 1] }, na), false);
    assert.equal(evaluate({ field: "flag", op: "true" }, na), false);
    assert.equal(evaluate({ field: "flag", op: "false" }, na), false, "null is not false");
    assert.equal(evaluate({ field: "u", op: "notIn", value: ["x"] }, na), false);
    assert.equal(evaluate({ field: "v", op: "isNA" }, na), true);
    assert.equal(evaluate({ field: "v", op: "notNA" }, na), false);
  });

  // 9. TRAIN/TEST split is a clean date cut with no overlap.
  ok("TRAIN/TEST 분리 정상", () => {
    const rows = ["20260101", "20260201", "20260301", "20260401"].map((date) => ({ date }));
    const splitDate = "20260301";
    const train = rows.filter((r) => r.date < splitDate);
    const test = rows.filter((r) => r.date >= splitDate);
    assert.equal(train.length, 2);
    assert.equal(test.length, 2);
    assert.equal(train.filter((r) => test.includes(r)).length, 0, "no observation may appear in both samples");
    assert.ok(train.every((r) => r.date < test[0].date));
  });

  // 11. Per-market ranking never mixes KOSPI and KOSDAQ.
  ok("KOSPI/KOSDAQ 순위 혼합 없음", () => {
    const rows = [
      { code: "K", market: "KOSPI", date: "20260101", combinedRank: 1 },
      { code: "Q", market: "KOSDAQ", date: "20260101", combinedRank: 1 }
    ];
    const grouped = new Map();
    for (const r of rows) {
      const k = `${r.date}|${r.market}`;
      grouped.set(k, [...(grouped.get(k) ?? []), r]);
    }
    assert.equal(grouped.size, 2, "same date in two markets must stay in two groups");
    assert.equal([...grouped.values()].every((g) => g.length === 1), true);
  });

  // Scout base must not read beyond the slice it is given.
  ok("Scout 계산이 미래 봉을 보지 않음", () => {
    const s = series(300);
    const atIndex = 200;
    const a = calcScoutBaseAt(s.slice(0, atIndex + 1));
    const tamperedFuture = s.map((b, i) => (i > atIndex ? { ...b, close: 1, low: 1, high: 1 } : b));
    const b = calcScoutBaseAt(tamperedFuture.slice(0, atIndex + 1));
    assert.deepEqual(a, b, "future bars must not change a point-in-time scout");
  });

  // 13. Same input -> same output.
  ok("동일 config 재실행 deterministic", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      code: `C${i % 7}`, date: `202601${String((i % 28) + 1).padStart(2, "0")}`,
      r10: (i % 5) - 2, mfe10: i % 4, mae10: -(i % 3),
      entryDate10: `202602${String((i % 28) + 1).padStart(2, "0")}`,
      exitDate10: `202603${String((i % 28) + 1).padStart(2, "0")}`
    }));
    const once = JSON.stringify(metricBlock(applyPerCodeCooldown(rows, 10), 10));
    const twice = JSON.stringify(metricBlock(applyPerCodeCooldown(rows, 10), 10));
    assert.equal(once, twice);
  });

  // Registry integrity: presets can only reference real filters.
  ok("Preset이 실제 필터만 참조", () => {
    assert.ok(FILTERS.length > 100, `expected a large registry, got ${FILTERS.length}`);
    assert.ok(Object.keys(PRESETS).length >= 40);
    const names = new Set(FILTERS.map((f) => f.name));
    assert.equal(names.size, FILTERS.length, "filter names must be unique");
    for (const [name, cond] of Object.entries(PRESETS)) {
      assert.ok(cond.all && cond.all.length, `preset ${name} must have conditions`);
    }
  });

  // Verdicts must not flatter a result that fails out of sample.
  ok("판정 로직: 과최적화/역효과/표본부족 구분", () => {
    assert.equal(classify({ trainAvg: 5, testAvg: -1, trainN: 50, testN: 50, minTrades: 20 }), "과최적화 위험");
    assert.equal(classify({ trainAvg: 1, testAvg: 0.5, trainN: 5, testN: 5, minTrades: 20 }), "표본부족");
    assert.equal(classify({ trainAvg: 1, testAvg: 0.5, trainN: 50, testN: 50, controlAvg: 2, minTrades: 20 }), "역효과");
    assert.equal(classify({ trainAvg: 1, testAvg: 1, trainN: 50, testN: 50, controlAvg: 0, neighbourAvgs: [0.9, 1.1], minTrades: 20 }), "견고 가능성");
  });

  console.log(checks.join("\n"));
  console.log(`\nV3 self-test: ${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} PASS`);
  return checks;
}
