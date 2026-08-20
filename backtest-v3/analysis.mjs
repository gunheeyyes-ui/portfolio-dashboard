// Phase 2 of V3: evaluate filters against an existing feature matrix.
// Nothing here touches prices or the network — given the same matrix and the
// same config this is deterministic and fast.

import { evaluate, describe } from "./filters.mjs";
import { FILTERS, buildDynamicFilters, PRESETS, CROSS_AXES, CORE_TRIPLES, RANK_SYSTEMS, TOP_N_LIST } from "./registry.mjs";
import { applyPerCodeCooldown, strategyMetricBlock, classify, rnd } from "./metrics.mjs";

/**
 * Runs one condition over the matrix and returns TRAIN/TEST/ALL metrics.
 * `mode` is "cooldown" (one open trade per code) or "cohort" (every signal).
 */
export function runCondition({ name, condition, rows, splitDate, holds, mode = "cooldown", minTrades }) {
  const matched = rows.filter((row) => evaluate(condition, row));
  const out = [];
  for (const h of holds) {
    const pool = mode === "cooldown" ? applyPerCodeCooldown(matched, h) : matched;
    const samples = {
      ALL: pool,
      TRAIN: pool.filter((r) => r.date < splitDate),
      TEST: pool.filter((r) => r.date >= splitDate)
    };
    const blocks = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, strategyMetricBlock(v, h)]));
    out.push({
      strategy: name,
      definition: describe(condition),
      horizonDays: h,
      mode,
      trainTrades: blocks.TRAIN.trades,
      testTrades: blocks.TEST.trades,
      allTrades: blocks.ALL.trades,
      trainAvgPct: blocks.TRAIN.avgReturnPct,
      testAvgPct: blocks.TEST.avgReturnPct,
      allAvgPct: blocks.ALL.avgReturnPct,
      generalizationGap: Number.isFinite(blocks.TRAIN.avgReturnPct) && Number.isFinite(blocks.TEST.avgReturnPct)
        ? rnd(blocks.TRAIN.avgReturnPct - blocks.TEST.avgReturnPct) : null,
      trainPF: blocks.TRAIN.profitFactor,
      testPF: blocks.TEST.profitFactor,
      testWinRatePct: blocks.TEST.winRatePct,
      testMedianPct: blocks.TEST.medianReturnPct,
      testExcessPct: blocks.TEST.avgExcessPct,
      testMfePct: blocks.TEST.avgMfePct,
      testMaePct: blocks.TEST.avgMaePct,
      testHitPlus3Pct: blocks.TEST.hitPlus3Pct,
      testHitPlus5Pct: blocks.TEST.hitPlus5Pct,
      testHitMinus3Pct: blocks.TEST.hitMinus3Pct,
      testHitMinus5Pct: blocks.TEST.hitMinus5Pct,
      testMddPct: blocks.TEST.maxDrawdownPct,
      overfitWarning: blocks.TRAIN.avgReturnPct > 0 && blocks.TEST.avgReturnPct <= 0 && blocks.TEST.trades >= minTrades
    });
  }
  return out;
}

/** Baseline: every observation, so a filter can be judged against "do nothing". */
export function baselineRows(rows, splitDate, holds, minTrades) {
  return runCondition({ name: "BASELINE_ALL", condition: null, rows, splitDate, holds, minTrades });
}

export function runSingleFactors(rows, { splitDate, holds, minTrades }) {
  const all = [...FILTERS, ...buildDynamicFilters(rows)];
  const results = [];
  for (const f of all) {
    for (const r of runCondition({ name: f.name, condition: f.condition, rows, splitDate, holds, minTrades })) {
      results.push({ ...r, axis: f.axis });
    }
  }
  return { results, filters: all };
}

/** 2-factor: only across the axis pairs declared in the registry. */
export function runTwoFactor(rows, filters, { splitDate, holds, minTrades }) {
  const byAxis = new Map();
  for (const f of filters) {
    if (!byAxis.has(f.axis)) byAxis.set(f.axis, []);
    byAxis.get(f.axis).push(f);
  }
  const results = [];
  for (const [axisA, axisB] of CROSS_AXES) {
    const listA = byAxis.get(axisA) ?? [];
    const listB = byAxis.get(axisB) ?? [];
    for (const a of listA) {
      for (const b of listB) {
        const name = `${a.name} + ${b.name}`;
        const condition = { all: [a.condition, b.condition] };
        for (const r of runCondition({ name, condition, rows, splitDate, holds, minTrades })) {
          results.push({ ...r, axis: `${axisA}×${axisB}` });
        }
      }
    }
  }
  return results;
}

