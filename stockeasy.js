// Supplemental "is this stock currently held by an external StockEasy
// strategy room" badge data. Read-only, informational only: never used by
// Ranking V2 tiering/scoring/sort, never blocks the request/render path.
//
// Source: https://stockeasy.intellio.kr strategy rooms (Momentum/Peak/Value
// Easy), via the public JSON endpoint their own pages call:
//   GET https://stockeasy.intellio.kr/stockdata/api/v1/portfolio/{id}/holdings
// id 1 = Momentum Easy, 2 = Peak Easy, 3 = Value Easy. No auth required.

const ENDPOINT_BASE = "https://stockeasy.intellio.kr/stockdata/api/v1/portfolio";
const PORTFOLIOS = [
  { id: 1, key: "momentum" },
  { id: 2, key: "peak" },
  { id: 3, key: "value" }
];
const FETCH_TIMEOUT_MS = 8000;
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes; source updates roughly daily.

/**
 * Pure parsing: turn the raw StockEasy holdings JSON into a Set of exact
 * 6-digit stock codes. No fuzzy name matching — a stock is only counted if
 * a code is present. Never throws on malformed input; returns an empty set.
 */
export function extractHoldingCodes(payload) {
  const codes = new Set();
  const holdings = payload?.holdings;
  if (!holdings || typeof holdings !== "object") return codes;
  for (const sector of Object.values(holdings)) {
    if (!Array.isArray(sector)) continue;
    for (const item of sector) {
      const code = item?.stock_code;
      if (typeof code === "string" && /^\d{6}$/.test(code)) codes.add(code);
    }
  }
  return codes;
}

async function fetchPortfolioCodes(id, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${ENDPOINT_BASE}/${id}/holdings`, {
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; portfolio-dashboard/1.0)" }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    if (payload?.success !== true) throw new Error("success:false");
    return extractHoldingCodes(payload);
  } finally {
    clearTimeout(timer);
  }
}

function emptyState() {
  return {
    fetchedAt: null,
    stale: true,
    momentum: { codes: new Set(), ok: false, count: 0, error: "not fetched yet" },
    peak: { codes: new Set(), ok: false, count: 0, error: "not fetched yet" },
    value: { codes: new Set(), ok: false, count: 0, error: "not fetched yet" }
  };
}

/**
 * Creates a fail-soft, stale-while-revalidate cache. `refresh()` fetches all
 * three portfolios in parallel and updates the in-memory state; a source
 * that fails keeps its previous codes/error rather than clearing them, so a
 * StockEasy outage never removes badges that were correct moments ago.
 * `refresh()` is intended to run on a background interval, never awaited by
 * a request handler.
 */
export function createStockEasyCache({ ttlMs = DEFAULT_TTL_MS, fetchImpl = fetch, log = () => {} } = {}) {
  let state = emptyState();
  let refreshing = null;

  async function refreshOne(portfolio) {
    try {
      const codes = await fetchPortfolioCodes(portfolio.id, fetchImpl);
      return { key: portfolio.key, codes, ok: true, count: codes.size, error: null };
    } catch (error) {
      const previous = state[portfolio.key];
      log(`StockEasy ${portfolio.key} refresh failed: ${error.message}`);
      return {
        key: portfolio.key,
        codes: previous?.codes ?? new Set(),
        ok: false,
        count: previous?.codes?.size ?? 0,
        error: error.message
      };
    }
  }

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const results = await Promise.all(PORTFOLIOS.map(refreshOne));
      const next = { ...state, fetchedAt: new Date().toISOString(), stale: false };
      for (const result of results) {
        next[result.key] = { codes: result.codes, ok: result.ok, count: result.count, error: result.error };
      }
      next.stale = results.some((result) => !result.ok) && !results.some((result) => result.ok && result.count > 0 && !state[result.key]?.ok);
      state = next;
      return state;
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  function isExpired() {
    if (!state.fetchedAt) return true;
    return Date.now() - new Date(state.fetchedAt).getTime() > ttlMs;
  }

  /** Best-effort kick-off; never awaited by callers on the request path. */
  function ensureFresh() {
    if (isExpired() && !refreshing) refresh().catch(() => {});
  }

  function badgesFor(code) {
    return {
      seMomentum: state.momentum.codes.has(code),
      sePeak: state.peak.codes.has(code),
      seValue: state.value.codes.has(code)
    };
  }

  /** Raw code sets, for diagnostics (e.g. computing unmatched codes). */
  function codeSets() {
    return { momentum: state.momentum.codes, peak: state.peak.codes, value: state.value.codes };
  }

  function diagnostics() {
    const ageMs = state.fetchedAt ? Date.now() - new Date(state.fetchedAt).getTime() : null;
    return {
      fetchedAt: state.fetchedAt,
      cacheAgeSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
      stale: isExpired(),
      momentum: { ok: state.momentum.ok, count: state.momentum.count, error: state.momentum.error },
      peak: { ok: state.peak.ok, count: state.peak.count, error: state.peak.error },
      value: { ok: state.value.ok, count: state.value.count, error: state.value.error }
    };
  }

  return { refresh, ensureFresh, badgesFor, codeSets, diagnostics, ttlMs };
}
