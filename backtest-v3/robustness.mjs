// Robustness layer for V3. Nothing here changes how a signal is produced —
// it re-measures the same trades in ways that can break a flattering result:
// different weightings, outliers removed, other time windows, other cooldowns,
// and a benchmark that removes the market move the trade would have got anyway.

import { evaluate } from "./filters.mjs";
import { applyPerCodeCooldown, metricBlock, avg, median, rnd, pct, sum } from "./metrics.mjs";

// ---------------------------------------------------------------- benchmarks

/**
 * Same-date, same-market benchmark: what the average stock in that market
 * did over the identical window. Absolute returns in a bull market flatter
 * everything, so `x{h}` is the number that actually says "better than the
 * rest of the market that day".
 */
export function attachSameDateBenchmark(observations, holds) {
  const groups = new Map();
  for (const row of observations) {
    const key = `${row.date}|${row.market}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const rows of groups.values()) {
    for (const h of holds) {
      const bench = avg(rows.map((r) => r[`r${h}`]));
      for (const r of rows) {
        r[`bench${h}`] = Number.isFinite(bench) ? rnd(bench) : null;
        r[`x${h}`] = Number.isFinite(r[`r${h}`]) && Number.isFinite(bench) ? rnd(r[`r${h}`] - bench) : null;
      }
    }
  }
  return observations;
}

// ---------------------------------------------------------------- resampling

/** One trade per code — the first signal only. Kills repeat-signal dominance. */
export function firstSignalPerCode(rows) {
  const seen = new Set();
  return [...rows].sort((a, b) => a.date.localeCompare(b.date)).filter((r) => {
    if (seen.has(r.code)) return false;
    seen.add(r.code);
    return true;
  });
}

/** Average per code, then across codes: every stock counts once. */
export function equalWeightBy(rows, keyField, valueField) {
  const groups = new Map();
  for (const r of rows) {
    const v = r[valueField];
    if (!Number.isFinite(v)) continue;
    if (!groups.has(r[keyField])) groups.set(r[keyField], []);
    groups.get(r[keyField]).push(v);
  }
  const perKey = [...groups.entries()].map(([key, vals]) => ({ key, mean: avg(vals), n: vals.length }));
  return { groups: perKey.length, mean: rnd(avg(perKey.map((p) => p.mean))), perKey };
}

/** Drops the best `topPct` of returns to see whether a few spikes carried it. */
export function trimTop(rows, valueField, topPct) {
  const usable = rows.filter((r) => Number.isFinite(r[valueField]));
  const sorted = [...usable].sort((a, b) => b[valueField] - a[valueField]);
  const cut = Math.floor(sorted.length * (topPct / 100));
  return sorted.slice(cut);
}

/**
 * Re-measures one trade set five ways. A result is only worth trusting when
 * all five stay positive — that is what `potentiallyRobust` means here.
 */
export function resampleAudit(rows, h) {
  const field = `r${h}`;
  const xField = `x${h}`;
  const usable = rows.filter((r) => Number.isFinite(r[field]));
  const base = metricBlock(usable, h);
  const firstOnly = firstSignalPerCode(usable);
  const byCode = equalWeightBy(usable, "code", field);
  const byDate = equalWeightBy(usable, "date", field);
  const trim1 = trimTop(usable, field, 1);
  const trim5 = trimTop(usable, field, 5);
  const variants = {
    all: { n: usable.length, mean: base.avgReturnPct },
    firstSignalOnly: { n: firstOnly.length, mean: rnd(avg(firstOnly.map((r) => r[field]))) },
    equalWeightByCode: { n: byCode.groups, mean: byCode.mean },
    equalWeightByDate: { n: byDate.groups, mean: byDate.mean },
    trimTop1: { n: trim1.length, mean: rnd(avg(trim1.map((r) => r[field]))) },
    trimTop5: { n: trim5.length, mean: rnd(avg(trim5.map((r) => r[field]))) }
  };
  // "All positive" is too weak a bar: a variant that collapses to ~0 while
  // the headline stays high means a few codes or a few dates carried the
  // result. The weakest variant must also retain a quarter of the headline.
  const means = Object.values(variants).map((v) => v.mean);
  const allPositive = means.every((v) => Number.isFinite(v) && v > 0);
  const headline = variants.all.mean;
  const weakest = Math.min(...means.filter(Number.isFinite));
  const retainsMargin = Number.isFinite(headline) && headline > 0
    ? weakest >= headline * 0.25
    : false;
  const weakestVariant = Object.entries(variants)
    .filter(([, v]) => Number.isFinite(v.mean))
    .sort((a, b) => a[1].mean - b[1].mean)[0]?.[0] ?? null;
  return {
    ...variants,
    weakestVariant,
    weakestMean: rnd(weakest),
    retainsMargin,
    medianPct: base.medianReturnPct,
    winRatePct: base.winRatePct,
    profitFactor: base.profitFactor,
    avgMfePct: base.avgMfePct,
    avgMaePct: base.avgMaePct,
    avgExcessPct: rnd(avg(usable.map((r) => r[xField]))),
    allVariantsPositive: allPositive,
    potentiallyRobust: allPositive && retainsMargin
  };
}

// ------------------------------------------------------------ concentration

/**
 * How much of the total return came from the few best names. A strategy that
 * collapses once its top 5 codes are removed is not a strategy, it is those
 * five stocks.
 */
export function concentration(rows, h) {
  const field = `r${h}`;
  const usable = rows.filter((r) => Number.isFinite(r[field]));
  const total = sum(usable.map((r) => r[field]));
  const byCode = new Map();
  for (const r of usable) byCode.set(r.code, (byCode.get(r.code) ?? 0) + r[field]);
  const ranked = [...byCode.entries()]
    .map(([code, contribution]) => ({ code, contribution }))
    .sort((a, b) => b.contribution - a.contribution);
  const share = (n) => (total ? rnd((sum(ranked.slice(0, n).map((r) => r.contribution)) / total) * 100) : null);
  const top5Codes = new Set(ranked.slice(0, 5).map((r) => r.code));
  const without = usable.filter((r) => !top5Codes.has(r.code));
  const name = (code) => usable.find((r) => r.code === code)?.name ?? code;
  return {
    codes: byCode.size,
    top1SharePct: share(1),
    top5SharePct: share(5),
    top10SharePct: share(10),
    top1Code: ranked[0] ? `${name(ranked[0].code)}(${ranked[0].code})` : null,
    top5Codes: ranked.slice(0, 5).map((r) => `${name(r.code)}`).join(", "),
    excludeTop5N: without.length,
    excludeTop5MeanPct: rnd(avg(without.map((r) => r[field]))),
    excludeTop5ExcessPct: rnd(avg(without.map((r) => r[`x${h}`]))),
    concentrationWarning: (share(5) ?? 0) > 60
  };
}

// ------------------------------------------------------------- walk-forward

/**
 * Rolling out-of-sample folds. One good fold proves nothing; the point is
 * how many folds stay positive and how bad the worst one is.
 */
export function buildFolds(dates, foldCount = 3) {
  const sorted = [...new Set(dates)].sort();
  if (sorted.length < 60) return [];
  const testSpan = Math.floor(sorted.length / (foldCount + 2));
  const folds = [];
  for (let i = 0; i < foldCount; i += 1) {
    const testStartIdx = sorted.length - testSpan * (foldCount - i);
    const testEndIdx = testStartIdx + testSpan - 1;
    if (testStartIdx <= 0) continue;
    folds.push({
      name: `Fold${i + 1}`,
      trainFrom: sorted[0],
      trainTo: sorted[testStartIdx - 1],
      testFrom: sorted[testStartIdx],
      testTo: sorted[Math.min(testEndIdx, sorted.length - 1)]
    });
  }
  return folds;
}

export function runWalkForward(rows, condition, folds, h, { mode = "cooldown" } = {}) {
  const matched = rows.filter((r) => evaluate(condition, r));
  const results = folds.map((fold) => {
    const inFold = matched.filter((r) => r.date >= fold.testFrom && r.date <= fold.testTo);
    const pool = mode === "cooldown" ? applyPerCodeCooldown(inFold, h) : inFold;
    const m = metricBlock(pool, h);
    return {
      fold: fold.name,
      testFrom: fold.testFrom,
      testTo: fold.testTo,
      n: m.observations,
      meanPct: m.avgReturnPct,
      excessPct: rnd(avg(pool.map((r) => r[`x${h}`])))
    };
  });
  const excesses = results.map((r) => r.excessPct).filter(Number.isFinite);
  const positive = excesses.filter((v) => v > 0).length;
  return {
    folds: results,
    foldsPositive: positive,
    foldsTotal: excesses.length,
    worstFoldExcessPct: excesses.length ? rnd(Math.min(...excesses)) : null,
    meanFoldExcessPct: rnd(avg(excesses)),
    stability: excesses.length === 0 ? "표본부족"
      : positive === excesses.length ? "robust candidate"
        : positive <= 1 ? "unstable" : "mixed"
  };
}

// ------------------------------------------------------ cooldown sensitivity

/** Cooldown expressed in calendar days between entries for the same code. */
function applyDayCooldown(rows, days) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
  const lastByCode = new Map();
  const out = [];
  for (const r of sorted) {
    const last = lastByCode.get(r.code);
    if (last) {
      const gap = (Date.parse(fmtDate(r.date)) - Date.parse(fmtDate(last))) / 86400000;
      if (gap < days) continue;
    }
    out.push(r);
    lastByCode.set(r.code, r.date);
  }
  return out;
}

function fmtDate(ymd) {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`;
}

export function cooldownSensitivity(rows, condition, h) {
  const matched = rows.filter((r) => evaluate(condition, r));
  const variants = {
    "cooldown0": matched,
    "cooldown3": applyDayCooldown(matched, 3),
    "cooldown5": applyDayCooldown(matched, 5),
    "cooldown10": applyDayCooldown(matched, 10),
    "holdingCooldown": applyPerCodeCooldown(matched, h),
    "firstSignalOnly": firstSignalPerCode(matched)
  };
  const out = {};
  for (const [key, pool] of Object.entries(variants)) {
    const m = metricBlock(pool, h);
    out[key] = { n: m.observations, meanPct: m.avgReturnPct, excessPct: rnd(avg(pool.map((r) => r[`x${h}`]))) };
  }
  const means = Object.values(out).map((v) => v.excessPct).filter(Number.isFinite);
  out.verdict = means.length && means.every((v) => v > 0) ? "cooldown 무관 안정"
    : means.some((v) => v > 0) ? "cooldown 민감 — 주의" : "전 구간 열위";
  return out;
}

// --------------------------------------------------- corporate action checks

/**
 * Flags bars whose overnight move is too large to be an ordinary price move.
 * Without a corporate-action feed this cannot prove a split or a merger, so
 * suspects are reported as POSSIBLE CORPORATE ACTION and never as fact.
 */
export function detectCorporateActions(seriesByCode, universe, threshold = 40) {
  const suspects = [];
  const nameByCode = new Map(universe.map((u) => [u.code, u.name]));
  for (const [code, series] of seriesByCode) {
    for (let i = 1; i < series.length; i += 1) {
      const prev = series[i - 1];
      const cur = series[i];
      if (!prev?.close || !cur?.open || !cur?.close) continue;
      const overnightPct = (cur.open / prev.close - 1) * 100;
      const closePct = (cur.close / prev.close - 1) * 100;
      if (Math.abs(overnightPct) >= threshold || Math.abs(closePct) >= threshold) {
        suspects.push({
          code,
          name: nameByCode.get(code) ?? code,
          date: cur.date,
          prevClose: prev.close,
          open: cur.open,
          close: cur.close,
          overnightPct: rnd(overnightPct),
          closeToClosePct: rnd(closePct),
          ratio: rnd(prev.close / cur.close, 3),
          note: "POSSIBLE CORPORATE ACTION (분할/병합/무상증자/감자 여부는 확인 불가)"
        });
      }
    }
  }
  return suspects;
}

/** Codes to exclude, plus a window around each suspect date. */
export function suspectWindows(suspects, windowDays = 90) {
  const byCode = new Map();
  for (const s of suspects) {
    if (!byCode.has(s.code)) byCode.set(s.code, []);
    byCode.get(s.code).push(s.date);
  }
  return (row) => {
    const dates = byCode.get(row.code);
    if (!dates) return false;
    return dates.some((d) => {
      const gap = Math.abs(Date.parse(fmtDate(row.date)) - Date.parse(fmtDate(d))) / 86400000;
      return gap <= windowDays;
    });
  };
}

export { avg, median, rnd, pct, sum };
