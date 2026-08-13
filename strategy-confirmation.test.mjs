import test from "node:test";
import assert from "node:assert/strict";
import { buildStrategyConfirmation } from "./strategy-confirmation.js";

test("CAFE and MTT confirmation definitions remain independent", () => {
  const result = buildStrategyConfirmation({
    price: 150,
    changeRate: 1,
    changeRate3d: 2,
    leader: {
      grade: "A",
      drawdown52wPct: -10,
      ret5: -3,
      monthAboveMa5: true,
      monthMa5Rising: true,
      ma50: 130,
      ma150: 115,
      ma200: 100,
      ma200Prev20: 95,
      low52w: 100,
      high52w: 180
    },
    scout: { drawdownFromHighPct: -10, stabilizeScore: 20, riskScore: 20 },
    investor: { foreignNetAmount5d: 1, instNetAmount5d: 0 }
  });
  assert.equal(result.cafePass, true);
  assert.equal(result.minerviniPass, true);
  assert.equal(result.leaderReboundPass, false);
});

test("high scout risk remains excluded without relaxing strategy gates", () => {
  const result = buildStrategyConfirmation({
    leader: { grade: "A" },
    scout: { drawdownFromHighPct: -30, stabilizeScore: 80, riskScore: 65 }
  });
  assert.equal(result.reboundState.key, "risk");
  assert.equal(result.leaderReboundPass, false);
  assert.equal(result.cafePass, false);
  assert.equal(result.minerviniPass, false);
});
