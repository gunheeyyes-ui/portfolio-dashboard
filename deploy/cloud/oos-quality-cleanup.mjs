import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildRankingLiveSummary } from "../../ranking-live-tracker.js";
import { buildStrategyOosSummary, missingSnapshotDates } from "../../strategy-oos-tracker.js";

const DEFAULT_TARGET_DATE = "2026-09-15";
const DEFAULT_MIN_MARKET_ROWS = 80;

function readJson(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readJsonlStrict(filePath) {
  if (!existsSync(filePath)) return [];
  const rows = [];
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${path.basename(filePath)}:${index + 1} invalid JSON: ${error.message}`);
    }
  }
  return rows;
}

function jsonl(rows) {
  return rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
}

function atomicWrite(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, content, "utf8");
  renameSync(tempPath, filePath);
}

function isoStamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function lastRecordedAt(records) {
  return records.map((row) => row?.recordedAt).filter(Boolean).sort().at(-1) ?? null;
}

export function quarantineIncompleteOosDate({
  dataDir,
  targetDate = DEFAULT_TARGET_DATE,
  minMarketRows = DEFAULT_MIN_MARKET_ROWS,
  now = () => new Date()
}) {
  const files = {
    strategyHistory: path.join(dataDir, "strategy-oos-history.jsonl"),
    strategySelections: path.join(dataDir, "strategy-oos-selections.jsonl"),
    strategyState: path.join(dataDir, "strategy-oos-state.json"),
    strategySummary: path.join(dataDir, "strategy-oos-summary.json"),
    rankingHistory: path.join(dataDir, "ranking-live-history.jsonl"),
    rankingSummary: path.join(dataDir, "ranking-live-summary.json")
  };

  const state = readJson(files.strategyState, null);
  if (!state) return { changed: false, reason: "NO_STRATEGY_STATE", targetDate };

  const diagnostics = state.diagnostics?.[targetDate] ?? null;
  const kospiCount = Number(diagnostics?.marketCounts?.KOSPI);
  const kosdaqCount = Number(diagnostics?.marketCounts?.KOSDAQ);
  if (!Number.isFinite(kospiCount) || !Number.isFinite(kosdaqCount)) {
    return { changed: false, reason: "INCOMPLETE_NOT_PROVEN", targetDate };
  }
  if (kospiCount >= minMarketRows && kosdaqCount >= minMarketRows) {
    return { changed: false, reason: "SNAPSHOT_QUALITY_OK", targetDate, marketCounts: { KOSPI: kospiCount, KOSDAQ: kosdaqCount } };
  }

  const strategyRecords = readJsonlStrict(files.strategyHistory);
  const strategySelections = readJsonlStrict(files.strategySelections);
  const rankingRecords = readJsonlStrict(files.rankingHistory);
  const removed = {
    strategyRecords: strategyRecords.filter((row) => row.signalDate === targetDate).length,
    strategySelections: strategySelections.filter((row) => row.signalDate === targetDate).length,
    rankingRecords: rankingRecords.filter((row) => row.signalDate === targetDate).length
  };
  const stateHasDate = (state.recordedDates ?? []).includes(targetDate) || Boolean(state.diagnostics?.[targetDate]);
  if (!stateHasDate && Object.values(removed).every((count) => count === 0)) {
    return { changed: false, reason: "ALREADY_CLEAN", targetDate };
  }

  const nextStrategyRecords = strategyRecords.filter((row) => row.signalDate !== targetDate);
  const nextStrategySelections = strategySelections.filter((row) => row.signalDate !== targetDate);
  const nextRankingRecords = rankingRecords.filter((row) => row.signalDate !== targetDate);
  const recordedDates = (state.recordedDates ?? []).filter((date) => date !== targetDate).sort();
  const nextDiagnostics = { ...(state.diagnostics ?? {}) };
  delete nextDiagnostics[targetDate];
  const at = now().toISOString();
  const quarantineEvent = {
    at,
    reason: "QUARANTINED_INCOMPLETE_MARKET_REFRESH",
    signalDate: targetDate,
    marketCounts: { KOSPI: kospiCount, KOSDAQ: kosdaqCount },
    removed
  };
  const nextState = {
    ...state,
    recordedDates,
    missingSnapshotDates: missingSnapshotDates(recordedDates),
    lastSnapshotAt: lastRecordedAt(nextStrategyRecords),
    diagnostics: nextDiagnostics,
    skipped: [...(state.skipped ?? []), quarantineEvent].slice(-50),
    quarantinedSnapshots: [...(state.quarantinedSnapshots ?? []), quarantineEvent].slice(-50)
  };

  const nextStrategySummary = buildStrategyOosSummary(nextStrategyRecords, nextStrategySelections, {
    state: nextState,
    generatedAt: at
  });
  const nextRankingSummary = buildRankingLiveSummary(nextRankingRecords, { invalidLines: 0 });

  const backupDir = path.join(dataDir, "integrity-backups", `${targetDate.replaceAll("-", "")}-${isoStamp(now())}`);
  mkdirSync(backupDir, { recursive: true });
  const existed = new Map();
  for (const filePath of Object.values(files)) {
    const present = existsSync(filePath);
    existed.set(filePath, present);
    if (present) copyFileSync(filePath, path.join(backupDir, path.basename(filePath)));
  }

  const replacements = new Map([
    [files.strategyHistory, jsonl(nextStrategyRecords)],
    [files.strategySelections, jsonl(nextStrategySelections)],
    [files.strategyState, `${JSON.stringify(nextState, null, 2)}\n`],
    [files.strategySummary, `${JSON.stringify(nextStrategySummary)}\n`],
    [files.rankingHistory, jsonl(nextRankingRecords)],
    [files.rankingSummary, `${JSON.stringify(nextRankingSummary, null, 2)}\n`]
  ]);

  try {
    for (const [filePath, content] of replacements) atomicWrite(filePath, content);
    appendFileSync(path.join(dataDir, "oos-quarantine-log.jsonl"), `${JSON.stringify({ ...quarantineEvent, backupDir })}\n`, "utf8");
  } catch (error) {
    for (const filePath of Object.values(files)) {
      const backupPath = path.join(backupDir, path.basename(filePath));
      if (existsSync(backupPath)) copyFileSync(backupPath, filePath);
      else if (!existed.get(filePath) && existsSync(filePath)) rmSync(filePath, { force: true });
    }
    throw error;
  }

  return {
    changed: true,
    reason: "QUARANTINED_INCOMPLETE_MARKET_REFRESH",
    targetDate,
    marketCounts: { KOSPI: kospiCount, KOSDAQ: kosdaqCount },
    removed,
    backupDir
  };
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const dataDir = path.resolve(process.env.DASHBOARD_DATA_DIR || "/var/lib/portfolio-dashboard");
  const targetDate = process.env.OOS_QUARANTINE_DATE || DEFAULT_TARGET_DATE;
  const minMarketRows = Math.max(10, Number(process.env.CLOUD_MIN_MARKET_ROWS || DEFAULT_MIN_MARKET_ROWS));
  const result = quarantineIncompleteOosDate({ dataDir, targetDate, minMarketRows });
  console.log(JSON.stringify({ event: "OOS_QUALITY_CLEANUP", ...result }));
}
