// Outcome metrics for V3. Kept numerically identical to Backtest Lab V2 so
// V3 results stay comparable with the existing V2 result files.

export function sum(values) {
  return values.filter(Number.isFinite).reduce((s, x) => s + x, 0);
}

export function avg(values) {
  const v = values.filter(Number.isFinite);
  return v.length ? sum(v) / v.length : null;
}

export function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export function rnd(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

export function pct(part, total) {
  return total ? rnd((part / total) * 100) : null;
}

/**
 * One trade per code at a time: a new signal is skipped while the previous
 * position for that code is still open. Without this a stock that qualifies
 * every day would be counted as a fresh trade every day.
 */
export function applyPerCodeCooldown(rows, horizonDays) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
  const lastExitByCode = new Map();
  const out = [];
  for (const r of sorted) {
    const last = lastExitByCode.get(r.code);
    const entryDate = r[`entryDate${horizonDays}`];
    const exitDate = r[`exitDate${horizonDays}`];
    if (!entryDate || !exitDate) continue;
    if (last && entryDate <= last) continue;
    out.push(r);
    lastExitByCode.set(r.code, exitDate);
  }
  return out;
}

export function metricBlock(rows, h) {
  const returns = rows.map((r) => r[`r${h}`]).filter(Number.isFinite);
  const mfes = rows.map((r) => r[`mfe${h}`]).filter(Number.isFinite);
  const maes = rows.map((r) => r[`mae${h}`]).filter(Number.isFinite);
  const excess = rows.map((r) => r[`x${h}`]).filter(Number.isFinite);
  const wins = returns.filter((x) => x > 0);
  const losses = returns.filter((x) => x <= 0);
  const gp = sum(wins);
  const gl = Math.abs(sum(losses));
  return {
    observations: returns.length,
    winRatePct: pct(wins.length, returns.length),
    avgReturnPct: rnd(avg(returns)),
    medianReturnPct: rnd(median(returns)),
    profitFactor: gl ? rnd(gp / gl, 2) : null,
    expectancyPct: rnd(avg(returns)),
    avgExcessPct: rnd(avg(excess)),
    avgMfePct: rnd(avg(mfes)),
    avgMaePct: rnd(avg(maes)),
    hitPlus3Pct: pct(mfes.filter((x) => x >= 3).length, mfes.length),
    hitPlus5Pct: pct(mfes.filter((x) => x >= 5).length, mfes.length),
    hitMinus3Pct: pct(maes.filter((x) => x <= -3).length, maes.length),
    hitMinus5Pct: pct(maes.filter((x) => x <= -5).length, maes.length)
  };
}

export function strategyMetricBlock(rows, h) {
  const base = metricBlock(rows, h);
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  let equity = 1;
  let peak = 1;
  let mdd = 0;
  for (const r of sorted) {
    equity *= 1 + (r[`r${h}`] || 0) / 100;
    peak = Math.max(peak, equity);
    mdd = Math.min(mdd, equity / peak - 1);
  }
  return { trades: base.observations, ...base, maxDrawdownPct: rnd(mdd * 100) };
}

/**
 * Classifies a result the way the brief asks: never call the top row "best".
 * `neighbours` are the same filter at adjacent thresholds, when it has any.
 */
export function classify({ trainAvg, testAvg, trainN, testN, controlAvg, neighbourAvgs = [], minTrades }) {
  if ((testN ?? 0) < minTrades || (trainN ?? 0) < minTrades) return "표본부족";
  if (Number.isFinite(controlAvg) && Number.isFinite(testAvg) && testAvg < controlAvg) return "역효과";
  const gap = Number.isFinite(trainAvg) && Number.isFinite(testAvg) ? trainAvg - testAvg : null;
  if (Number.isFinite(gap) && trainAvg > 0 && testAvg <= 0) return "과최적화 위험";
  const usable = neighbourAvgs.filter(Number.isFinite);
  if (usable.length >= 2 && Number.isFinite(testAvg)) {
    const allHold = usable.every((v) => v >= testAvg * 0.5 && v > 0);
    if (allHold && testAvg > 0) return "견고 가능성";
  }
  if (Number.isFinite(testAvg) && testAvg > 0) return "유망";
  return "중립";
}

export function splitSamples(rows, splitDate) {
  return {
    ALL: rows,
    TRAIN: rows.filter((r) => r.date < splitDate),
    TEST: rows.filter((r) => r.date >= splitDate)
  };
}
