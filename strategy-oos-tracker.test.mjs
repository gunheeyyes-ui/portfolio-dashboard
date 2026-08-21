import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { rankMarketRowsV2, reboundRankingTier } from "./public/rebound-ranking-v2.js";
import { simulationCategory } from "./simulation-category.js";
import { STRATEGY_HORIZONS, STRATEGY_OOS_COST_PCT, strategyById } from "./strategy-oos-registry.js";
import {
  buildFeatureRows,
  buildSelections,
  buildStrategyOosSummary,
  buildUniverseRecords,
  createStrategyOosTracker,
  evaluateUniverseRecord,
  isEodSnapshotAllowed,
  readJsonl
} from "./strategy-oos-tracker.js";

const SIGNAL_DATE = "2026-08-20";
const AFTER_CLOSE = new Date("2026-08-20T07:00:00Z"); // 16:00 KST
const BEFORE_CLOSE = new Date("2026-08-20T04:00:00Z"); // 13:00 KST

function makeRow(index, market) {
  const code = `${market === "KOSPI" ? "00" : "90"}${String(1000 + index)}`;
  const grade = index < 3 ? "A" : index < 6 ? "B" : index < 9 ? "C" : "D";
  const flags = {
    R: index % 6 === 0,
    F: index % 4 === 0,
    F2: index % 3 === 0,
    B: index % 5 === 0,
    C: index % 2 === 0,
    H2: index === 7,
    H3: index === 8,
    I: index === 11
  };
  const riskScore = 10 + index * 5;
  const stabilizeScore = 100 - index * 6;
  const drawdown = -(8 + index * 6);
  return {
    market,
    code,
    name: `${market}${index}`,
    price: 10_000 + index * 100,
    quote: { price: 10_000 + index * 100 },
    changeRate: -1,
    changeRate3d: -2,
    live: true,
    supply: {
      liquidityScore: 90 - index * 5,
      foreignStreak: index % 4,
      instStreak: index % 3,
      totalNetAmount: 1_000_000 - index,
      smartMoneyBodyPct: 0.1,
      smartMoneyTradingSharePct: 3,
      tradingValueRatio20: 1.2
    },
    strategy: { flags, dayChangePct: -1, change3dPct: -2, overheat: false, score: 50 - index },
    scout: {
      rank: index + 1,
      reboundRank: index + 1,
      status: index < 4 ? "1차 매수 검토" : index < 8 ? "하락 정지 확인" : "관찰 목록",
      riskScore,
      stabilizeScore,
      drawdownFromHighPct: drawdown,
      rs20: 99 - index * 8,
      cheapScore: 60,
      noNewLow5: true,
      slope5: 1
    },
    combined: {
      score: 90 - index * 4,
      rank: index + 1,
      tier: index < 2 ? 5 : index < 4 ? 4 : 2,
      label: index < 2 ? "종합 최우선" : index < 4 ? "종합 분할후보" : index === 8 ? "단기 특수" : "관심 관찰",
      rankable: true,
      blocked: false,
      gateReason: "PASS"
    },
    leader: { score: 95 - index * 4, grade, rank: index + 1 },
    confirmation: {
      cafePass: index < 2,
      minerviniPass: index < 3,
      leaderReboundPass: index === 0,
      deepRecoveryPass: index === 9,
      cafeAndMtt: index < 2,
      reboundState: { key: index < 2 ? "ready" : index < 5 ? "stopped" : "falling" }
    }
  };
}

function makePayload({ marketDataAsOf = SIGNAL_DATE, size = 12 } = {}) {
  return {
    marketDataAsOf,
    errors: [],
    rows: {
      KOSPI: Array.from({ length: size }, (unused, index) => makeRow(index, "KOSPI")),
      KOSDAQ: Array.from({ length: size }, (unused, index) => makeRow(index, "KOSDAQ"))
    }
  };
}

function makeSeries(startClose = 1000) {
  const rows = [];
  const cursor = new Date("2026-08-03T00:00:00Z");
  let step = 0;
  while (rows.length < 60) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      const close = startClose + step;
      rows.push({
        date: cursor.toISOString().slice(0, 10).replace(/-/g, ""),
        open: close,
        high: close + 10,
        low: close - 10,
        close
      });
      step += 1;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return rows;
}

