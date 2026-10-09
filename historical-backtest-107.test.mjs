import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const json = JSON.parse(readFileSync(new URL("./public/historical-backtest-107.json", import.meta.url), "utf8"));
const html = readFileSync(new URL("./public/historical-backtest-107.html", import.meta.url), "utf8");
const live = readFileSync(new URL("./public/strategy-paper-lab.html", import.meta.url), "utf8");

test("historical research snapshot has a full 107 strategy by four horizon comparison", () => {
  assert.equal(json.accounts.length, 107);
  assert.equal(json.universe, 200);
  assert.equal(json.rawObservations, 90909);
  assert.equal(json.completeObservations, 86709);
  assert.equal(json.observedEnd, "20260714");
  assert.equal(json.testStart, "20251024");
  assert.ok(json.accounts.every((a) => ["3","5","10","20"].every((h) =>
    ["train","test","full"].every((p) => a.holds[h]?.[p] && typeof a.holds[h][p].trades === "number"))));
  assert.ok(json.caveats.some((t) => /survivor bias/i.test(t)));
});

test("the historical UI explicitly distinguishes biased retrospective results from live OOS", () => {
  assert.match(html, /과거 재구성/);
  assert.match(html, /사후 종목선정 편향/);
  assert.match(html, /엄밀한 OOS가 아닙니다/);
  assert.match(live, /historical-backtest-107.html/);
});

test("zero-trade historical cohorts remain zero samples, not proven winning strategies", () => {
  const cafe = json.accounts.find((a) => a.id === "CAFE");
  assert.ok(cafe);
  assert.equal(cafe.matched, 0);
  assert.equal(cafe.holds["10"].test.trades, 0);
  assert.equal(cafe.holds["10"].test.pct, 0);
});
