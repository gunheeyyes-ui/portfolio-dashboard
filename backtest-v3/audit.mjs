// The robustness audit: slice-by-slice interrogation of the V3 results.
// Each function returns plain rows so the runner can write CSVs and the
// report can render them without recomputing anything.

import { evaluate } from "./filters.mjs";
import { applyPerCodeCooldown, metricBlock, rnd, avg } from "./metrics.mjs";
import {
  resampleAudit, concentration, runWalkForward, buildFolds,
  cooldownSensitivity, firstSignalPerCode
} from "./robustness.mjs";

const C = {
  leaderA: { field: "leaderGrade", op: "in", value: ["A"] },
  leaderAB: { field: "leaderGrade", op: "in", value: ["A", "B"] },
  rs: (n) => ({ field: "rs20", op: "gte", value: n }),
  risk: (n) => ({ field: "scoutRiskScore", op: "lte", value: n }),
  stab: (n) => ({ field: "scoutStabilizeScore", op: "gte", value: n }),
  ddBelow: (n) => ({ field: "drawdownFromHighPct", op: "lte", value: n }),
  rank: (field, n) => ({ field, op: "between", value: [1, n] })
};

/** Trades matched by a condition, after the standard holding cooldown. */
function tradesFor(rows, condition, h) {
  return applyPerCodeCooldown(rows.filter((r) => evaluate(condition, r)), h);
}

function block(rows, h, extra = {}) {
  const m = metricBlock(rows, h);
  return {
    n: m.observations,
    avgPct: m.avgReturnPct,
    medianPct: m.medianReturnPct,
    winPct: m.winRatePct,
    pf: m.profitFactor,
    mfePct: m.avgMfePct,
    maePct: m.avgMaePct,
    excessPct: rnd(avg(rows.map((r) => r[`x${h}`]))),
    ...extra
  };
}

// ------------------------------------------------- 2. extreme drawdown audit

export function extremeDrawdownAudit(testRows, h, threshold = -60) {
  const condition = C.ddBelow(threshold);
  const trades = tradesFor(testRows, condition, h);
  const counts = new Map();
  for (const r of trades) counts.set(r.code, (counts.get(r.code) ?? 0) + 1);

  const detail = trades.map((r) => ({
    code: r.code, name: r.name, market: r.market, signalDate: r.date,
    drawdownPct: rnd(r.drawdownFromHighPct),
    leaderScore: r.leaderScore, leaderGrade: r.leaderGrade,
    rs20: r.rs20, risk: r.scoutRiskScore, stabilize: r.scoutStabilizeScore,
    liquidityScore: r.liquidityScore,
    entryPrice: r.entryPrice ?? null,
    r3: r.r3, r5: r.r5, r10: r.r10, r20: r.r20,
    mfe: r[`mfe${h}`], mae: r[`mae${h}`],
    excessPct: r[`x${h}`],
    scoutStatus: r.scoutStatus, reboundState: r.reboundStateKey,
    rankingTier: r.rankingTier,
    signalsForThisCodeInBucket: counts.get(r.code)
  }));

  return { detail, summary: resampleAudit(trades, h), concentration: concentration(trades, h), trades };
}

// ----------------------------------------------------- 4. Leader deep checks

const PERIODS = [
  { name: "2024 H2", from: "20240701", to: "20241231" },
  { name: "2025 H1", from: "20250101", to: "20250630" },
  { name: "2025 H2", from: "20250701", to: "20251231" },
  { name: "2026 H1", from: "20260101", to: "20260630" },
  { name: "2026 H2", from: "20260701", to: "20261231" }
];

export function leaderBreakdown(allRows, holds) {
  const rows = [];
  for (const grade of ["A", "B", "C", "D"]) {
    const cond = { field: "leaderGrade", op: "in", value: [grade] };
    for (const h of holds) {
      rows.push({ view: "등급×보유", key: `Leader_${grade}`, horizon: h, ...block(tradesFor(allRows, cond, h), h) });
    }
    for (const market of ["KOSPI", "KOSDAQ"]) {
      const marketRows = allRows.filter((r) => r.market === market);
      rows.push({ view: "등급×시장", key: `Leader_${grade}`, market, horizon: 10, ...block(tradesFor(marketRows, cond, 10), 10) });
    }
    for (const p of PERIODS) {
      const periodRows = allRows.filter((r) => r.date >= p.from && r.date <= p.to);
      if (!periodRows.length) continue;
      rows.push({ view: "등급×기간", key: `Leader_${grade}`, period: p.name, horizon: 10, ...block(tradesFor(periodRows, cond, 10), 10) });
    }
  }
  for (const cut of [50, 60, 70, 80, 85, 90]) {
    const cond = { field: "leaderScore", op: "gte", value: cut };
    rows.push({ view: "점수 threshold", key: `Leader>=${cut}`, horizon: 10, ...block(tradesFor(allRows, cond, 10), 10) });
  }
  return rows;
}