function historyMapFor(payload, series = makeSeries().filter((row) => row.date <= "20260820")) {
  const map = new Map();
  for (const market of ["KOSPI", "KOSDAQ"]) {
    for (const row of payload.rows[market]) map.set(row.code, series);
  }
  return map;
}

function tempTracker(initial = AFTER_CLOSE) {
  const clock = { value: initial };
  const dir = mkdtempSync(path.join(os.tmpdir(), "strategy-oos-"));
  const tracker = createStrategyOosTracker({
    historyFile: path.join(dir, "strategy-oos-history.jsonl"),
    selectionFile: path.join(dir, "strategy-oos-selections.jsonl"),
    summaryFile: path.join(dir, "strategy-oos-summary.json"),
    stateFile: path.join(dir, "strategy-oos-state.json"),
    now: () => clock.value
  });
  return { dir, tracker, clock };
}

function featuresFor(payload) {
  return buildFeatureRows(payload, { failedCodes: new Set() });
}

function selectionsFor(payload) {
  const features = featuresFor(payload);
  return buildSelections(features, { signalDate: SIGNAL_DATE, recordedAt: AFTER_CLOSE.toISOString() });
}

function selection(selections, strategyId, market = "KOSPI") {
  return selections.find((row) => row.strategyId === strategyId && row.market === market);
}

function codes(sel) {
  return sel.members.map((member) => member.code);
}

test("장마감 이전 snapshot 금지", () => {
  const { dir, tracker } = tempTracker(BEFORE_CLOSE);
  const payload = makePayload();
  const result = tracker.recordSnapshot(payload, historyMapFor(payload));
  assert.equal(result.recorded, false);
  assert.equal(result.reason, "BEFORE_MARKET_CLOSE");
  assert.equal(existsSync(path.join(dir, "strategy-oos-history.jsonl")), false);
  assert.equal(isEodSnapshotAllowed({ marketDataAsOf: SIGNAL_DATE, now: BEFORE_CLOSE }).allowed, false);
  assert.equal(isEodSnapshotAllowed({ marketDataAsOf: SIGNAL_DATE, now: AFTER_CLOSE }).allowed, true);
});

test("동일 날짜 중복 snapshot 금지 (idempotency)", () => {
  const { dir, tracker } = tempTracker();
  const payload = makePayload();
  const history = historyMapFor(payload);
  const first = tracker.recordSnapshot(payload, history);
  const second = tracker.recordSnapshot(payload, history);
  assert.ok(first.addedRecords > 0);
  assert.equal(second.addedRecords, 0);
  assert.equal(second.addedSelections, 0);
  assert.equal(second.reason, "ALREADY_RECORDED");
  const stored = readJsonl(path.join(dir, "strategy-oos-history.jsonl")).records;
  assert.equal(stored.length, first.addedRecords);
  const keys = new Set(stored.map((row) => `${row.signalDate}|${row.market}|${row.code}`));
  assert.equal(keys.size, stored.length);
});

test("다음 거래일 시가 진입과 1/3/5/10/20 거래일 성과", () => {
  const series = makeSeries(1000);
  const signalIndex = series.findIndex((row) => row.date === "20260820");
  const entry = series[signalIndex + 1];
  const record = buildUniverseRecords(featuresFor(makePayload()), {
    signalDate: SIGNAL_DATE,
    recordedAt: AFTER_CLOSE.toISOString()
  })[0];
  const evaluated = evaluateUniverseRecord(record, series, { evaluatedAt: "2026-09-20T00:00:00Z" });
  assert.equal(evaluated.entryDate, entry.date);
  assert.equal(evaluated.entryOpen, entry.open);
  assert.notEqual(evaluated.entryOpen, series[signalIndex].close);
  for (const horizon of STRATEGY_HORIZONS) {
    const exit = series[signalIndex + 1 + horizon];
    const outcome = evaluated.outcomes[String(horizon)];
    assert.equal(outcome.targetTradingDate, exit.date);
    assert.equal(outcome.exitPrice, exit.close);
    const expected = (exit.close / entry.open - 1) * 100 - STRATEGY_OOS_COST_PCT;
    assert.ok(Math.abs(outcome.netReturnPct - expected) < 1e-9);
  }
  assert.equal(evaluated.status, "COMPLETE");
  assert.equal(evaluated.live.tradingDaysElapsed, 20);
  assert.equal(evaluated.live.lastEvaluatedDate, series[signalIndex + 21].date);
  assert.ok(evaluated.live.currentMFE > evaluated.live.currentReturnPct);
  assert.ok(evaluated.live.currentMAE < evaluated.live.currentMFE);
});

