// RS(20D): cross-sectional percentile rank (0-99) of each stock's trailing
// 20-trading-day return within its own market (KOSPI or KOSDAQ) on the same
// date. Higher = stronger than same-market peers over the last 20 sessions.
//
// This is supplemental display-only information. Per the 2026-08 backtest on
// backtest-cache-v2 (KOSPI100+KOSDAQ100, 95,596 observations, train/test
// split, next-open entry, 0.23% round-trip cost), RS20 was informative as an
// independent display metric but showed no reliable, consistent edge when
// added into T1-T6 Ranking V2 tier/score logic (neutral to negative in some
// regimes). It must never be added into Ranking V2 scoring, tiering, or
// default sort order.
//
// No look-ahead: ret20 must be computed only from close prices up to and
// including the "as of" trading day being scored; never using data from
// later dates.

/**
 * @param {Array<{code: string, market: "KOSPI"|"KOSDAQ", ret20: number|null|undefined}>} rows
 * @returns {Map<string, number>} code -> RS20 percentile (0-99), integer.
 *   Rows with a missing/non-finite ret20 or missing market are omitted from
 *   the result (no entry = "missing", not 0).
 */
export function buildRelativeStrength20(rows) {
  const byMarket = new Map();
  for (const row of rows ?? []) {
    if (!row || !row.market || !row.code) continue;
    if (row.ret20 === null || row.ret20 === undefined) continue;
    const ret20 = Number(row.ret20);
    if (!Number.isFinite(ret20)) continue;
    if (!byMarket.has(row.market)) byMarket.set(row.market, []);
    byMarket.get(row.market).push({ code: row.code, ret20 });
  }

  const result = new Map();
  for (const group of byMarket.values()) {
    const n = group.length;
    if (n === 0) continue;
    const sorted = [...group].sort((a, b) => a.ret20 - b.ret20);
    if (n === 1) {
      result.set(sorted[0].code, 50);
      continue;
    }
    // Average-rank percentile so tied ret20 values get the same RS.
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && sorted[j + 1].ret20 === sorted[i].ret20) j += 1;
      const avgIndex = (i + j) / 2;
      const percentile = Math.round((avgIndex / (n - 1)) * 99);
      for (let k = i; k <= j; k += 1) result.set(sorted[k].code, percentile);
      i = j + 1;
    }
  }
  return result;
}

export function rs20Tone(rs20) {
  if (!Number.isFinite(rs20)) return "muted";
  if (rs20 >= 90) return "rs-strong";
  if (rs20 >= 80) return "rs-good";
  if (rs20 >= 70) return "rs-mild";
  if (rs20 >= 40) return "rs-neutral";
  return "rs-weak";
}