// ------------------------------------------------ 5. Leader × RS20 crossing

export function leaderRsMatrix(allRows, h) {
  const combos = [
    ["Leader A 전체", { all: [C.leaderA] }],
    ["Leader A + RS>=70", { all: [C.leaderA, C.rs(70)] }],
    ["Leader A + RS>=80", { all: [C.leaderA, C.rs(80)] }],
    ["Leader A + RS>=90", { all: [C.leaderA, C.rs(90)] }],
    ["Leader A + RS<80", { all: [C.leaderA, { field: "rs20", op: "lt", value: 80 }] }],
    ["Leader A/B + RS>=80", { all: [C.leaderAB, C.rs(80)] }],
    ["Leader>=80 + RS>=80", { all: [{ field: "leaderScore", op: "gte", value: 80 }, C.rs(80)] }],
    ["Leader>=85 + RS>=80", { all: [{ field: "leaderScore", op: "gte", value: 85 }, C.rs(80)] }],
    ["Leader>=90 + RS>=90", { all: [{ field: "leaderScore", op: "gte", value: 90 }, C.rs(90)] }],
    ["RS>=80 단독", { all: [C.rs(80)] }],
    ["RS>=90 단독", { all: [C.rs(90)] }]
  ];
  return combos.map(([key, condition]) => ({ key, ...block(tradesFor(allRows, condition, h), h) }));
}

// ------------------------------------------------- 6. Leader × pullback depth

const DD_BUCKETS = [
  [-5, 0, "0~-5"], [-10, -5.0001, "-5~-10"], [-15, -10.0001, "-10~-15"],
  [-20, -15.0001, "-15~-20"], [-30, -20.0001, "-20~-30"], [-40, -30.0001, "-30~-40"],
  [-50, -40.0001, "-40~-50"], [-999, -50.0001, "<-50"]
];

export function leaderPullback(allRows, h) {
  const rows = [];
  for (const [label, cond] of [["Leader A", C.leaderA], ["Leader A/B", C.leaderAB]]) {
    for (const [min, max, name] of DD_BUCKETS) {
      const condition = { all: [cond, { field: "drawdownFromHighPct", op: "between", value: [min, max] }] };
      rows.push({ leader: label, drawdown: name, ...block(tradesFor(allRows, condition, h), h) });
    }
  }
  return rows;
}

// -------------------------------------------- 7. Leader × Risk × Stabilize

export function leaderRiskStab(allRows, h) {
  const combos = [
    ["Leader A", { all: [C.leaderA] }],
    ["Leader A + Risk<=39", { all: [C.leaderA, C.risk(39)] }],
    ["Leader A + Risk<=24", { all: [C.leaderA, C.risk(24)] }],
    ["Leader A + Stab>=65", { all: [C.leaderA, C.stab(65)] }],
    ["Leader A + Stab>=80", { all: [C.leaderA, C.stab(80)] }],
    ["Leader A + Stab>=90", { all: [C.leaderA, C.stab(90)] }],
    ["Leader A + Risk<=39 + Stab>=65", { all: [C.leaderA, C.risk(39), C.stab(65)] }],
    ["Leader A + Risk<=24 + Stab>=80", { all: [C.leaderA, C.risk(24), C.stab(80)] }],
    ["Leader A/B + Risk<=24 + Stab>=80", { all: [C.leaderAB, C.risk(24), C.stab(80)] }]
  ];
  return combos.map(([key, condition]) => ({ key, ...block(tradesFor(allRows, condition, h), h) }));
}

// ------------------------------- 15. rebound systems combined with Leader

