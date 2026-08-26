import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(file, search, replacement) {
  const source = readFileSync(file, "utf8");
  const count = source.split(search).length - 1;
  if (count !== 1) throw new Error(`${file}: expected one match, got ${count}`);
  writeFileSync(file, source.replace(search, replacement), "utf8");
}

replaceOnce(
  "strategy-oos-tracker.js",
`    const localUpgradeNeeded = loaded.records.some((row) => !row.frozenConsensus && row.factors);
    if (!historyNeeded.length && !localUpgradeNeeded) return { updated: 0, total: loaded.records.length };`,
`    const localUpgradeNeeded = loaded.records.some((row) => !row.frozenConsensus && row.factors);
    const entryDayBenchmarkUpgradeCount = loaded.records.filter((row) => (
      finite(row.entryDayOutcome?.netReturnPct)
      && !finite(row.entryDayOutcome?.benchmarkReturnPct)
    )).length;
    if (!historyNeeded.length && !localUpgradeNeeded && !entryDayBenchmarkUpgradeCount) {
      return { updated: 0, total: loaded.records.length, entryDayBenchmarkUpgraded: 0 };
    }`
);

replaceOnce(
  "strategy-oos-tracker.js",
`    attachBenchmarks(records, horizons);
    if (updated || loaded.invalidLines) writeJsonl(historyFile, records);
    const state = { ...readState(), lastEvaluatedAt: evaluatedAt };
    writeState(state);
    writeSummary(records, loaded.selections, 0, state);
    return { updated, total: records.length };`,
`    attachBenchmarks(records, horizons);
    if (updated || loaded.invalidLines || entryDayBenchmarkUpgradeCount) writeJsonl(historyFile, records);
    const state = { ...readState(), lastEvaluatedAt: evaluatedAt };
    writeState(state);
    writeSummary(records, loaded.selections, 0, state);
    return {
      updated: Math.max(updated, entryDayBenchmarkUpgradeCount),
      total: records.length,
      entryDayBenchmarkUpgraded: entryDayBenchmarkUpgradeCount
    };`
);

console.log("0D benchmark persistence upgrade applied");
