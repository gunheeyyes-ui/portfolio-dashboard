import test from "node:test";
import assert from "node:assert/strict";

import {
  CONSENSUS_DEFINITION_VERSION,
  CONSENSUS_FEATURED_STRATEGY_IDS,
  CONSENSUS_STRATEGIES
} from "./public/strategy-consensus-cohorts.js";

function strategy(id) {
  const found = CONSENSUS_STRATEGIES.find((item) => item.id === id);
  assert.ok(found, `missing strategy ${id}`);
  return found;
}

test("core cohort matches the live review definition", () => {
  const core = strategy("CONSENSUS_CORE");
  const base = {
    leaderRank: 10,
    strategyMatchCount: 5,
    strategyAxisCount: 3
  };

  assert.equal(core.selector(base), true);
  assert.equal(core.selector({ ...base, leaderRank: 11 }), false);
  assert.equal(core.selector({ ...base, strategyMatchCount: 4 }), false);
  assert.equal(core.selector({ ...base, strategyAxisCount: 2 }), false);
});

test("strong cohort matches the live review definition", () => {
  const strong = strategy("CONSENSUS_STRONG");
  const base = {
    leaderGrade: "A",
    rs20: 80,
    strategyMatchCount: 5,
    strategyAxisCount: 3
  };

  assert.equal(strong.selector(base), true);
  assert.equal(strong.selector({ ...base, leaderGrade: "B" }), false);
  assert.equal(strong.selector({ ...base, rs20: 79 }), false);
  assert.equal(strong.selector({ ...base, strategyAxisCount: 2 }), false);
});

test("core and strong are featured prospective OOS cohorts", () => {
  assert.equal(CONSENSUS_DEFINITION_VERSION, 2);
  assert.ok(CONSENSUS_FEATURED_STRATEGY_IDS.includes("CONSENSUS_CORE"));
  assert.ok(CONSENSUS_FEATURED_STRATEGY_IDS.includes("CONSENSUS_STRONG"));
});
