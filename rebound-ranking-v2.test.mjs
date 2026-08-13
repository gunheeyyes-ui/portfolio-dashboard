import assert from "node:assert/strict";
import {
  compareReboundRankingV2,
  drawdownBand,
  rankMarketRowsV2,
  reboundRankingTier,
  stabilizeBand
} from "./public/rebound-ranking-v2.js";

function row(code, overrides = {}) {
  return {
    code,
    market: overrides.market ?? "KOSPI",
    changeRate: 0,
    changeRate3d: 0,
    scout: { drawdownFromHighPct: -30, riskScore: 25, stabilizeScore: 80, status: "관찰 목록", ...overrides.scout },
    leader: { grade: "C", score: 60, ...overrides.leader },
    confirmation: { cafePass: false, minerviniPass: false, ...overrides.confirmation },
    combined: { blocked: false, label: "관찰", score: 40, ...overrides.combined },
    supply: { liquidityScore: 50, totalNetAmount: 0, foreignStreak: 0, instStreak: 0, ...overrides.supply },
    strategy: { flags: {}, ...overrides.strategy }
  };
}

assert(compareReboundRankingV2(row("1", { confirmation: { minerviniPass: true } }), row("2")) < 0, "MTT must outrank an otherwise equal general candidate");
assert.equal(drawdownBand(-35), 0);
assert.equal(drawdownBand(-60), 2);
assert(compareReboundRankingV2(row("1", { scout: { drawdownFromHighPct: -35 } }), row("2", { scout: { drawdownFromHighPct: -60 } })) < 0, "-60 must not receive an extra drawdown advantage");
assert.equal(stabilizeBand(100), stabilizeBand(99), "100 and 99 must share a Stabilize band");
const leaderB = row("1", { leader: { grade: "B", score: 72 }, scout: { riskScore: 40, stabilizeScore: 60 } });
const strongerLeaderC = row("2", { leader: { grade: "C", score: 65 }, scout: { riskScore: 25, stabilizeScore: 90 }, confirmation: { minerviniPass: true } });
assert(compareReboundRankingV2(strongerLeaderC, leaderB) < 0, "Leader B must not automatically beat better MTT/Risk/Stabilize conditions");
const scout = row("3", { scout: { status: "정찰병 1주", riskScore: 50, drawdownFromHighPct: -45 } });
assert.equal(reboundRankingTier(scout), 2, "Scout status must not be hard-blocked merely for falling");
assert.equal(reboundRankingTier(row("4", { scout: { riskScore: 65 } })), 6, "Risk 65+ must be last");
assert.equal(reboundRankingTier(row("5", { scout: { drawdownFromHighPct: null } })), 6, "Missing drawdown must be last");
assert.equal(reboundRankingTier(row("6", { scout: { status: "추가매수 금지" } })), 6, "Existing no-add status must be last");
const rankedMarkets = ["KOSPI", "KOSDAQ"].map((market) => rankMarketRowsV2([row(`${market}2`, { market }), row(`${market}1`, { market, confirmation: { minerviniPass: true } })]));
assert(rankedMarkets.every((rows) => rows[0].code.endsWith("1")), "Each market must rank independently from position one");

console.log("Rebound Ranking V2 self-test: PASS");
