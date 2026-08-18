import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  previousRanksFrom,
  buildRankingLiveObservations,
  createRankingLiveTracker,
  readRankingLiveJsonl,
  safeTrackerTask
} from "./ranking-live-tracker.js";

function row(code, market, tier) {
  const configs = {
    1: { dd: -30, risk: 25, stabilize: 90, status: "관찰 목록", mtt: true },
    2: { dd: -45, risk: 40, stabilize: 80, status: "하락 정지 확인" },
    3: { dd: -30, risk: 25, stabilize: 70, status: "관찰 목록" },
    4: { dd: -45, risk: 55, stabilize: 60, status: "관찰 목록" },
    5: { dd: -10, risk: 25, stabilize: 50, status: "관찰 목록" },
    6: { dd: -30, risk: 65, stabilize: 40, status: "추가매수 금지", blocked: true }
  }[tier];
  return {
    market,
    code,
    name: `${market}-${code}`,
    price: 100,
    changeRate: 1,
    changeRate3d: -2,
    leader: { score: 60 + tier, grade: tier <= 2 ? "B" : "C" },
    scout: { drawdownFromHighPct: configs.dd, riskScore: configs.risk, stabilizeScore: configs.stabilize, status: configs.status, ret20: 1 },
    confirmation: { cafePass: false, minerviniPass: Boolean(configs.mtt) },
    supply: { liquidityScore: 50, foreignNetAmount: 1000, instNetAmount: 2000, foreignStreak: 2, instStreak: 1 },
    combined: { score: 40, label: configs.blocked ? "매수보류" : "관망", blocked: Boolean(configs.blocked), gateReason: configs.blocked ? "TEST_BLOCK" : "PASS" },
    strategy: { flags: configs.blocked ? { I: true } : {} }
  };
}

function series(lastIndex) {
  return Array.from({ length: lastIndex + 1 }, (_, index) => ({
    date: `202608${String(index + 1).padStart(2, "0")}`,
    open: index === 0 ? 99 : 100,
    high: 100 + index * 2,
    low: 100 - index,
    close: 100 + index
  }));
}

const tempDir = mkdtempSync(path.join(os.tmpdir(), "ranking-live-tracker-"));
const historyFile = path.join(tempDir, "ranking-live-history.jsonl");
const summaryFile = path.join(tempDir, "ranking-live-summary.json");
const tracker = createRankingLiveTracker({
  historyFile,
  summaryFile,
  now: () => new Date("2026-08-13T07:00:00.000Z")
});