test("KOSPI·KOSDAQ 순위는 시장별로 독립", () => {
  const selections = selectionsFor(makePayload());
  for (const market of ["KOSPI", "KOSDAQ"]) {
    const top3 = selection(selections, "LEADER_TOP3", market);
    assert.equal(top3.members.length, 3);
    assert.deepEqual(top3.members.map((member) => member.rank), [1, 2, 3]);
    assert.ok(top3.members.every((member) => member.code.startsWith(market === "KOSPI" ? "00" : "90")));
  }
});

test("Leader / RS / 종합타이밍 / Ranking V2 / Scout 순위가 라이브와 동일", () => {
  const payload = makePayload();
  const selections = selectionsFor(payload);
  const rows = payload.rows.KOSPI;
  const leaderExpected = rows.slice().sort((a, b) => a.leader.rank - b.leader.rank).slice(0, 10).map((row) => row.code);
  assert.deepEqual(codes(selection(selections, "LEADER_TOP10")), leaderExpected);
  const rsExpected = rows.slice().sort((a, b) => b.scout.rs20 - a.scout.rs20 || a.code.localeCompare(b.code)).slice(0, 10).map((row) => row.code);
  assert.deepEqual(codes(selection(selections, "RS_TOP10")), rsExpected);
  const timingExpected = rows.slice().sort((a, b) => a.combined.rank - b.combined.rank).slice(0, 10).map((row) => row.code);
  assert.deepEqual(codes(selection(selections, "TIMING_TOP10")), timingExpected);
  const v2Expected = rankMarketRowsV2(rows).slice(0, 10).map((row) => row.code);
  assert.deepEqual(codes(selection(selections, "RANKING_V2_TOP10")), v2Expected);
  const scoutExpected = rows.slice().sort((a, b) => a.scout.reboundRank - b.scout.reboundRank).slice(0, 10).map((row) => row.code);
  assert.deepEqual(codes(selection(selections, "SCOUT_TOP10")), scoutExpected);
  const features = featuresFor(payload).byMarket.KOSPI;
  for (const row of rows) {
    const feature = features.find((item) => item.code === row.code);
    assert.equal(feature.rankingV2Tier, reboundRankingTier(row));
    assert.equal(feature.rs20, row.scout.rs20);
  }
});

test("Leader 점수가 없는 종목은 LEADER_TOP-N에서 제외", () => {
  const payload = makePayload();
  const ghost = makeRow(99, "KOSPI");
  ghost.code = "009999";
  ghost.name = "계산불가종목";
  ghost.leader = { score: null, grade: "계산불가", rank: 1 };
  payload.rows.KOSPI.push(ghost);
  const selections = selectionsFor(payload);
  assert.ok(!codes(selection(selections, "LEADER_TOP1")).includes("009999"));
  assert.ok(!codes(selection(selections, "LEADER_TOP10")).includes("009999"));
  assert.equal(selection(selections, "LEADER_TOP1").members.length, 1);
  assert.equal(selection(selections, "LEADER_TOP10").members.length, 10);
  const feature = featuresFor(payload).byMarket.KOSPI.find((row) => row.code === "009999");
  assert.equal(feature.leaderRank, null);
  assert.equal(feature.leaderGrade, null);
});

test("진입후보(actionable) 판정이 시뮬레이터와 동일", () => {
  const payload = makePayload();
  const selections = selectionsFor(payload);
  const expected = payload.rows.KOSPI.filter((row) => simulationCategory(row).actionable).map((row) => row.code).sort();
  assert.deepEqual(codes(selection(selections, "ACTIONABLE_ALL")).slice().sort(), expected);
  assert.ok(expected.length > 0);
  const combinedTop = payload.rows.KOSPI.filter((row) => row.combined.label === "종합 최우선").map((row) => row.code).sort();
  assert.deepEqual(codes(selection(selections, "COMBINED_TOP")).slice().sort(), combinedTop);
  const split = payload.rows.KOSPI.filter((row) => row.combined.label === "종합 분할후보").map((row) => row.code).sort();
  assert.deepEqual(codes(selection(selections, "COMBINED_SPLIT")).slice().sort(), split);
  const special = payload.rows.KOSPI.filter((row) => row.combined.label === "단기 특수").map((row) => row.code).sort();
  assert.deepEqual(codes(selection(selections, "SPECIAL_SHORT")).slice().sort(), special);
});

