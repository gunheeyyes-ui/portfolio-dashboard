import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MARKET_INDEX_SCHEMA = "market-index-history-v1";
export const MARKET_INDEX_CODES = {
  KOSPI: "0001",
  KOSDAQ: "1001"
};

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function numberOrNull(value) {
  return finite(value) ? Number(value) : null;
}

function ensureParent(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function atomicWrite(filePath, content) {
  ensureParent(filePath);
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content, "utf8");
  renameSync(temp, filePath);
}

function normalizeBar(row) {
  const date = String(row?.date ?? "");
  if (!/^\d{8}$/.test(date) || !finite(row?.close)) return null;
  return {
    date,
    open: numberOrNull(row.open),
    high: numberOrNull(row.high),
    low: numberOrNull(row.low),
    close: Number(row.close),
    volume: numberOrNull(row.volume)
  };
}

export function mergeMarketBars(existing = [], incoming = []) {
  const byDate = new Map();
  for (const row of [...existing, ...incoming]) {
    const normalized = normalizeBar(row);
    if (!normalized) continue;
    byDate.set(normalized.date, normalized);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function createMarketIndexTracker({ file }) {
  function read() {
    if (!existsSync(file)) {
      return {
        schemaVersion: MARKET_INDEX_SCHEMA,
        updatedAt: null,
        markets: { KOSPI: [], KOSDAQ: [] }
      };
    }
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      return {
        schemaVersion: parsed.schemaVersion ?? MARKET_INDEX_SCHEMA,
        updatedAt: parsed.updatedAt ?? null,
        markets: {
          KOSPI: mergeMarketBars([], parsed.markets?.KOSPI ?? []),
          KOSDAQ: mergeMarketBars([], parsed.markets?.KOSDAQ ?? [])
        }
      };
    } catch {
      return {
        schemaVersion: MARKET_INDEX_SCHEMA,
        updatedAt: null,
        markets: { KOSPI: [], KOSDAQ: [] }
      };
    }
  }

  function mergeMany(byMarket, { updatedAt = new Date().toISOString() } = {}) {
    const current = read();
    const next = {
      schemaVersion: MARKET_INDEX_SCHEMA,
      updatedAt,
      markets: {
        KOSPI: mergeMarketBars(current.markets.KOSPI, byMarket?.KOSPI ?? []),
        KOSDAQ: mergeMarketBars(current.markets.KOSDAQ, byMarket?.KOSDAQ ?? [])
      }
    };
    atomicWrite(file, `${JSON.stringify(next)}\n`);
    return next;
  }

  function diagnostics() {
    const data = read();
    return {
      schemaVersion: data.schemaVersion,
      updatedAt: data.updatedAt,
      counts: Object.fromEntries(Object.entries(data.markets).map(([market, rows]) => [market, rows.length])),
      firstDate: Object.fromEntries(Object.entries(data.markets).map(([market, rows]) => [market, rows[0]?.date ?? null])),
      lastDate: Object.fromEntries(Object.entries(data.markets).map(([market, rows]) => [market, rows.at(-1)?.date ?? null]))
    };
  }

  return { read, mergeMany, diagnostics };
}
