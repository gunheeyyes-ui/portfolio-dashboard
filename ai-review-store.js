import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

export const AI_REVIEW_STORE_VERSION = "ai-review-store-v1";

function ensureParent(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function atomicJsonWrite(filePath, value) {
  ensureParent(filePath);
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  renameSync(temp, filePath);
}

function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function avg(values) {
  const valid = values.filter(finite).map(Number);
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function winRate(values) {
  const valid = values.filter(finite).map(Number);
  if (!valid.length) return null;
  return valid.filter((value) => value > 0).length / valid.length * 100;
}

function verdictBucket(verdict) {
  if (["STRONG_POSITIVE", "POSITIVE"].includes(verdict)) return "positive";
  if (verdict === "NEUTRAL") return "neutral";
  return "negative";
}

export function createAiReviewStore({ dataDir }) {
  const cacheFile = path.join(dataDir, "ai-review-cache.json");
  const historyFile = path.join(dataDir, "ai-review-history.jsonl");
  const summaryFile = path.join(dataDir, "ai-review-summary.json");
  const strategyHistoryFile = path.join(dataDir, "strategy-oos-history.jsonl");

  function readCache() {
    return readJson(cacheFile, { version: AI_REVIEW_STORE_VERSION, batches: {} });
  }

  function getBatch(batchKey) {
    return readCache().batches?.[batchKey] ?? null;
  }

  function saveBatch(batchKey, batch) {
    const cache = readCache();
    cache.version = AI_REVIEW_STORE_VERSION;
    cache.batches = cache.batches || {};
    cache.batches[batchKey] = batch;
    atomicJsonWrite(cacheFile, cache);
    return batch;
  }

  function dailyBatchCount(signalDate) {
    const cache = readCache();
    return Object.values(cache.batches ?? {}).filter((batch) => batch?.signalDate === signalDate).length;
  }

  function recordBatchOnce(batch) {
    if (!batch?.recordEligible) return { recorded: false, reason: "NOT_EOD_ELIGIBLE" };
    const existing = readJsonl(historyFile);
    const existingKeys = new Set(existing.map((row) => `${row.signalDate}:${row.code}`));
    const newRows = [];
    for (const review of batch.reviews ?? []) {
      const key = `${batch.signalDate}:${review.code}`;
      if (existingKeys.has(key)) continue;
      newRows.push({
        schemaVersion: "ai-review-history-v1",
        signalDate: batch.signalDate,
        reviewedAt: batch.createdAt,
        code: review.code,
        name: batch.candidateByCode?.[review.code]?.name ?? "",
        market: batch.candidateByCode?.[review.code]?.market ?? null,
        candidateLabel: batch.candidateByCode?.[review.code]?.candidateLabel ?? "unknown",
        model: batch.model,
        inputHash: batch.inputHash,
        verdict: review.verdict,
        confidence: review.confidence,
        bullCase: review.bull_case,
        bearCase: review.bear_case,
        keyRisks: review.key_risks,
        invalidation: review.invalidation,
        summary: review.summary
      });
    }
    if (!newRows.length) return { recorded: false, reason: "ALREADY_RECORDED" };
    ensureParent(historyFile);
    appendFileSync(historyFile, `${newRows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    return { recorded: true, reason: "RECORDED", count: newRows.length };
  }

  function buildSummary() {
    const reviews = readJsonl(historyFile);
    const strategyRows = readJsonl(strategyHistoryFile);
    const strategyByKey = new Map(strategyRows.map((row) => [`${row.signalDate}:${row.code}`, row]));
    const joined = reviews.map((review) => {
      const performance = strategyByKey.get(`${review.signalDate}:${review.code}`);
      return {
        ...review,
        bucket: verdictBucket(review.verdict),
        outcomes: {
          "3": performance?.outcomes?.["3"]?.netReturnPct ?? null,
          "5": performance?.outcomes?.["5"]?.netReturnPct ?? null,
          "10": performance?.outcomes?.["10"]?.netReturnPct ?? null
        }
      };
    });

    const definitions = [
      ["all", () => true],
      ["core", (row) => row.candidateLabel === "core"],
      ["strong", (row) => row.candidateLabel === "strong"],
      ["positive", (row) => row.bucket === "positive"],
      ["neutral", (row) => row.bucket === "neutral"],
      ["negative", (row) => row.bucket === "negative"],
      ["core_positive", (row) => row.candidateLabel === "core" && row.bucket === "positive"],
      ["strong_positive", (row) => row.candidateLabel === "strong" && row.bucket === "positive"]
    ];

    const groups = {};
    for (const [id, selector] of definitions) {
      const rows = joined.filter(selector);
      groups[id] = {
        n: rows.length,
        confidenceAvg: avg(rows.map((row) => row.confidence)),
        horizons: Object.fromEntries([3, 5, 10].map((horizon) => {
          const values = rows.map((row) => row.outcomes[String(horizon)]);
          const completed = values.filter(finite);
          return [String(horizon), {
            n: completed.length,
            avgReturnPct: avg(values),
            winRatePct: winRate(values)
          }];
        }))
      };
    }

    const summary = {
      schemaVersion: "ai-review-summary-v1",
      generatedAt: new Date().toISOString(),
      totalReviews: reviews.length,
      groups,
      recent: joined.slice(-30).reverse()
    };
    atomicJsonWrite(summaryFile, summary);
    return summary;
  }

  return {
    paths: { cacheFile, historyFile, summaryFile, strategyHistoryFile },
    getBatch,
    saveBatch,
    dailyBatchCount,
    recordBatchOnce,
    buildSummary
  };
}
