import assert from "node:assert/strict";
import test from "node:test";

import { buildCandidateFreshness } from "./candidate-freshness-service.js";

function selection(signalDate, strategyId, members) {
  return {
    signalDate,
    market: "KOSPI",
    strategyId,
    members: members.map((code) => ({ code }))
  };
}

function day(signalDate, { core = [], strong = [] } = {}) {
  return [
    selection(signalDate, "LEADER_TOP10", core),
    selection(signalDate, "CONSENSUS_5S_3A", core),
    selection(signalDate, "LEADER_A_AND_RS80", strong),
    selection(signalDate, "CONSENSUS_AXIS_3_PLUS", strong)
  ];
}

test("classifies current candidates as 신규 / 유지 N일 / 재진입 on signal-day history", () => {
  const selections = [
    ...day("2026-09-01", { core: ["000002"] }),
    ...day("2026-09-02"),
    ...day("2026-09-03", { strong: ["000001"] }),
    ...day("2026-09-04", { core: ["000001"] })
  ];
  const result = buildCandidateFreshness({
    selections,
    signalDate: "2026-09-05",
    candidates: [
      { code: "000001", market: "KOSPI", leaderRank: 4 },
      { code: "000002", market: "KOSPI", leaderRank: 7 },
      { code: "000003", market: "KOSPI", leaderRank: 8 }
    ]
  });
  assert.equal(result.previousSignalDate, "2026-09-04");
  assert.deepEqual(result.rows.map((row) => [row.code, row.status, row.streakTradingDays]), [
    ["000001", "MAINTAIN", 3],
    ["000002", "REENTRY", 1],
    ["000003", "NEW", 1]
  ]);
  assert.equal(result.rows[1].gapTradingDays, 3);
  assert.deepEqual(result.counts, { new: 1, maintain: 1, reentry: 1 });
});

test("maintain streak crosses weekends because it follows recorded signal dates, not calendar days", () => {
  const selections = [
    ...day("2026-09-03", { core: ["000001"] }),
    ...day("2026-09-04", { core: ["000001"] })
  ];
  const result = buildCandidateFreshness({
    selections,
    signalDate: "2026-09-07",
    candidates: [{ code: "000001", market: "KOSPI", leaderRank: 5 }]
  });
  assert.equal(result.rows[0].status, "MAINTAIN");
  assert.equal(result.rows[0].streakTradingDays, 3);
});

test("reports previous-signal Leader rank delta without changing ranking logic", () => {
  const selections = [
    ...day("2026-09-03", { core: ["000001"] }),
    ...day("2026-09-04", { core: ["000001"] })
  ];
  const records = [{
    signalDate: "2026-09-04",
    market: "KOSPI",
    code: "000001",
    factors: { leaderRank: 8 }
  }];
  const result = buildCandidateFreshness({
    records,
    selections,
    signalDate: "2026-09-05",
    candidates: [{ code: "000001", market: "KOSPI", leaderRank: 5 }]
  });
  assert.equal(result.rows[0].previousLeaderRank, 8);
  assert.equal(result.rows[0].currentLeaderRank, 5);
  assert.equal(result.rows[0].leaderRankDelta, -3);
});
