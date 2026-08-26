import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(file, search, replacement) {
  const source = readFileSync(file, "utf8");
  const count = source.split(search).length - 1;
  if (count !== 1) throw new Error(`${file}: expected one literal match, got ${count}`);
  writeFileSync(file, source.replace(search, replacement), "utf8");
}

function replaceRegexOnce(file, regex, replacement) {
  const source = readFileSync(file, "utf8");
  const matches = source.match(new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`)) ?? [];
  if (matches.length !== 1) throw new Error(`${file}: expected one regex match, got ${matches.length}`);
  writeFileSync(file, source.replace(regex, replacement), "utf8");
}

// 1) ACTIONABLE_ALL is a rule cohort, not the literal V1 ledger fills.
replaceOnce(
  "simulation-v2-service.js",
  '{ id: "actual", label: "✅ 실제진입" },',
  '{ id: "actual", label: "✅ 진입판정" },'
);
replaceOnce(
  "public/simulator-v2.js",
  '{ id: "actual", label: "✅ 실제진입" },',
  '{ id: "actual", label: "✅ 진입판정" },'
);

// 2) Signal-day uncertainty: daily baskets are the less-correlated sampling unit.
replaceRegexOnce(
  "simulation-v2-service.js",
  /function dayBasketBlock\(rows, horizon\) \{[\s\S]*?\n\}\n\nfunction gapBlock/,
`function dayBasketBlock(rows, horizon) {
  const byDay = new Map();
  for (const row of rows) {
    const outcome = row.outcomesV2?.[String(horizon)];
    if (!finite(outcome?.netReturnPct)) continue;
    if (!byDay.has(row.signalDate)) byDay.set(row.signalDate, []);
    byDay.get(row.signalDate).push(Number(outcome.netReturnPct));
  }
  const baskets = [...byDay.entries()].map(([signalDate, values]) => ({
    signalDate,
    members: values.length,
    returnPct: average(values)
  }));
  const returns = baskets.map((row) => row.returnPct).filter(finite).map(Number);
  const mean = average(returns);
  const deviation = stddev(returns);
  const standardError = finite(deviation) && returns.length ? Number(deviation) / Math.sqrt(returns.length) : null;
  const halfWidth95 = finite(standardError) ? 1.96 * Number(standardError) : null;
  const confidenceLabel = returns.length >= 50
    ? "누적 의미 있음"
    : returns.length >= 20
      ? "비교 가능"
      : returns.length >= 10
        ? "초기 참고"
        : "표본 부족";
  return {
    n: returns.length,
    avgReturnPct: round(mean),
    medianReturnPct: round(median(returns)),
    winRatePct: returns.length ? round((returns.filter((value) => value > 0).length / returns.length) * 100, 1) : null,
    stddevPct: round(deviation),
    standardErrorPct: round(standardError),
    ci95LowPct: finite(mean) && finite(halfWidth95) ? round(Number(mean) - Number(halfWidth95)) : null,
    ci95HighPct: finite(mean) && finite(halfWidth95) ? round(Number(mean) + Number(halfWidth95)) : null,
    confidenceLabel,
    best: baskets.filter((row) => finite(row.returnPct)).sort((a, b) => b.returnPct - a.returnPct)[0] ?? null,
    worst: baskets.filter((row) => finite(row.returnPct)).sort((a, b) => a.returnPct - b.returnPct)[0] ?? null
  };
}

function gapBlock`
);

// 3) Portfolio simulation must never create implicit leverage after losses.
replaceRegexOnce(
  "simulation-v2-service.js",
  /export function simulatePortfolio\(rows, \{[\s\S]*?\n\}\n\nfunction healthBlock/,
`export function simulatePortfolio(rows, {
  cohortId,
  horizon = 10,
  initialCapital = 100_000_000,
  maxPositions = 10
} = {}) {
  const safeInitialCapital = finite(initialCapital) && Number(initialCapital) > 0 ? Number(initialCapital) : 100_000_000;
  const safeMaxPositions = finite(maxPositions) ? Math.max(1, Math.floor(Number(maxPositions))) : 10;
  const candidates = rows
    .filter((row) => row[cohortId] === true)
    .filter((row) => row.entryDate && finite(row.outcomesV2?.[String(horizon)]?.netReturnPct))
    .map((row) => ({
      ...row,
      entryKey: compactDate(row.entryDate),
      exitKey: compactDate(row.outcomesV2[String(horizon)].targetTradingDate),
      netReturnPct: Number(row.outcomesV2[String(horizon)].netReturnPct)
    }))
    .filter((row) => /^\\d{8}$/.test(row.entryKey) && /^\\d{8}$/.test(row.exitKey));

  const byEntry = new Map();
  const exitDates = new Set();
  for (const row of candidates) {
    if (!byEntry.has(row.entryKey)) byEntry.set(row.entryKey, []);
    byEntry.get(row.entryKey).push(row);
    exitDates.add(row.exitKey);
  }
  const dates = [...new Set([...byEntry.keys(), ...exitDates])].sort();
  let cash = safeInitialCapital;
  let active = [];
  let skippedDuplicate = 0;
  let skippedCapacity = 0;
  let skippedCash = 0;
  let peakPositions = 0;
  const trades = [];
  const bookEquity = () => cash + active.reduce((sum, position) => sum + position.allocation, 0);
  const curve = [{ date: dates[0] ?? null, equity: safeInitialCapital }];

  for (const date of dates) {
    // Entries happen at the open. Positions scheduled to exit today still tie up
    // their capital until the close, so they correctly remain in active here.
    const entries = [...(byEntry.get(date) ?? [])].sort(portfolioSort);
    for (const row of entries) {
      if (active.some((position) => position.code === row.code)) {
        skippedDuplicate += 1;
        continue;
      }
      if (active.length >= safeMaxPositions) {
        skippedCapacity += 1;
        continue;
      }
      const targetAllocation = bookEquity() / safeMaxPositions;
      if (!finite(targetAllocation) || targetAllocation <= 0 || cash + 1e-6 < targetAllocation) {
        skippedCash += 1;
        continue;
      }
      cash -= targetAllocation;
      active.push({
        code: row.code,
        name: row.name,
        entryDate: date,
        exitDate: row.exitKey,
        returnPct: row.netReturnPct,
        allocation: targetAllocation
      });
      peakPositions = Math.max(peakPositions, active.length);
    }

    const closing = active.filter((position) => position.exitDate === date);
    if (closing.length) {
      for (const position of closing) {
        const pnl = position.allocation * position.returnPct / 100;
        cash += position.allocation + pnl;
        trades.push({ ...position, pnl });
      }
      active = active.filter((position) => position.exitDate !== date);
      curve.push({ date, equity: bookEquity() });
    }
  }

  const returns = trades.map((trade) => trade.returnPct);
  const endingEquity = bookEquity();
  return {
    cohortId,
    horizon,
    initialCapital: safeInitialCapital,
    maxPositions: safeMaxPositions,
    completedTrades: trades.length,
    skippedDuplicate,
    skippedCapacity,
    skippedCash,
    peakPositions,
    endingCash: round(cash, 0),
    endingEquity: round(endingEquity, 0),
    totalReturnPct: round((endingEquity / safeInitialCapital - 1) * 100),
    realizedMaxDrawdownPct: round(drawdownFromCurve(curve, safeInitialCapital)),
    winRatePct: trades.length ? round((trades.filter((trade) => trade.returnPct > 0).length / trades.length) * 100, 1) : null,
    avgTradeReturnPct: round(average(returns)),
    profitFactor: round(profitFactor(returns), 2),
    curve: curve.slice(-120),
    activeAtEnd: active.length,
    activePrincipalAtEnd: round(active.reduce((sum, position) => sum + position.allocation, 0), 0)
  };
}

function healthBlock`
);

// 4) Missing-day health must not call an unverified weekday a holiday.
replaceRegexOnce(
  "simulation-v2-service.js",
  /function healthBlock\(\{ records, selections, invalidLines, state, indexData \}\) \{[\s\S]*?\n\}\n\nexport function buildSimulationV2ServerModel/,
`function healthBlock({ records, selections, invalidLines, state, indexData }) {
  const signalDates = [...new Set(records.map((row) => row.signalDate).filter(Boolean))].sort();
  const rawNoRecordDates = state?.missingSnapshotDates ?? [];
  const first = compactDate(signalDates[0]);
  const last = compactDate(signalDates.at(-1));
  const indexCoverage = Object.fromEntries(["KOSPI", "KOSDAQ"].map((market) => {
    const rows = indexData?.markets?.[market] ?? [];
    const firstDate = rows[0]?.date ?? null;
    const lastDate = rows.at(-1)?.date ?? null;
    const coversRange = Boolean(first && last && firstDate && lastDate && firstDate <= first && lastDate >= last);
    return [market, { firstDate, lastDate, coversRange }];
  }));
  const calendarSourceMarket = ["KOSPI", "KOSDAQ"].find((market) => indexCoverage[market].coversRange) ?? null;
  const calendarRows = calendarSourceMarket ? indexData?.markets?.[calendarSourceMarket] ?? [] : [];
  const tradingDates = new Set(calendarRows.map((row) => String(row.date)));
  const confirmedMissing = calendarSourceMarket
    ? rawNoRecordDates.filter((date) => tradingDates.has(compactDate(date)))
    : [];
  const nonTradingNoRecordDates = calendarSourceMarket
    ? rawNoRecordDates.filter((date) => !tradingDates.has(compactDate(date)))
    : [];
  const unverifiedNoRecordDates = calendarSourceMarket ? [] : [...rawNoRecordDates];
  const indexBenchmarkReady = ["KOSPI", "KOSDAQ"].every((market) => indexCoverage[market].coversRange);
  const frozen = records.filter((row) => row.frozenConsensus).length;
  const entryDay = records.filter((row) => row.entryDayOutcome).length;
  const indexLast = Object.fromEntries(["KOSPI", "KOSDAQ"].map((market) => [market, indexData?.markets?.[market]?.at(-1)?.date ?? null]));
  let status = "good";
  if (invalidLines > 0 || confirmedMissing.length > 0 || unverifiedNoRecordDates.length > 0 || (signalDates.length && !indexBenchmarkReady)) status = "warn";
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
    unverifiedNoRecordDates,
    calendarSourceMarket,
    indexBenchmarkReady,
    indexCoverage,
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
}

export function buildSimulationV2ServerModel`
);

// 5) Give the one-time index bootstrap enough pages to actually cover five years.
replaceOnce(
  "server.mjs",
  '  for (let page = 0; page < 10; page += 1) {\n    const data = await kisGet(\n      "/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice",',
  '  for (let page = 0; page < 15; page += 1) {\n    const data = await kisGet(\n      "/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice",'
);

// 6) Add a same-day universe benchmark for the new 0D outcome as well.
replaceRegexOnce(
  "strategy-oos-tracker.js",
  /export function attachBenchmarks\(records, horizons = STRATEGY_HORIZONS\) \{[\s\S]*?\n\}\n\n\/\/ Summary numbers/,
`function attachOutcomeBenchmarks(records, readOutcome, writeOutcome) {
  const groups = new Map();
  for (const row of records) {
    const outcome = readOutcome(row);
    if (!finite(outcome?.netReturnPct)) continue;
    const groupKey = \`${"${row.signalDate}"}|${"${row.market}"}\`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(Number(outcome.netReturnPct));
  }
  for (const row of records) {
    const outcome = readOutcome(row);
    if (!outcome) continue;
    const values = groups.get(\`${"${row.signalDate}"}|${"${row.market}"}\`) ?? [];
    const benchmarkReturnPct = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    writeOutcome(row, {
      ...outcome,
      benchmarkReturnPct,
      excessReturnPct: finite(benchmarkReturnPct) ? Number(outcome.netReturnPct) - benchmarkReturnPct : null
    });
  }
}

export function attachBenchmarks(records, horizons = STRATEGY_HORIZONS) {
  attachOutcomeBenchmarks(
    records,
    (row) => row.entryDayOutcome,
    (row, outcome) => { row.entryDayOutcome = outcome; }
  );
  for (const horizon of horizons) {
    const key = String(horizon);
    attachOutcomeBenchmarks(
      records,
      (row) => row.outcomes?.[key],
      (row, outcome) => { row.outcomes[key] = outcome; }
    );
  }
  return records;
}

// Summary numbers`
);

// 7) UI wording and diagnostics.
replaceOnce(
  "public/simulator-v2.js",
  '<div class="section-title"><div><h2>실제운용 포트폴리오 시뮬레이션</h2><p>동일 종목 중복진입 금지 · 최대 10종목 · 1억원 기준. 실현손익 기준 MDD이며 기존 OOS 신호 자체는 변경하지 않습니다.</p></div></div>',
  '<div class="section-title"><div><h2>실제운용 포트폴리오 시뮬레이션</h2><p>동일 종목 중복진입 금지 · 최대 10종목 · 1억원 기준. ✅ 진입판정은 ACTIONABLE_ALL 규칙 전체이며 아래 V1 실제체결 장부와는 별도입니다. 실현손익 기준 MDD입니다.</p></div></div>'
);
replaceOnce(
  "public/simulator-v2.js",
  '["데이터 건강", health.status === "good" ? "정상" : health.status === "warn" ? "확인필요" : "대기", `누락 ${health.missingSnapshotDates?.length ?? 0}일 · 동결 ${pct(health.frozenConsensusCoveragePct)}`, health.status === "good" ? "positive" : "watch-text"]',
  '["데이터 건강", health.status === "good" ? "정상" : health.status === "warn" ? "확인필요" : "대기", `확정누락 ${health.missingSnapshotDates?.length ?? 0}일 · 미검증 ${health.unverifiedNoRecordDates?.length ?? 0}일 · 동결 ${pct(health.frozenConsensusCoveragePct)}`, health.status === "good" ? "positive" : "watch-text"]'
);
replaceOnce(
  "public/simulator-v2.js",
  '  const missing = health.missingSnapshotDates ?? [];\n  const indexDates = health.indexLastDate ?? {};',
  '  const missing = health.missingSnapshotDates ?? [];\n  const unverified = health.unverifiedNoRecordDates ?? [];\n  const indexDates = health.indexLastDate ?? {};'
);
replaceOnce(
  "public/simulator-v2.js",
  '    <span>스냅샷 누락 ${missing.length}일${missing.length ? ` (${missing.slice(-5).join(", ")})` : ""} · 오류라인 ${health.invalidLines ?? 0} · 전략/계열 동결 ${pct(health.frozenConsensusCoveragePct)} · 0D 보강 ${pct(health.entryDayCoveragePct)}</span>\n    <span>실제지수 저장 KOSPI ${indexDates.KOSPI ?? "-"} · KOSDAQ ${indexDates.KOSDAQ ?? "-"} · 유니버스 ${Object.keys(model.meta?.universeVersions ?? {}).join(" / ") || "legacy"}</span>`;',
  '    <span>스냅샷 확정누락 ${missing.length}일${missing.length ? ` (${missing.slice(-5).join(", ")})` : ""} · 미검증 ${unverified.length}일${unverified.length ? ` (${unverified.slice(-5).join(", ")})` : ""} · 오류라인 ${health.invalidLines ?? 0} · 전략/계열 동결 ${pct(health.frozenConsensusCoveragePct)} · 0D 보강 ${pct(health.entryDayCoveragePct)}</span>\n    <span>실제지수 저장 KOSPI ${indexDates.KOSPI ?? "-"} · KOSDAQ ${indexDates.KOSDAQ ?? "-"} · 지수검증 ${health.indexBenchmarkReady ? "정상" : "대기/불완전"} · 유니버스 ${Object.keys(model.meta?.universeVersions ?? {}).join(" / ") || "legacy"}</span>`;'
);
replaceOnce(
  "public/simulator-v2.js",
  '<div class="cell-sub">중복skip ${p.skippedDuplicate ?? 0} · 용량skip ${p.skippedCapacity ?? 0}</div>',
  '<div class="cell-sub">중복skip ${p.skippedDuplicate ?? 0} · 용량skip ${p.skippedCapacity ?? 0} · 현금skip ${p.skippedCash ?? 0}</div><div class="cell-sub">최대 동시 ${p.peakPositions ?? 0}종목</div>'
);
replaceOnce(
  "public/simulator-v2.js",
  '<td><b class="${tone(days.avgReturnPct)}">${pct(days.avgReturnPct)}</b><div class="cell-sub">독립 신호일 d=${days.n ?? 0}</div></td>',
  '<td><b class="${tone(days.avgReturnPct)}">${pct(days.avgReturnPct)}</b><div class="cell-sub">신호일 d=${days.n ?? 0} · ${days.confidenceLabel ?? "-"}</div><div class="cell-sub">95% CI ${pct(days.ci95LowPct)} ~ ${pct(days.ci95HighPct)}</div></td>'
);

console.log("Simulation V2 final-review patches applied");
