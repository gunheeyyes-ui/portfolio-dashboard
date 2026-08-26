import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(file, search, replacement) {
  const source = readFileSync(file, "utf8");
  const count = source.split(search).length - 1;
  if (count !== 1) throw new Error(`${file}: expected one match, got ${count}`);
  writeFileSync(file, source.replace(search, replacement), "utf8");
}

replaceOnce(
  "simulation-v2-service.js",
`function healthBlock({ records, selections, invalidLines, state, indexData }) {
  const signalDates = [...new Set(records.map((row) => row.signalDate).filter(Boolean))].sort();
  const missing = state?.missingSnapshotDates ?? [];
  const frozen = records.filter((row) => row.frozenConsensus).length;
  const entryDay = records.filter((row) => row.entryDayOutcome).length;
  const indexLast = Object.fromEntries(["KOSPI", "KOSDAQ"].map((market) => [market, indexData?.markets?.[market]?.at(-1)?.date ?? null]));
  let status = "good";
  if (invalidLines > 0 || missing.length > 0) status = "warn";
  if (!signalDates.length) status = "empty";
  return {
    status,
    signalDates: signalDates.length,
    firstSignalDate: signalDates[0] ?? null,
    lastSignalDate: signalDates.at(-1) ?? null,
    recordCount: records.length,
    selectionCount: selections.length,
    invalidLines,
    missingSnapshotDates: missing,
    lastSnapshotAt: state?.lastSnapshotAt ?? null,
    lastEvaluatedAt: state?.lastEvaluatedAt ?? null,
    frozenConsensusRecords: frozen,
    frozenConsensusCoveragePct: records.length ? round((frozen / records.length) * 100, 1) : null,
    entryDayRecords: entryDay,
    entryDayCoveragePct: records.length ? round((entryDay / records.length) * 100, 1) : null,
    indexUpdatedAt: indexData?.updatedAt ?? null,
    indexLastDate: indexLast,
    recentSkipped: (state?.skipped ?? []).slice(-10)
  };
}`,
`function healthBlock({ records, selections, invalidLines, state, indexData }) {
  const signalDates = [...new Set(records.map((row) => row.signalDate).filter(Boolean))].sort();
  const rawNoRecordDates = state?.missingSnapshotDates ?? [];
  const recorded = new Set(signalDates);
  const first = compactDate(signalDates[0]);
  const last = compactDate(signalDates.at(-1));
  const tradingDates = new Set();
  if (first && last) {
    for (const market of ["KOSPI", "KOSDAQ"]) {
      for (const bar of indexData?.markets?.[market] ?? []) {
        const date = String(bar.date ?? "");
        if (date >= first && date <= last) tradingDates.add(date.slice(0, 4) + "-" + date.slice(4, 6) + "-" + date.slice(6, 8));
      }
    }
  }
  const confirmedMissing = [...tradingDates].filter((date) => !recorded.has(date)).sort();
  const nonTradingNoRecordDates = rawNoRecordDates.filter((date) => !confirmedMissing.includes(date));
  const frozen = records.filter((row) => row.frozenConsensus).length;
  const entryDay = records.filter((row) => row.entryDayOutcome).length;
  const indexLast = Object.fromEntries(["KOSPI", "KOSDAQ"].map((market) => [market, indexData?.markets?.[market]?.at(-1)?.date ?? null]));
  let status = "good";
  if (invalidLines > 0 || confirmedMissing.length > 0) status = "warn";
  if (!signalDates.length) status = "empty";
  return {
    status,
    signalDates: signalDates.length,
    firstSignalDate: signalDates[0] ?? null,
    lastSignalDate: signalDates.at(-1) ?? null,
    recordCount: records.length,
    selectionCount: selections.length,
    invalidLines,
    missingSnapshotDates: confirmedMissing,
    rawWeekdayNoRecordDates: rawNoRecordDates,
    nonTradingNoRecordDates,
    lastSnapshotAt: state?.lastSnapshotAt ?? null,
    lastEvaluatedAt: state?.lastEvaluatedAt ?? null,
    frozenConsensusRecords: frozen,
    frozenConsensusCoveragePct: records.length ? round((frozen / records.length) * 100, 1) : null,
    entryDayRecords: entryDay,
    entryDayCoveragePct: records.length ? round((entryDay / records.length) * 100, 1) : null,
    indexUpdatedAt: indexData?.updatedAt ?? null,
    indexLastDate: indexLast,
    recentSkipped: (state?.skipped ?? []).slice(-10)
  };
}`
);

replaceOnce(
  "server.mjs",
`  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 365 * 5);
  const startDate = yyyymmdd(start);`,
`  const end = new Date();
  const start = new Date();
  const existingCount = marketIndexTracker.read().markets?.[market]?.length ?? 0;
  // First bootstrap pulls a multi-year regime/benchmark seed. Daily EOD refreshes
  // only need the recent window; mergeMany keeps the older persisted bars forever.
  start.setDate(end.getDate() - (existingCount ? 220 : 365 * 5));
  const startDate = yyyymmdd(start);`
);

replaceOnce(
  "public/simulator-v2.js",
  '    } : `<tr><td colspan="15" class="loading">아직 OOS 기반 Simulation V2 기록이 없습니다.</td></tr>`;',
  '    } : `<tr><td colspan="14" class="loading">아직 OOS 기반 Simulation V2 기록이 없습니다.</td></tr>`;'
);
replaceOnce(
  "public/simulator-v2.js",
  '  if (body) body.innerHTML = `<tr><td colspan="15" class="loading">${error.message}</td></tr>`;',
  '  if (body) body.innerHTML = `<tr><td colspan="14" class="loading">${error.message}</td></tr>`;'
);

replaceOnce(
  "simulation-v2-hardening.test.mjs",
`  const records = [record("000001")];
  const selections = [selection("ACTIONABLE_ALL", ["000001"])];
  const model = buildSimulationV2ServerModel({
    records,
    selections,
    invalidLines: 1,
    state: { missingSnapshotDates: ["2026-08-19"], lastSnapshotAt: "2026-08-20T07:00:00Z" },
    indexData: data
  });`,
`  const records = [
    record("000001", { signalDate: "2026-08-18" }),
    record("000002", { signalDate: "2026-08-20" })
  ];
  const selections = [selection("ACTIONABLE_ALL", ["000001"], "2026-08-18"), selection("ACTIONABLE_ALL", ["000002"], "2026-08-20")];
  const model = buildSimulationV2ServerModel({
    records,
    selections,
    invalidLines: 1,
    state: { missingSnapshotDates: ["2026-08-19"], lastSnapshotAt: "2026-08-20T07:00:00Z" },
    indexData: data
  });`
);

console.log("Simulation V2 polish patches applied");