test("CAFE·MTT 선택이 confirmation 값과 동일", () => {
  const payload = makePayload();
  const selections = selectionsFor(payload);
  const cafe = payload.rows.KOSPI.filter((row) => row.confirmation.cafePass).map((row) => row.code).sort();
  const mtt = payload.rows.KOSPI.filter((row) => row.confirmation.minerviniPass).map((row) => row.code).sort();
  assert.deepEqual(codes(selection(selections, "CAFE")).slice().sort(), cafe);
  assert.deepEqual(codes(selection(selections, "MTT")).slice().sort(), mtt);
  assert.deepEqual(codes(selection(selections, "CAFE_AND_MTT")).slice().sort(), payload.rows.KOSPI.filter((row) => row.confirmation.cafePass && row.confirmation.minerviniPass).map((row) => row.code).sort());
});

test("전략 flag R·F·F2·B·C·H2·H3·I 선택이 원본 flag와 동일", () => {
  const payload = makePayload();
  const selections = selectionsFor(payload);
  for (const key of ["R", "F", "F2", "B", "C", "H2", "H3", "I"]) {
    const expected = payload.rows.KOSPI.filter((row) => row.strategy.flags[key]).map((row) => row.code).sort();
    assert.deepEqual(codes(selection(selections, `FLAG_${key}`)).slice().sort(), expected, `FLAG_${key}`);
  }
});

test("AND 조합 전략이 각 조건의 교집합", () => {
  const payload = makePayload();
  const selections = selectionsFor(payload);
  const rows = payload.rows.KOSPI;
  const expected = rows.filter((row) => row.leader.grade === "A" && row.scout.rs20 >= 80 && simulationCategory(row).actionable).map((row) => row.code).sort();
  assert.deepEqual(codes(selection(selections, "LEADER_A_AND_RS80_AND_ACTIONABLE")).slice().sort(), expected);
  const leaderARs80 = rows.filter((row) => row.leader.grade === "A" && row.scout.rs20 >= 80).map((row) => row.code).sort();
  assert.deepEqual(codes(selection(selections, "LEADER_A_AND_RS80")).slice().sort(), leaderARs80);
  const drawdown = rows.filter((row) => row.scout.drawdownFromHighPct <= -20 && row.scout.drawdownFromHighPct > -30).map((row) => row.code).sort();
  assert.deepEqual(codes(selection(selections, "DRAWDOWN_20_30")).slice().sort(), drawdown);
});

test("조건형 전략은 개수를 자르지 않는다", () => {
  const payload = makePayload({ size: 24 });
  const selections = selectionsFor(payload);
  const flagC = selection(selections, "FLAG_C");
  const expected = payload.rows.KOSPI.filter((row) => row.strategy.flags.C).length;
  assert.equal(flagC.members.length, expected);
  assert.ok(expected > 10);
  assert.equal(strategyById("FLAG_C").topN ?? null, null);
});

test("순위 전략은 정확히 TOP-N만 담는다", () => {
  const selections = selectionsFor(makePayload({ size: 24 }));
  for (const [id, expected] of [["LEADER_TOP1", 1], ["LEADER_TOP3", 3], ["LEADER_TOP5", 5], ["LEADER_TOP10", 10], ["LEADER_TOP20", 20]]) {
    assert.equal(selection(selections, id).members.length, expected, id);
    assert.equal(selection(selections, id).targetCount, expected, id);
  }
});

test("같은 종목이 여러 전략에 포함되고, 한 전략 안에서는 중복되지 않는다", () => {
  const selections = selectionsFor(makePayload());
  const sample = codes(selection(selections, "LEADER_TOP3"))[0];
  const containing = selections.filter((row) => row.market === "KOSPI" && codes(row).includes(sample));
  assert.ok(containing.length > 1);
  for (const row of selections) assert.equal(new Set(codes(row)).size, row.members.length, `${row.strategyId} 중복`);
});