export function reboundWithLeader(allRows, h) {
  const combos = [
    ["RankingV2 TOP10 단독", { all: [C.rank("rankingV2Rank", 10)] }],
    ["RankingV2 TOP10 + Leader A", { all: [C.rank("rankingV2Rank", 10), C.leaderA] }],
    ["RankingV2 T2 단독", { all: [{ field: "rankingTier", op: "eq", value: 2 }] }],
    ["RankingV2 T2 + Leader A/B", { all: [{ field: "rankingTier", op: "eq", value: 2 }, C.leaderAB] }],
    ["Scout TOP10 단독", { all: [C.rank("scoutRank", 10)] }],
    ["Scout TOP10 + Leader A", { all: [C.rank("scoutRank", 10), C.leaderA] }],
    ["Scout ready 단독", { all: [{ field: "reboundStateKey", op: "eq", value: "ready" }] }],
    ["Scout ready + Leader A", { all: [{ field: "reboundStateKey", op: "eq", value: "ready" }, C.leaderA] }],
    ["Scout stopped 단독", { all: [{ field: "reboundStateKey", op: "eq", value: "stopped" }] }],
    ["Scout stopped + Leader A", { all: [{ field: "reboundStateKey", op: "eq", value: "stopped" }, C.leaderA] }],
    ["Stab>=80 + Leader A", { all: [C.stab(80), C.leaderA] }],
    ["DeepRecovery 단독", { all: [{ field: "deepRecoveryPass", op: "true" }] }],
    ["DeepRecovery + Leader A/B", { all: [{ field: "deepRecoveryPass", op: "true" }, C.leaderAB] }]
  ];
  return combos.map(([key, condition]) => ({ key, ...block(tradesFor(allRows, condition, h), h) }));
}

// ------------------------------------------ 12. TOP-N as a daily portfolio

const RANK_SYSTEMS = [
  { name: "Leader", field: "leaderRank" },
  { name: "RS20", field: "rs20Rank" },
  { name: "Leader→RS(lexicographic)", field: "leaderThenRsRank" },
  { name: "종합타이밍", field: "combinedRank" },
  { name: "RankingV2", field: "rankingV2Rank" },
  { name: "Scout", field: "scoutRank" }
];

/**
 * Adds the two derived ranks the portfolio test needs. The composite is
 * strictly lexicographic (Leader band first, RS only as a tie-break) so no
 * new score is invented.
 */
