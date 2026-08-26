import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { buildSimulationV2, latestExcursion } from "./public/simulation-v2.js";

const html = readFileSync(new URL("./public/simulator.html", import.meta.url), "utf8");

function factors(overrides = {}) {
  return {
    leaderScore: 95,
    leaderGrade: "A",
    leaderRank: 3,
    rs20: 92,
    rsRank: 5,
    combinedScore: 88,
    combinedRank: 4,
    combinedDecision: "종합 최우선",
    combinedTier: 5,
    rankingV2Tier: 1,
    rankingV2Rank: 5,
    scoutRank: 6,
    scoutStatus: "하락 정지 확인",
    reboundStatus: "ready",
    drawdownPct: -24,
    riskScore: 22,
    stabilizeScore: 82,
    liquidityScore: 80,
    foreignStreak: 3,
    institutionStreak: 2,
    flags: { R: true, F: true, F2: true, B: true, C: false, H2: false, H3: false, I: false },
    cafe: true,
    mtt: true,
    leaderRebound: true,
    deepRecovery: false,
    actionable: true,
    simCategory: "priority",
    simCategoryLabel: "우선 검토",
    ...overrides
  };
}

function row(code, overrides = {}) {
  return {
    code,
    name: `테스트${code}`,
    signalPrice: 10_000,
    entryDate: "20260827",
    entryOpen: 10_100,
    status: "PENDING",
    factors: factors(),
    live: {
      currentReturnPct: 2.1,
      tradingDaysElapsed: 2,
      currentMFE: 4.2,
      currentMAE: -1.3,
      lastEvaluatedDate: "20260828"
    },
    outcomes: {
      "1": { netReturnPct: 1.2, mfePct: 3.1, maePct: -0.8, excessReturnPct: 0.7 },
      "3": { netReturnPct: 2.4, mfePct: 4.8, maePct: -1.1, excessReturnPct: 1.2 },
      "5": { netReturnPct: 4.0, mfePct: 6.5, maePct: -1.5, excessReturnPct: 2.0 },
      ...overrides.outcomes
    },
    ...overrides
  };
}

function detail(rows, signalDate = "2026-08-26", market = "KOSPI") {
  return { cohorts: [{ signalDate, market, recordedAt: "2026-08-26T07:00:00Z", rows }] };
}

test("Simulation V2 reconstructs actual/core/strong without changing the OOS registry", () => {
  const a = row("000001");
  const b = row("000002", { factors: factors({ actionable: false }) });
  const model = buildSimulationV2({
    actual: detail([a]),
    leaderTop10: detail([a, b]),
    consensus5s3a: detail([a]),
    leaderARs80: detail([a, b]),
    axis3plus: detail([b])
  });

  const actualCore = model.rows.find((item) => item.code === "000001");
  const strong = model.rows.find((item) => item.code === "000002");
  assert.equal(actualCore.actual, true);
  assert.equal(actualCore.core, true);
  assert.equal(actualCore.strong, false);
  assert.equal(strong.actual, false);
  assert.equal(strong.core, false);
  assert.equal(strong.strong, true);
  assert.ok(actualCore.strategyCount >= 5);
  assert.ok(actualCore.axisCount >= 3);
  assert.ok(actualCore.strategyIds.length === actualCore.strategyCount);
  assert.ok(actualCore.axisLabels.length === actualCore.axisCount);
});

test("Simulation V2 aggregates the same future OOS outcomes by cohort", () => {
  const win = row("000001");
  const loss = row("000002", {
    outcomes: {
      "5": { netReturnPct: -2, mfePct: 1, maePct: -4, excessReturnPct: -2.5 }
    }
  });
  const model = buildSimulationV2({
    actual: detail([win, loss]),
    leaderTop10: detail([win, loss]),
    consensus5s3a: detail([win, loss]),
    leaderARs80: detail([]),
    axis3plus: detail([])
  });
  const five = model.cohorts.core.horizons["5"];
  assert.equal(five.n, 2);
  assert.equal(five.avgReturnPct, 1);
  assert.equal(five.winRatePct, 50);
  assert.equal(five.avgMfePct, 3.75);
  assert.equal(five.avgMaePct, -2.75);
});

test("latest excursion prefers the longest confirmed horizon and falls back to live", () => {
  const confirmed = row("000001", {
    outcomes: {
      "10": { netReturnPct: 5, mfePct: 9, maePct: -2, excessReturnPct: 3 }
    }
  });
  assert.deepEqual(latestExcursion(confirmed), { horizon: 10, mfePct: 9, maePct: -2 });
  const liveOnly = row("000002", { outcomes: {} });
  assert.deepEqual(latestExcursion(liveOnly), { horizon: 2, mfePct: 4.2, maePct: -1.3 });
});

test("simulator page makes V2 primary while preserving legacy V1", () => {
  assert.match(html, /Simulation V2 — 손댈 필요 없이 자동으로 쌓이는 실전형 가상매매/);
  assert.match(html, /다음 거래일 시가/);
  assert.match(html, /id="simV2Cohorts"/);
  assert.match(html, /id="simV2Rows"/);
  assert.match(html, /아래는 기존 Simulation V1/);
  assert.match(html, /src="\/simulator-v2\.js"/);
});