test("저장된 snapshot의 당시 factor는 불변", () => {
  const { dir, tracker } = tempTracker();
  const payload = makePayload();
  const history = historyMapFor(payload);
  tracker.recordSnapshot(payload, history);
  const before = readFileSync(path.join(dir, "strategy-oos-history.jsonl"), "utf8");
  const changed = makePayload();
  for (const row of changed.rows.KOSPI) {
    row.leader.grade = "D";
    row.leader.score = 1;
    row.scout.rs20 = 1;
  }
  tracker.recordSnapshot(changed, history);
  assert.equal(readFileSync(path.join(dir, "strategy-oos-history.jsonl"), "utf8"), before);
  const stored = readJsonl(path.join(dir, "strategy-oos-history.jsonl")).records;
  assert.equal(stored.find((row) => row.market === "KOSPI" && row.factors.leaderGrade === "A") !== undefined, true);
});

test("과거 거래일 snapshot 소급 생성 금지", () => {
  const { dir, tracker } = tempTracker();
  const stalePayload = makePayload({ marketDataAsOf: "2026-08-19" });
  const staleHistory = new Map();
  const series = makeSeries().filter((row) => row.date <= "20260819");
  for (const market of ["KOSPI", "KOSDAQ"]) for (const row of stalePayload.rows[market]) staleHistory.set(row.code, series);
  const result = tracker.recordSnapshot(stalePayload, staleHistory);
  assert.equal(result.recorded, false);
  assert.equal(result.reason, "NOT_TODAY_TRADING_DATE");
  assert.equal(existsSync(path.join(dir, "strategy-oos-history.jsonl")), false);
  const state = tracker.readState();
  assert.equal(state.skipped.at(-1).reason, "NOT_TODAY_TRADING_DATE");
});

test("결측 factor는 0이 아니라 제외로 처리한다", () => {
  const payload = makePayload();
  const target = payload.rows.KOSPI[0];
  target.scout.rs20 = null;
  target.scout.riskScore = null;
  const features = featuresFor(payload);
  const feature = features.byMarket.KOSPI.find((row) => row.code === target.code);
  assert.equal(feature.rs20, null);
  assert.equal(feature.riskScore, null);
  const selections = buildSelections(features, { signalDate: SIGNAL_DATE, recordedAt: AFTER_CLOSE.toISOString() });
  assert.ok(!codes(selection(selections, "RS_TOP10")).includes(target.code));
  assert.ok(!codes(selection(selections, "LEADER_A_AND_RS80")).includes(target.code));
  assert.ok(!codes(selection(selections, "LEADER_A_AND_RISK24")).includes(target.code));
  assert.equal(selection(selections, "RS_TOP10").naCount, 1);
  const broken = makePayload();
  broken.rows.KOSPI[1].price = 0;
  broken.rows.KOSPI[1].quote.price = 0;
  const brokenFeatures = featuresFor(broken);
  assert.equal(brokenFeatures.byMarket.KOSPI.length, 11);
  assert.equal(brokenFeatures.diagnostics.at(0).reason, "NO_PRICE");
  const brokenSelections = buildSelections(brokenFeatures, { signalDate: SIGNAL_DATE, recordedAt: AFTER_CLOSE.toISOString() });
  const leaderTop10 = selection(brokenSelections, "LEADER_TOP10");
  assert.equal(leaderTop10.targetCount, 10);
  assert.equal(leaderTop10.validCount, 9);
});

test("같은 날 같은 시장 benchmark와 trade/cohort 구분", async () => {
  const { tracker, clock } = tempTracker();
  const payload = makePayload();
  const history = historyMapFor(payload);
  const perCode = new Map();
  let offset = 0;
  for (const market of ["KOSPI", "KOSDAQ"]) {
    for (const row of payload.rows[market]) {
      perCode.set(row.code, makeSeries(1000 + offset * 50));
      offset += 1;
    }
  }
  tracker.recordSnapshot(payload, history);
  clock.value = new Date("2026-09-30T07:00:00Z");
  await tracker.evaluatePending(async (code) => perCode.get(code));
  const { records, selections } = tracker.readAll();
  const kospi = records.filter((row) => row.market === "KOSPI");
  const expectedBenchmark = kospi.reduce((sum, row) => sum + row.outcomes["5"].netReturnPct, 0) / kospi.length;
  for (const row of kospi) {
    assert.ok(Math.abs(row.outcomes["5"].benchmarkReturnPct - expectedBenchmark) < 1e-9);
    assert.ok(Math.abs(row.outcomes["5"].excessReturnPct - (row.outcomes["5"].netReturnPct - expectedBenchmark)) < 1e-9);
  }
  const summary = buildStrategyOosSummary(records, selections, {});
  const top10 = summary.markets.KOSPI.find((row) => row.id === "LEADER_TOP10");
  assert.equal(top10.horizons["5"].trades.n, 10);
  assert.equal(top10.horizons["5"].cohorts.n, 1);
  const cohortMembers = selections.find((row) => row.strategyId === "LEADER_TOP10" && row.market === "KOSPI").members;
  const manual = cohortMembers.map((member) => records.find((row) => row.market === "KOSPI" && row.code === member.code).outcomes["5"].netReturnPct).reduce((sum, value) => sum + value, 0) / cohortMembers.length;
  assert.ok(Math.abs(top10.horizons["5"].cohorts.avgReturnPct - manual) < 1e-3);
  assert.equal(top10.horizons["5"].sampleGrade.key, "insufficient");
});

