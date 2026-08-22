function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function numberOrNull(value) {
  return finite(value) ? Number(value) : null;
}

function reviewCandidate(item) {
  const feature = item?.feature ?? {};
  const row = item?.row ?? {};
  const strategyCount = item?.matches?.length ?? 0;
  const axisCount = item?.axesAll?.length ?? 0;
  const leaderRank = numberOrNull(feature.leaderRank);
  const rs20 = numberOrNull(feature.rs20);

  // Historical V3 consensus backtest:
  // 1) strongest broad cohort: Leader TOP10 + 5 strategies + 3 independent axes
  // 2) broad secondary cohort: Leader A + RS80 + 3 independent axes
  // These are review candidates, not a replacement for the existing live
  // actionable verdict. The simulator ledger still records actionable only.
  const coreCandidate = leaderRank !== null
    && leaderRank <= 10
    && strategyCount >= 5
    && axisCount >= 3;
  const strongCandidate = feature.leaderGrade === "A"
    && rs20 !== null
    && rs20 >= 80
    && axisCount >= 3;

  if (!coreCandidate && !strongCandidate) return null;

  return {
    code: String(feature.code ?? ""),
    name: feature.name ?? "",
    market: feature.market ?? "",
    source: "market",
    sourceLabel: feature.market ?? "시장",
    price: numberOrNull(feature.signalPrice),
    changeRate: numberOrNull(row.changeRate ?? row.quote?.changeRate ?? row.strategy?.dayChangePct),
    changeRate3d: numberOrNull(row.changeRate3d ?? row.strategy?.change3dPct),
    drawdownFromHighPct: numberOrNull(feature.drawdownPct),
    liquidityScore: numberOrNull(feature.liquidityScore),
    foreignStreak: numberOrNull(feature.foreignStreak),
    instStreak: numberOrNull(feature.institutionStreak),
    leaderScore: numberOrNull(feature.leaderScore),
    leaderGrade: feature.leaderGrade ?? null,
    leaderRank,
    timingScore: numberOrNull(feature.combinedScore),
    rs20,
    scoutRiskScore: numberOrNull(feature.riskScore),
    scoutStabilizeScore: numberOrNull(feature.stabilizeScore),
    strategyCount,
    axisCount,
    axisLabels: (item?.axesAll ?? []).map((axis) => axis.label),
    cafePass: feature.cafe === true,
    minerviniPass: feature.mtt === true,
    leaderReboundPass: feature.leaderRebound === true,
    judgement: row.judgement ?? "",
    reasons: Array.isArray(row.reasons) ? row.reasons.slice(0, 6) : [],
    coreCandidate,
    strongCandidate
  };
}

export function buildEntryReviewCandidates(items) {
  return (items ?? [])
    .map(reviewCandidate)
    .filter(Boolean)
    .sort(compareEntryCandidates);
}

export function entryCandidatePriority(row) {
  if (row?.coreCandidate && row?.actualEntry) return 50;
  if (row?.coreCandidate) return 40;
  if (row?.strongCandidate && row?.actualEntry) return 30;
  if (row?.strongCandidate) return 20;
  if (row?.actualEntry) return 10;
  return 0;
}

export function compareEntryCandidates(a, b) {
  return entryCandidatePriority(b) - entryCandidatePriority(a)
    || (numberOrNull(a?.leaderRank) ?? 9999) - (numberOrNull(b?.leaderRank) ?? 9999)
    || (numberOrNull(b?.axisCount) ?? -1) - (numberOrNull(a?.axisCount) ?? -1)
    || (numberOrNull(b?.strategyCount) ?? -1) - (numberOrNull(a?.strategyCount) ?? -1)
    || (numberOrNull(b?.rs20) ?? -1) - (numberOrNull(a?.rs20) ?? -1)
    || (numberOrNull(b?.rankScore) ?? -Infinity) - (numberOrNull(a?.rankScore) ?? -Infinity)
    || String(a?.name ?? "").localeCompare(String(b?.name ?? ""));
}

export function mergeEntryCandidates(actionableRows, reviewRows) {
  const byCode = new Map();

  for (const row of actionableRows ?? []) {
    if (!row?.code) continue;
    byCode.set(String(row.code), {
      ...row,
      actualEntry: true,
      coreCandidate: false,
      strongCandidate: false
    });
  }

  for (const row of reviewRows ?? []) {
    if (!row?.code) continue;
    const code = String(row.code);
    const actual = byCode.get(code);
    if (actual) {
      byCode.set(code, {
        ...actual,
        ...row,
        category: actual.category,
        source: actual.source,
        sourceLabel: actual.sourceLabel,
        rankScore: actual.rankScore,
        actualEntry: true
      });
    } else {
      byCode.set(code, { ...row, actualEntry: false });
    }
  }

  return [...byCode.values()].sort(compareEntryCandidates);
}