export function attachPortfolioRanks(observations) {
  const groups = new Map();
  for (const row of observations) {
    const key = `${row.date}|${row.market}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const rows of groups.values()) {
    const byRs = [...rows].filter((r) => Number.isFinite(r.rs20)).sort((a, b) => b.rs20 - a.rs20);
    byRs.forEach((r, i) => { r.rs20Rank = i + 1; });
    const gradeOrder = { A: 0, B: 1, C: 2, D: 3 };
    const lex = [...rows]
      .filter((r) => Number.isFinite(r.rs20) && r.leaderGrade in gradeOrder)
      .sort((a, b) => gradeOrder[a.leaderGrade] - gradeOrder[b.leaderGrade] || b.rs20 - a.rs20);
    lex.forEach((r, i) => { r.leaderThenRsRank = i + 1; });
  }
  return observations;
}

export function portfolioTopN(testRows, holds) {
  const groups = new Map();
  for (const row of testRows) {
    const key = `${row.date}|${row.market}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const out = [];
  for (const system of RANK_SYSTEMS) {
    for (const n of [1, 3, 5, 10, 20]) {
      const cohorts = [];
      let prevSet = null;
      let overlapSum = 0;
      let overlapCount = 0;
      for (const [key, rows] of [...groups.entries()].sort()) {
        const picked = rows
          .filter((r) => Number.isFinite(r[system.field]))
          .sort((a, b) => a[system.field] - b[system.field])
          .slice(0, n);
        if (!picked.length) continue;
        const set = new Set(picked.map((r) => r.code));
        if (prevSet && key.endsWith(prevSet.market)) {
          const inter = [...set].filter((c) => prevSet.codes.has(c)).length;
          overlapSum += inter / n;
          overlapCount += 1;
        }
        prevSet = { codes: set, market: key.split("|")[1] };
        const entry = { date: key.split("|")[0], market: key.split("|")[1] };
        for (const h of holds) {
          entry[`r${h}`] = avg(picked.map((r) => r[`r${h}`]));
          entry[`x${h}`] = avg(picked.map((r) => r[`x${h}`]));
        }
        cohorts.push(entry);
      }
      const row = { system: system.name, topN: n, cohorts: cohorts.length };
      for (const h of holds) {
        const vals = cohorts.map((c) => c[`r${h}`]).filter(Number.isFinite);
        const ex = cohorts.map((c) => c[`x${h}`]).filter(Number.isFinite);
        row[`avg${h}`] = rnd(avg(vals));
        row[`excess${h}`] = rnd(avg(ex));
        if (h === 10) {
          const sorted = [...vals].sort((a, b) => a - b);
          row.winPct10 = vals.length ? rnd((vals.filter((v) => v > 0).length / vals.length) * 100) : null;
          row.worstCohort10 = sorted.length ? rnd(sorted[0]) : null;
          row.bestCohort10 = sorted.length ? rnd(sorted.at(-1)) : null;
          row.medianCohort10 = sorted.length ? rnd(sorted[Math.floor(sorted.length / 2)]) : null;
        }
      }
      row.avgOverlapPct = overlapCount ? rnd((overlapSum / overlapCount) * 100) : null;
      row.turnoverPct = overlapCount ? rnd(100 - (overlapSum / overlapCount) * 100) : null;
      out.push(row);
    }
  }
  return out;
}

// ------------------------------------------------ 14. market-cap buckets

export function marketCapBuckets(testRows, h) {
  const withCap = testRows.filter((r) => Number.isFinite(r.marketCap) && r.marketCap > 0);
  if (!withCap.length) return [];
  const sorted = [...withCap].sort((a, b) => b.marketCap - a.marketCap);
  const third = Math.floor(sorted.length / 3);
  const buckets = [
    ["대형(approximate)", sorted.slice(0, third)],
    ["중형(approximate)", sorted.slice(third, third * 2)],
    ["소형(approximate)", sorted.slice(third * 2)]
  ];
  return buckets.map(([key, rows]) => ({
    key, note: "현재 상장주식수 소급 — approximate",
    ...block(applyPerCodeCooldown(rows, h), h)
  }));
}

// ------------------------------------------ 16/17. core comparison + verdict

export const CORE_STRATEGIES = [
  ["대조군(전체)", null],
  ["Leader A", { all: [C.leaderA] }],
  ["Leader TOP3", { all: [C.rank("leaderRank", 3)] }],
  ["Leader TOP10", { all: [C.rank("leaderRank", 10)] }],
  ["RS80+", { all: [C.rs(80)] }],
  ["RS90+", { all: [C.rs(90)] }],
  ["Leader A + RS80", { all: [C.leaderA, C.rs(80)] }],
  ["Leader A + RS90", { all: [C.leaderA, C.rs(90)] }],
  ["Leader A + Risk<=24", { all: [C.leaderA, C.risk(24)] }],
  ["Leader A + Stab>=80", { all: [C.leaderA, C.stab(80)] }],
  ["Leader A + Risk<=24 + Stab>=80", { all: [C.leaderA, C.risk(24), C.stab(80)] }],
  ["종합타이밍 TOP10", { all: [C.rank("combinedRank", 10)] }],
  ["RankingV2 TOP10", { all: [C.rank("rankingV2Rank", 10)] }],
  ["Scout TOP10", { all: [C.rank("scoutRank", 10)] }],
  ["낙폭 <-60", { all: [C.ddBelow(-60)] }],
  ["낙폭 <-60 + Leader A/B", { all: [C.ddBelow(-60), C.leaderAB] }]
];

/**
 * The grade combines every robustness dimension. A strategy only reaches
 * "Robust candidate" when sample size, out-of-sample excess, fold stability
 * and concentration all hold at once.
 */
export function gradeStrategy({ n, excessPct, foldsPositive, foldsTotal, concentrationWarning, resample, minTrades }) {
  if ((n ?? 0) < minTrades) return "Insufficient";
  if (!Number.isFinite(excessPct) || excessPct <= 0) return "Negative";
  if (concentrationWarning) return "Concentrated";
  const foldsOk = foldsTotal > 0 && foldsPositive >= Math.ceil(foldsTotal * 0.67);
  const resampleOk = resample?.potentiallyRobust === true;
  if (foldsOk && resampleOk) return "Robust candidate";
  if (foldsOk || resampleOk) return "Promising";
  return "Fragile";
}

export function coreComparison(testRows, allRows, folds, h, minTrades) {
  return CORE_STRATEGIES.map(([key, condition]) => {
    const trades = condition ? tradesFor(testRows, condition, h) : applyPerCodeCooldown(testRows, h);
    const wf = runWalkForward(allRows, condition, folds, h);
    const conc = concentration(trades, h);
    const resample = resampleAudit(trades, h);
    const base = block(trades, h);
    return {
      strategy: key,
      ...base,
      foldsPositive: wf.foldsPositive,
      foldsTotal: wf.foldsTotal,
      worstFoldExcessPct: wf.worstFoldExcessPct,
      top5SharePct: conc.top5SharePct,
      excludeTop5MeanPct: conc.excludeTop5MeanPct,
      potentiallyRobust: resample.potentiallyRobust,
      verdict: gradeStrategy({
        n: base.n, excessPct: base.excessPct,
        foldsPositive: wf.foldsPositive, foldsTotal: wf.foldsTotal,
        concentrationWarning: conc.concentrationWarning, resample, minTrades
      })
    };
  });
}

export { tradesFor, block, C, buildFolds, runWalkForward, cooldownSensitivity, concentration, resampleAudit, firstSignalPerCode };
