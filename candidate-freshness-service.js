import { existsSync, readFileSync } from "node:fs";

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

function recordKey(signalDate, market, code) {
  return `${signalDate}|${market}|${code}`;
}

function memberKeys(selections, strategyId) {
  const keys = new Set();
  for (const selection of selections ?? []) {
    if (selection?.strategyId !== strategyId) continue;
    for (const member of selection.members ?? []) {
      if (!selection.signalDate || !selection.market || !member?.code) continue;
      keys.add(recordKey(String(selection.signalDate), String(selection.market), String(member.code)));
    }
  }
  return keys;
}

function intersect(left, right) {
  return new Set([...left].filter((key) => right.has(key)));
}

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function numberOrNull(value) {
  return finite(value) ? Number(value) : null;
}

function cleanCandidate(candidate = {}) {
  const code = String(candidate.code ?? "").trim();
  const market = String(candidate.market ?? "").trim().toUpperCase();
  if (!/^\d{6}$/.test(code)) throw new Error(`INVALID_CANDIDATE_CODE:${code || "EMPTY"}`);
  if (!["KOSPI", "KOSDAQ"].includes(market)) throw new Error(`INVALID_CANDIDATE_MARKET:${market || "EMPTY"}`);
  return {
    code,
    market,
    leaderRank: numberOrNull(candidate.leaderRank)
  };
}

function freshnessBucket(streak) {
  if (streak <= 1) return "DAY_1";
  if (streak <= 3) return "DAY_2_3";
  if (streak <= 10) return "DAY_4_10";
  return "DAY_11_PLUS";
}

export function buildCandidateFreshness({ records = [], selections = [], signalDate, candidates = [] } = {}) {
  const date = String(signalDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("INVALID_CANDIDATE_FRESHNESS_SIGNAL_DATE");
  const currentCandidates = candidates.slice(0, 32).map(cleanCandidate);

  const coreKeys = intersect(
    memberKeys(selections, "LEADER_TOP10"),
    memberKeys(selections, "CONSENSUS_5S_3A")
  );
  const strongKeys = intersect(
    memberKeys(selections, "LEADER_A_AND_RS80"),
    memberKeys(selections, "CONSENSUS_AXIS_3_PLUS")
  );
  const candidateKeys = new Set([...coreKeys, ...strongKeys]);

  const allSignalDates = [...new Set((selections ?? []).map((row) => String(row?.signalDate ?? "")).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)))]
    .sort();
  const previousSignalDate = allSignalDates.filter((value) => value < date).at(-1) ?? null;
  const earliestSignalDate = allSignalDates[0] ?? null;
  const latestRecordedSignalDate = allSignalDates.at(-1) ?? null;

  const recordsByKey = new Map((records ?? []).map((row) => [recordKey(row.signalDate, row.market, row.code), row]));
  const membershipByStock = new Map();
  for (const key of candidateKeys) {
    const [memberDate, market, code] = key.split("|");
    const stockKey = `${market}|${code}`;
    if (!membershipByStock.has(stockKey)) membershipByStock.set(stockKey, new Set());
    membershipByStock.get(stockKey).add(memberDate);
  }

  const result = currentCandidates.map((candidate) => {
    const stockKey = `${candidate.market}|${candidate.code}`;
    const membership = membershipByStock.get(stockKey) ?? new Set();
    const historicalDates = [...membership].filter((value) => value < date).sort();
    const appearedBefore = historicalDates.length > 0;
    const wasPrevious = Boolean(previousSignalDate && membership.has(previousSignalDate));

    let status = "NEW";
    let streakTradingDays = 1;
    if (appearedBefore && wasPrevious) {
      status = "MAINTAIN";
      const priorCalendar = allSignalDates.filter((value) => value < date).reverse();
      for (const priorDate of priorCalendar) {
        if (!membership.has(priorDate)) break;
        streakTradingDays += 1;
      }
    } else if (appearedBefore) {
      status = "REENTRY";
    }

    const firstSeenDate = historicalDates[0] ?? date;
    const lastSeenBefore = historicalDates.at(-1) ?? null;
    const gapTradingDays = status === "REENTRY" && lastSeenBefore
      ? allSignalDates.filter((value) => value > lastSeenBefore && value < date).length
      : 0;

    const priorRecord = previousSignalDate
      ? recordsByKey.get(recordKey(previousSignalDate, candidate.market, candidate.code))
      : null;
    const previousLeaderRank = numberOrNull(priorRecord?.factors?.leaderRank);
    const leaderRankDelta = candidate.leaderRank !== null && previousLeaderRank !== null
      ? candidate.leaderRank - previousLeaderRank
      : null;

    return {
      code: candidate.code,
      market: candidate.market,
      status,
      statusLabel: status === "NEW" ? "신규" : status === "REENTRY" ? "재진입" : `유지 ${streakTradingDays}일`,
      streakTradingDays,
      freshnessBucket: freshnessBucket(streakTradingDays),
      firstSeenDate,
      lastSeenBefore,
      gapTradingDays,
      previousSignalDate,
      currentLeaderRank: candidate.leaderRank,
      previousLeaderRank,
      leaderRankDelta
    };
  });

  return {
    schemaVersion: "candidate-freshness-v1",
    signalDate: date,
    historyBasis: "strategy-oos-selections",
    earliestSignalDate,
    latestRecordedSignalDate,
    previousSignalDate,
    counts: {
      new: result.filter((row) => row.status === "NEW").length,
      maintain: result.filter((row) => row.status === "MAINTAIN").length,
      reentry: result.filter((row) => row.status === "REENTRY").length
    },
    rows: result
  };
}

export function buildCandidateFreshnessFromFiles({ historyFile, selectionFile, signalDate, candidates }) {
  return buildCandidateFreshness({
    records: readJsonl(historyFile),
    selections: readJsonl(selectionFile),
    signalDate,
    candidates
  });
}