test("simulator ledger와 Ranking V2 OOS 파일 불변", async () => {
  const { dir, tracker, clock } = tempTracker();
  const ledgerFile = path.join(dir, "simulation-ledger.json");
  const rankingFile = path.join(dir, "ranking-live-history.jsonl");
  const rankingSummary = path.join(dir, "ranking-live-summary.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(ledgerFile, JSON.stringify({ version: 1, positions: [{ code: "005930" }], closed: [], runs: [] }), "utf8");
  writeFileSync(rankingFile, `${JSON.stringify({ signalDate: SIGNAL_DATE, market: "KOSPI", ticker: "005930" })}\n`, "utf8");
  writeFileSync(rankingSummary, JSON.stringify({ observationCount: 1 }), "utf8");
  const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const before = [ledgerFile, rankingFile, rankingSummary].map(hash);
  const payload = makePayload();
  const history = historyMapFor(payload);
  tracker.recordSnapshot(payload, history);
  clock.value = new Date("2026-09-30T07:00:00Z");
  await tracker.evaluatePending(async () => makeSeries());
  tracker.summary({ market: "ALL" });
  assert.deepEqual([ledgerFile, rankingFile, rankingSummary].map(hash), before);
});

test("같은 입력이면 선택 결과가 항상 같다", () => {
  const first = selectionsFor(makePayload());
  const second = selectionsFor(makePayload());
  const strip = (rows) => rows.map(({ recordedAt, ...rest }) => rest);
  assert.deepEqual(strip(first), strip(second));
});

test("진행중 cohort와 확정 성과를 분리 집계", async () => {
  const { tracker, clock } = tempTracker();
  const payload = makePayload();
  const history = historyMapFor(payload);
  tracker.recordSnapshot(payload, history);
  const shortSeries = makeSeries().filter((row) => row.date <= "20260826");
  clock.value = new Date("2026-08-27T07:00:00Z");
  await tracker.evaluatePending(async () => shortSeries);
  const { records, selections } = tracker.readAll();
  const summary = buildStrategyOosSummary(records, selections, {});
  const top10 = summary.markets.KOSPI.find((row) => row.id === "LEADER_TOP10");
  assert.ok(top10.horizons["3"].trades.n > 0);
  assert.equal(top10.horizons["10"].trades.n, 0);
  assert.equal(top10.pending.cohorts, 1);
  assert.equal(top10.pending.trades, 10);
  assert.ok(Number.isFinite(top10.pending.avgReturnPct));
  assert.ok(records.every((row) => row.status === "PENDING"));
  assert.ok(records.every((row) => Number.isFinite(row.live.currentReturnPct)));
});

test("표본수 등급 경계와 합의 cohort 메타", async () => {
  const { tracker } = tempTracker();
  const payload = makePayload();
  tracker.recordSnapshot(payload, historyMapFor(payload));
  const { records, selections } = tracker.readAll();
  const summary = buildStrategyOosSummary(records, selections, {});
  const strategy = summary.markets.ALL.find((row) => row.id === "LEADER_TOP10");
  assert.equal(strategy.horizons["5"].sampleGrade.label, "표본 부족");
  assert.equal(summary.meta.strategyCount, 107);
  assert.equal(summary.meta.rankingStrategyCount, 21);
  assert.equal(summary.meta.conditionStrategyCount, 86);
  assert.ok(summary.markets.ALL.some((row) => row.id === "CONSENSUS_5S_3A"));
});
