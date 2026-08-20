// Self-test for the robustness layer. These check the audit itself cannot
// flatter a result: benchmarks must cancel a common market move, resampling
// must actually change when one name dominates, folds must be disjoint and
// out-of-sample, and concentration must notice a single-stock strategy.

import assert from "node:assert/strict";
import {
  attachSameDateBenchmark, firstSignalPerCode, equalWeightBy, trimTop,
  resampleAudit, concentration, buildFolds, runWalkForward,
  cooldownSensitivity, detectCorporateActions, suspectWindows
} from "./robustness.mjs";
import { gradeStrategy } from "./audit.mjs";

function mkRow(code, date, market, r10, extra = {}) {
  return {
    code, name: code, date, market, r10, mfe10: Math.max(r10, 0), mae10: Math.min(r10, 0),
    entryDate10: date, exitDate10: date, ...extra
  };
}

export function runAuditSelfTest() {
  const checks = [];
  const ok = (name, fn) => {
    try { fn(); checks.push(`PASS  ${name}`); }
    catch (e) { checks.push(`FAIL  ${name}: ${e.message}`); throw e; }
  };

  ok("same-date 벤치마크가 시장 공통 상승분을 제거", () => {
    const rows = [
      mkRow("A", "20260101", "KOSPI", 12),
      mkRow("B", "20260101", "KOSPI", 8),
      mkRow("Q", "20260101", "KOSDAQ", 1)
    ];
    attachSameDateBenchmark(rows, [10]);
    // KOSPI mean is 10, so +12 is only +2 better than the market that day.
    assert.equal(rows[0].bench10, 10);
    assert.equal(rows[0].x10, 2);
    assert.equal(rows[1].x10, -2);
    // A different market must not be pulled into the KOSPI average.
    assert.equal(rows[2].bench10, 1, "KOSDAQ benchmark must use KOSDAQ rows only");
    assert.equal(rows[2].x10, 0);
  });

  ok("종목당 최초 신호만 남기기", () => {
    const rows = [
      mkRow("A", "20260103", "KOSPI", 5), mkRow("A", "20260101", "KOSPI", 1),
      mkRow("B", "20260102", "KOSPI", 3)
    ];
    const first = firstSignalPerCode(rows);
    assert.equal(first.length, 2);
    assert.equal(first.find((r) => r.code === "A").date, "20260101", "earliest signal wins");
  });

  ok("종목별/날짜별 equal weight가 반복신호 지배를 제거", () => {
    // A fires 4 times at +10, B once at 0. Raw mean is 8, per-code mean is 5.
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => mkRow("A", `2026010${i + 1}`, "KOSPI", 10)),
      mkRow("B", "20260105", "KOSPI", 0)
    ];
    const raw = rows.reduce((s, r) => s + r.r10, 0) / rows.length;
    assert.equal(raw, 8);
    const byCode = equalWeightBy(rows, "code", "r10");
    assert.equal(byCode.groups, 2);
    assert.equal(byCode.mean, 5, "per-code weighting must dilute the repeated name");
  });

  ok("상위 outlier 제거가 실제로 동작", () => {
    const rows = [mkRow("A", "20260101", "KOSPI", 100), ...Array.from({ length: 99 }, (_, i) => mkRow(`C${i}`, "20260101", "KOSPI", 0))];
    const trimmed = trimTop(rows, "r10", 1);
    assert.equal(trimmed.length, 99);
    assert.equal(trimmed.every((r) => r.r10 === 0), true, "the single +100 outlier must be gone");
  });

  ok("resampleAudit: 한 종목이 캐리한 결과는 potentiallyRobust=false", () => {
    // One name fires ten times at +30; ten other names each lose 5 once.
    // Raw mean is positive (+12.5) purely because the winner repeats, but
    // weighting each code once turns it negative — which is the whole point.
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => mkRow("HERO", `2026010${(i % 9) + 1}`, "KOSPI", 30)),
      ...Array.from({ length: 10 }, (_, i) => mkRow(`X${i}`, "20260110", "KOSPI", -5))
    ];
    attachSameDateBenchmark(rows, [10]);
    const audit = resampleAudit(rows, 10);
    assert.ok(audit.all.mean > 0, `raw mean should look good, got ${audit.all.mean}`);
    assert.ok(audit.equalWeightByCode.mean < 0, `per-code mean should expose it, got ${audit.equalWeightByCode.mean}`);
    assert.equal(audit.potentiallyRobust, false, "equal-weight variants must expose the single-name dependence");
  });

  ok("concentration이 단일 종목 의존을 경고", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => mkRow("HERO", `2026010${i + 1}`, "KOSPI", 40)),
      ...Array.from({ length: 5 }, (_, i) => mkRow(`X${i}`, "20260110", "KOSPI", 0.1))
    ];
    attachSameDateBenchmark(rows, [10]);
    const c = concentration(rows, 10);
    assert.ok(c.top1SharePct > 90, `expected a dominant top-1 share, got ${c.top1SharePct}`);
    assert.equal(c.concentrationWarning, true);
    assert.ok(c.excludeTop5MeanPct < 1, "removing the top names must collapse the mean");
  });

  ok("walk-forward fold가 서로 겹치지 않고 순차적", () => {
    const dates = Array.from({ length: 400 }, (_, i) => `2026${String(1 + Math.floor(i / 30)).padStart(2, "0")}${String((i % 30) + 1).padStart(2, "0")}`);
    const folds = buildFolds([...new Set(dates)], 3);
    assert.equal(folds.length, 3);
    for (let i = 1; i < folds.length; i += 1) {
      assert.ok(folds[i].testFrom > folds[i - 1].testTo, "fold test windows must not overlap");
    }
    for (const f of folds) {
      assert.ok(f.trainTo < f.testFrom, "training must end before its test window starts");
    }
  });

  ok("walk-forward가 fold별 초과수익을 분리 계산", () => {
    const dates = Array.from({ length: 300 }, (_, i) => `2026${String(1 + Math.floor(i / 25)).padStart(2, "0")}${String((i % 25) + 1).padStart(2, "0")}`);
    const uniq = [...new Set(dates)];
    const rows = uniq.flatMap((d, i) => [
      mkRow("A", d, "KOSPI", i < uniq.length / 2 ? 10 : -10, { flagX: true }),
      mkRow("B", d, "KOSPI", 0)
    ]);
    attachSameDateBenchmark(rows, [10]);
    const folds = buildFolds(uniq, 3);
    const wf = runWalkForward(rows, { field: "flagX", op: "true" }, folds, 10, { mode: "cohort" });
    assert.equal(wf.foldsTotal, folds.length);
    assert.ok(wf.foldsPositive < wf.foldsTotal, "a strategy that reverses must not be positive in every fold");
  });

  ok("cooldown 민감도가 변형별로 다른 표본을 만든다", () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      mkRow("A", `202601${String(i + 1).padStart(2, "0")}`, "KOSPI", 1, { flagX: true }));
    attachSameDateBenchmark(rows, [10]);
    const s = cooldownSensitivity(rows, { field: "flagX", op: "true" }, 10);
    assert.equal(s.cooldown0.n, 20);
    assert.ok(s.cooldown5.n < s.cooldown0.n, "a 5-day cooldown must drop some repeats");
    assert.equal(s.firstSignalOnly.n, 1, "first-signal-only keeps one trade per code");
  });

  ok("corporate action 탐지가 비정상 갭만 잡고 사실로 단정하지 않음", () => {
    const series = new Map([["A", [
      { date: "20260101", open: 100, high: 101, low: 99, close: 100 },
      { date: "20260102", open: 101, high: 102, low: 100, close: 101 },
      { date: "20260103", open: 50, high: 51, low: 49, close: 50 }
    ]]]);
    const suspects = detectCorporateActions(series, [{ code: "A", name: "테스트" }], 40);
    assert.equal(suspects.length, 1);
    assert.equal(suspects[0].date, "20260103");
    assert.ok(suspects[0].note.includes("POSSIBLE CORPORATE ACTION"), "must be flagged as possible, not proven");
    const isSuspect = suspectWindows(suspects, 90);
    assert.equal(isSuspect({ code: "A", date: "20260110" }), true, "within the window");
    assert.equal(isSuspect({ code: "A", date: "20260701" }), false, "outside the window");
    assert.equal(isSuspect({ code: "B", date: "20260103" }), false, "other codes unaffected");
  });

  ok("판정 등급이 각 실패 사유를 구분", () => {
    const robust = { n: 100, excessPct: 2, foldsPositive: 3, foldsTotal: 3, concentrationWarning: false, resample: { potentiallyRobust: true }, minTrades: 20 };
    assert.equal(gradeStrategy(robust), "Robust candidate");
    assert.equal(gradeStrategy({ ...robust, n: 5 }), "Insufficient");
    assert.equal(gradeStrategy({ ...robust, excessPct: -1 }), "Negative");
    assert.equal(gradeStrategy({ ...robust, concentrationWarning: true }), "Concentrated");
    assert.equal(gradeStrategy({ ...robust, foldsPositive: 1, resample: { potentiallyRobust: false } }), "Fragile");
    assert.equal(gradeStrategy({ ...robust, foldsPositive: 1 }), "Promising");
  });

  console.log(checks.join("\n"));
  console.log(`\nV3 audit self-test: ${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} PASS`);
  return checks;
}
