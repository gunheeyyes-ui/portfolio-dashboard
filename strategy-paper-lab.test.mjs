import assert from "node:assert/strict";
import test from "node:test";
import { buildStrategyPaperLab, rankStrategyPaperCandidates, STRATEGY_PAPER_HOLDS } from "./strategy-paper-lab.js";
import { enabledStrategies } from "./strategy-oos-registry.js";

const registry = [
  { id: "TIMING_TOP3", displayName: "종합타이밍 TOP3", group: "ranking" },
  { id: "LEADER_TOP3", displayName: "Leader TOP3", group: "ranking" },
  { id: "FLAG_I", displayName: "매수보류 대조군", group: "entry" }
];
const row = (id, net, excess, n = 24) => ({
  id, horizons: { "10": { cohorts: { n, avgReturnPct: net, avgExcessReturnPct: excess, winRatePct: 60 } } }
});
const summary = {
  meta: { lastDate: "2026-10-08", missingSnapshotDates: ["2026-10-06"] },
  markets: { ALL: [row("TIMING_TOP3", 2.322, 1.515), row("LEADER_TOP3", -4.954, -5.76), row("FLAG_I", 4, 2)] }
};
const selection = (id, date, code, rank = 1) => ({
  strategyId: id, signalDate: date, market: "KOSPI", members: [{ code, rank }]
});
const record = (date, code, after = true) => ({
  signalDate: date, market: "KOSPI", code, name: code,
  signalPrice: 10000, entryDate: after ? "20261013" : "20260908", entryOpen: 10000,
  factors: { liquidityScore: 80 },
  outcomes: Object.fromEntries(STRATEGY_PAPER_HOLDS.map((hold) => [String(hold), {
    targetTradingDate: "20261016", netReturnPct: 2, grossReturnPct: 2.23, exitPrice: 10223
  }]))
});

test("tracker covers all immutable 107 registry strategies without changing old arena", () => {
  assert.equal(enabledStrategies().length, 107);
  assert.deepEqual(STRATEGY_PAPER_HOLDS, [3, 5, 10, 20]);
});

test("OOS candidate screening excludes losers and control groups", () => {
  const selected = rankStrategyPaperCandidates({ summary, registry });
  assert.deepEqual(selected.shortlistedIds, ["TIMING_TOP3"]);
  assert.equal(selected.eligibleCount, 1);
  assert.equal(selected.candidates.find((c) => c.id === "FLAG_I").qualified, false);
});

test("independent cash accounts begin on start date, not retroactively", () => {
  const records = [record("2026-09-07", "OLD", false), record("2026-10-12", "NEW")];
  const selections = [
    selection("TIMING_TOP3", "2026-09-07", "OLD"),
    selection("TIMING_TOP3", "2026-10-12", "NEW")
  ];
  const result = buildStrategyPaperLab({ records, selections, summary, registry });
  assert.equal(result.diagnostics.strategyCount, 3);
  assert.equal(result.diagnostics.independentAccountCount, 12);
  assert.equal(result.policy.realOrderApiUsed, false);
  assert.equal(result.diagnostics.oosMissingSnapshotDates.length, 1);
  const leader = result.leaderboard.find((x) => x.id === "TIMING_TOP3");
  assert.equal(leader.shortlisted, false); // Only one clean cohort; summary N=24 must not bypass the quality gate.
  for (const hold of STRATEGY_PAPER_HOLDS) {
    assert.equal(leader.holds[String(hold)].signalCount, 1);
    assert.equal(leader.holds[String(hold)].closedTrades, 1);
    assert.ok(leader.holds[String(hold)].totalReturnPct > 0);
  }
  assert.equal(result.leaderboard.find((x) => x.id === "LEADER_TOP3").holds["10"].closedTrades, 0);
});

test("suspect entry is blocked before capacity allocation", () => {
  const records = [record("2026-10-12", "BLOCKED")];
  const selections = [selection("TIMING_TOP3", "2026-10-12", "BLOCKED")];
  const marketStatuses = [{
    signalDate: "2026-10-12", market: "KOSPI", code: "BLOCKED", checkedAt: "2026-10-12T06:30:00Z",
    blockEntry: true, blockReasons: ["MANAGED_ISSUE"]
  }];
  const result = buildStrategyPaperLab({ records, selections, summary, registry, marketStatuses });
  const account = result.leaderboard.find((x) => x.id === "TIMING_TOP3").holds["10"];
  assert.equal(account.closedTrades, 0);
  assert.equal(account.blockedSignals, 1);
  assert.equal(account.totalReturnPct, 0);
});

test("candidate groups with nearly identical picks are not double-shortlisted", () => {
  const s = {
    meta: { lastDate: "2026-10-08" },
    markets: { ALL: [row("TIMING_TOP3", 2.3, 1.5), row("LEADER_TOP3", 2.2, 1.4)] }
  };
  const same = ["2026-10-07", "2026-10-08"].flatMap((date) =>
    [selection("TIMING_TOP3", date, "ABC"), selection("LEADER_TOP3", date, "ABC")]);
  assert.deepEqual(rankStrategyPaperCandidates({ summary: s, registry: registry.slice(0, 2), selections: same }).shortlistedIds, ["TIMING_TOP3"]);
});

test("shortlist recomputes OOS using integrity-comparable cohorts, never raw outlier gains", () => {
  const dates = Array.from({ length: 22 }, (_, i) => `2026-08-${String(10 + i).padStart(2, "0")}`);
  const selections = dates.map((date, i) => selection("TIMING_TOP3", date, String(100000 + i)));
  const records = dates.map((date, i) => {
    const suspect = i === 0;
    return {
      ...record(date, String(100000 + i)),
      outcomes: { "10": {
        targetTradingDate: "20260915",
        netReturnPct: suspect ? 300 : 2,
        excessReturnPct: suspect ? 299 : 1,
        exitPrice: suspect ? 1000000 : 10223
      } }
    };
  });
  const ranked = rankStrategyPaperCandidates({ summary, selections, records, registry: registry.slice(0, 1) });
  assert.deepEqual(ranked.shortlistedIds, []); // Post-hoc removing one anomalous winner must not qualify a strategy.
  assert.equal(ranked.candidates[0].reason, "UNVERIFIED_OUTCOME_QUARANTINE");
  assert.equal(ranked.candidates[0].oos.n, 21);
  assert.equal(ranked.candidates[0].oos.netPct, 2);
  assert.equal(ranked.candidates[0].oos.quarantinedTrades, 1);
  assert.equal(ranked.candidates[0].rawOos.netPct, 2.322);
});
