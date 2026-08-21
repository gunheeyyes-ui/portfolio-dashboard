import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("leader and scout load both markets in one request and render market sections", () => {
  const leader = read("./public/leader.js");
  const scout = read("./public/scout.js");

  assert.match(leader, /api\/leader\?market=ALL/);
  assert.match(scout, /api\/scout\?market=ALL/);
  assert.match(leader, /market-table-divider/);
  assert.match(scout, /market-table-divider/);
  assert.doesNotMatch(leader, /#marketTabs.*addEventListener/s);
  assert.doesNotMatch(scout, /#marketTabs.*addEventListener/s);
});

test("mobile rebound headers suppress long helper copy", () => {
  const css = read("./public/mobile-compact-ranking-tune.css");
  assert.match(css, /\.scout-table \.sort-btn small[\s\S]*display: none !important/);
});

test("simulator shows drawdown and explicit three-day move", () => {
  const simulator = read("./public/simulator.js");
  assert.match(simulator, /낙폭 <b>\$\{pct\(row\.drawdownFromHighPct\)\}/);
  assert.match(simulator, /3일등락 <b>\$\{pct\(row\.changeRate3d\)\}/);
});

test("strategy candidates expose an explicit non-performance review order", () => {
  const strategies = read("./public/strategies.js");
  assert.match(strategies, /strategyCount\(b\) - strategyCount\(a\)/);
  assert.match(strategies, /성과순위 아님/);
  assert.match(strategies, /#\$\{index \+ 1\} · \$\{strategyCount\(row\)\}전략/);
});