try {
  const rows = Object.fromEntries(["KOSPI", "KOSDAQ"].map((market) => [market, [1, 2, 3, 4, 5, 6].map((tier) => row(`00000${tier}`, market, tier))]));
  const payload = { asOf: "2026-08-01T07:00:00.000Z", rows };
  const historyByCode = new Map([1, 2, 3, 4, 5, 6].map((tier) => [`00000${tier}`, series(0)]));

  const first = tracker.recordSnapshot(payload, historyByCode);
  const second = tracker.recordSnapshot(payload, historyByCode);
  assert.equal(first.added, 12, "first snapshot must save both markets");
  assert.equal(second.added, 0, "same date/market/ticker must be idempotent");

  const initial = tracker.read().records;
  assert.equal(initial.length, 12);
  assert.equal(initial.filter((item) => item.ticker === "000001").length, 2, "same ticker in different markets must not collide");
  assert.deepEqual([...new Set(initial.map((item) => item.rankingTier))].sort(), [1, 2, 3, 4, 5, 6]);
  assert(initial.every((item) => Number.isInteger(item.reviewRank) && item.reviewRank >= 1));
  assert(initial.every((item) => item.outcome3 === null && item.outcome5 === null && item.outcome10 === null));

  const sameDayTracker = createRankingLiveTracker({
    historyFile: path.join(tempDir, "same-day.jsonl"),
    now: () => new Date("2026-08-01T07:00:00.000Z")
  });
  sameDayTracker.recordSnapshot(payload, historyByCode);
  let sameDayLoads = 0;
  await sameDayTracker.evaluatePending(async () => { sameDayLoads += 1; return series(11); });
  assert.equal(sameDayLoads, 0, "signal day must not trigger future-price API reads");

  // A broadly-failed refresh must still be rejected outright. (A handful of
  // per-stock errors is tolerated now — that case is covered separately in
  // the transient-error block below.)
  const failedPayload = { ...payload, errors: Array.from({ length: 12 }, (_, i) => ({ type: "quote", code: `bad${i}` })) };
  assert.equal(tracker.recordSnapshot(failedPayload, historyByCode).added, 0, "a broadly failed screener refresh must not be recorded");

  const immutableBefore = initial.map(({ entryTradingDate, entryPrice, outcome3, outcome5, outcome10, ...snapshot }) => snapshot);
  await tracker.evaluatePending(async () => series(4));
  const after3 = tracker.read().records;
  assert(after3.every((item) => item.outcome3 && item.outcome5 === null && item.outcome10 === null), "only 3-day outcome may update at session 4");
  assert(after3.every((item) => item.entryTradingDate === "20260802" && item.entryPrice === 100));
  assert(Math.abs(after3[0].outcome3.grossReturnPct - 4) < 1e-9);
  assert(Math.abs(after3[0].outcome3.netReturnPct - 3.77) < 1e-9, "0.23% round-trip cost must be deducted");
  assert(Math.abs(after3[0].outcome3.maxFavorablePct - 8) < 1e-9);
  assert(Math.abs(after3[0].outcome3.maxAdversePct - (-4)) < 1e-9);

  await tracker.evaluatePending(async () => series(11));
  const completed = tracker.read().records;
  assert(completed.every((item) => item.outcome5 && item.outcome10), "5-day and 10-day outcomes must complete only when sessions exist");
  assert(completed.every((item) => item.outcome10.targetTradingDate === "20260812"));
  const immutableAfter = completed.map(({ entryTradingDate, entryPrice, outcome3, outcome5, outcome10, ...snapshot }) => snapshot);
  assert.deepEqual(immutableAfter, immutableBefore, "future updates must not alter the signal snapshot");

  appendFileSync(historyFile, "{broken-last-line", "utf8");
  const defensiveRead = readRankingLiveJsonl(historyFile);
  assert.equal(defensiveRead.records.length, 12);
  assert.equal(defensiveRead.invalidLines, 1, "broken JSONL tail must be skipped");
  tracker.recordSnapshot(payload, historyByCode);
  assert.equal(readRankingLiveJsonl(historyFile).invalidLines, 0, "next safe write must remove a broken JSONL tail");

  const badPath = path.join(tempDir, "not-a-file");
  mkdirSync(badPath);
  const brokenTracker = createRankingLiveTracker({ historyFile: badPath });
  let isolatedError = null;
  const isolated = safeTrackerTask(() => brokenTracker.recordSnapshot(payload, historyByCode), (error) => { isolatedError = error; });
  assert.equal(isolated.ok, false, "tracker write failure must be isolated");
  assert(isolatedError instanceof Error);

  console.log("Ranking V2 live tracker self-test: PASS");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

// --- transient-error tolerance (2026-08 fix) ---
{
  const mkRow = (code, name, market) => ({
    code, name, market, price: 1000, changeRate: 0, changeRate3d: 0,
    leader: { score: 50, grade: "C" },
    scout: { drawdownFromHighPct: -25, riskScore: 20, stabilizeScore: 70, status: "하락 정지 확인", rs20: 50 },
    combined: { score: 50, label: "관심 관찰", tier: 3, rankable: true, blocked: false },
    confirmation: {}, stockEasy: {}, supply: {}
  });
  const hist = new Map([["A1", [{ date: "20260818", close: 1000 }]]]);
  const rows = {
    KOSPI: [mkRow("A1", "가", "KOSPI"), mkRow("A2", "나", "KOSPI")],
    KOSDAQ: [mkRow("B1", "다", "KOSDAQ"), mkRow("B2", "라", "KOSDAQ")]
  };

  const clean = buildRankingLiveObservations({ errors: [], rows }, hist);
  assert.equal(clean.length, 4, "no errors: every row recorded");

  const oneBad = buildRankingLiveObservations(
    { errors: [{ code: "A2", message: "초당 거래건수를 초과하였습니다." }], rows },
    hist
  );
  assert.equal(oneBad.length, 3, "one transient error must not discard the whole day");
  assert.ok(!oneBad.some((o) => o.ticker === "A2"), "the failed ticker itself is excluded");
  assert.ok(oneBad.some((o) => o.ticker === "A1"), "healthy rows survive");
  assert.equal(oneBad.find((o) => o.ticker === "A1").reviewRank, 1, "rank still reflects the full market");

  const broadlyBroken = buildRankingLiveObservations(
    { errors: [{ code: "A1" }, { code: "A2" }, { code: "B1" }, { code: "B2" }, { code: "B3" }], rows },
    hist
  );
  assert.equal(broadlyBroken.length, 0, "a broadly degraded run is still rejected");

  console.log("Ranking V2 tracker transient-error tolerance self-test: PASS");
}

// --- previous-day rank lookup for the rank-move indicator ---
{
  const records = [
    { signalDate: "2026-08-13", market: "KOSPI", ticker: "A", reviewRank: 5 },
    { signalDate: "2026-08-13", market: "KOSPI", ticker: "B", reviewRank: 1 },
    { signalDate: "2026-08-14", market: "KOSPI", ticker: "A", reviewRank: 2 },
    { signalDate: "2026-08-14", market: "KOSPI", ticker: "B", reviewRank: 4 },
    { signalDate: "2026-08-14", market: "KOSDAQ", ticker: "A", reviewRank: 9 },
    { signalDate: "2026-08-18", market: "KOSPI", ticker: "A", reviewRank: 3 }
  ];

  const prev = previousRanksFrom(records, "2026-08-18");
  assert.equal(prev.signalDate, "2026-08-14", "picks the latest date strictly before today");
  assert.equal(prev.ranks.get("KOSPI|A"), 2);
  assert.equal(prev.ranks.get("KOSDAQ|A"), 9, "market is part of the key");
  assert.equal(prev.ranks.get("KOSPI|Z"), undefined, "unknown ticker has no previous rank");

  const skipsGaps = previousRanksFrom(records, "2026-08-14");
  assert.equal(skipsGaps.signalDate, "2026-08-13", "holidays/gaps just mean the prior recorded day");

  const noHistory = previousRanksFrom([], "2026-08-18");
  assert.equal(noHistory.signalDate, null);
  assert.equal(noHistory.ranks.size, 0, "empty history yields no deltas rather than throwing");

  const firstEver = previousRanksFrom(
    [{ signalDate: "2026-08-18", market: "KOSPI", ticker: "A", reviewRank: 1 }],
    "2026-08-18"
  );
  assert.equal(firstEver.ranks.size, 0, "the very first day has nothing to compare against");

  console.log("Ranking V2 previous-rank lookup self-test: PASS");
}