export function runCoreTriples(rows, filters, { splitDate, holds, minTrades }) {
  const byName = new Map(filters.map((f) => [f.name, f]));
  const results = [];
  for (const triple of CORE_TRIPLES) {
    const parts = triple.map((n) => byName.get(n)).filter(Boolean);
    if (parts.length !== triple.length) continue;
    const name = triple.join(" + ");
    const condition = { all: parts.map((p) => p.condition) };
    for (const r of runCondition({ name, condition, rows, splitDate, holds, minTrades })) {
      results.push({ ...r, axis: "triple" });
    }
  }
  return results;
}

export function runPresets(rows, { splitDate, holds, minTrades, only = null }) {
  const results = [];
  for (const [name, condition] of Object.entries(PRESETS)) {
    if (only && name !== only) continue;
    for (const r of runCondition({ name, condition, rows, splitDate, holds, minTrades })) {
      results.push({ ...r, axis: "preset" });
    }
  }
  return results;
}

/**
 * TOP-N by each ranking system, selected independently per market-day.
 * Reported as a daily cohort (every pick counts) — deliberately NOT mixed
 * with the cooldown-based strategy numbers.
 */
export function runTopN(rows, { splitDate, holds, minTrades }) {
  const results = [];
  const byDateMarket = new Map();
  for (const row of rows) {
    const key = `${row.date}|${row.market}`;
    if (!byDateMarket.has(key)) byDateMarket.set(key, []);
    byDateMarket.get(key).push(row);
  }
  for (const system of RANK_SYSTEMS) {
    for (const n of TOP_N_LIST) {
      const picked = [];
      for (const group of byDateMarket.values()) {
        const ranked = group
          .filter((r) => Number.isFinite(r[system.field]))
          .sort((a, b) => a[system.field] - b[system.field])
          .slice(0, n);
        picked.push(...ranked);
      }
      const name = `${system.name}_TOP${n}`;
      for (const r of runCondition({ name, condition: null, rows: picked, splitDate, holds, mode: "cohort", minTrades })) {
        results.push({ ...r, axis: "topN", rankSystem: system.name, topN: n });
      }
    }
  }
  return results;
}

/**
 * Threshold sweeps. Reports every cut point side by side and labels the
 * filter robust/fragile from how neighbouring cuts behave, so a single lucky
 * threshold cannot be read as an optimum.
 */
export function runThresholdSweep(rows, filters, { splitDate, holds, minTrades, focusHorizon }) {
  const sweeps = new Map();
  for (const f of filters) {
    if (!f.sweep) continue;
    const key = `${f.sweep.field}|${f.sweep.direction}`;
    if (!sweeps.has(key)) sweeps.set(key, []);
    sweeps.get(key).push(f);
  }
  const results = [];
  for (const [key, list] of sweeps) {
    const ordered = [...list].sort((a, b) => a.sweep.cut - b.sweep.cut);
    const perCut = ordered.map((f) => {
      const rowsForHorizon = runCondition({ name: f.name, condition: f.condition, rows, splitDate, holds: [focusHorizon], minTrades })[0];
      return { filter: f, metrics: rowsForHorizon };
    });
    perCut.forEach((entry, index) => {
      const neighbours = [perCut[index - 1], perCut[index + 1]].filter(Boolean).map((n) => n.metrics.testAvgPct);
      results.push({
        sweep: key,
        cut: entry.filter.sweep.cut,
        direction: entry.filter.sweep.direction,
        strategy: entry.filter.name,
        horizonDays: focusHorizon,
        trainTrades: entry.metrics.trainTrades,
        testTrades: entry.metrics.testTrades,
        trainAvgPct: entry.metrics.trainAvgPct,
        testAvgPct: entry.metrics.testAvgPct,
        testPF: entry.metrics.testPF,
        neighbourTestAvg: neighbours.map((v) => (Number.isFinite(v) ? v : "NA")).join(" / "),
        verdict: classify({
          trainAvg: entry.metrics.trainAvgPct,
          testAvg: entry.metrics.testAvgPct,
          trainN: entry.metrics.trainTrades,
          testN: entry.metrics.testTrades,
          neighbourAvgs: neighbours,
          minTrades
        })
      });
    });
  }
  return results;
}

/** Adds the verdict column used everywhere in the report. */
export function attachVerdicts(results, baseline, minTrades) {
  const baseByHorizon = new Map(baseline.map((b) => [b.horizonDays, b.testAvgPct]));
  return results.map((r) => ({
    ...r,
    baselineTestAvgPct: baseByHorizon.get(r.horizonDays) ?? null,
    verdict: classify({
      trainAvg: r.trainAvgPct,
      testAvg: r.testAvgPct,
      trainN: r.trainTrades,
      testN: r.testTrades,
      controlAvg: baseByHorizon.get(r.horizonDays),
      minTrades
    })
  }));
}
