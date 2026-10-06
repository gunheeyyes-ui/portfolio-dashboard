import test from "node:test";
import assert from "node:assert/strict";
import { buildEntryTransitionLookup } from "./entry-transition.js";

const selections = [
  { signalDate: "2026-09-17", market: "KOSDAQ", strategyId: "ACTIONABLE_ALL", members: [{ code: "A" }, { code: "R" }] },
  { signalDate: "2026-09-18", market: "KOSDAQ", strategyId: "ACTIONABLE_ALL", members: [{ code: "A" }] },
  { signalDate: "2026-09-21", market: "KOSDAQ", strategyId: "ACTIONABLE_ALL", members: [{ code: "A" }, { code: "M" }] },
  { signalDate: "2026-09-21", market: "KOSPI", strategyId: "ACTIONABLE_ALL", members: [{ code: "K" }] },
  { signalDate: "2026-09-21", market: "KOSDAQ", strategyId: "CAFE", members: [{ code: "IGNORED" }] }
];

test("classifies maintained actionable signals and exposes consecutive plus cumulative history", () => {
  const lookup = buildEntryTransitionLookup(selections, "2026-09-22");
  assert.deepEqual(lookup.classify("KOSDAQ", "A"), {
    key: "maintain",
    label: "유지 4일",
    previousSignalDate: "2026-09-21",
    streakDays: 4,
    totalSignalDays: 4,
    firstSignalDate: "2026-09-17",
    lastSeenBefore: "2026-09-21",
    gapTradingDays: 0,
    recentSignalDates: ["2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22"],
    historyStartDate: "2026-09-17"
  });
});

test("distinguishes first tracked entry from re-entry and reports prior appearances", () => {
  const lookup = buildEntryTransitionLookup(selections, "2026-09-22");
  const fresh = lookup.classify("KOSDAQ", "N");
  const reentry = lookup.classify("KOSDAQ", "R");
  const maintained = lookup.classify("KOSDAQ", "M");

  assert.equal(fresh.key, "new");
  assert.equal(fresh.totalSignalDays, 1);
  assert.deepEqual(fresh.recentSignalDates, ["2026-09-22"]);

  assert.equal(reentry.key, "reentry");
  assert.equal(reentry.totalSignalDays, 2);
  assert.equal(reentry.firstSignalDate, "2026-09-17");
  assert.equal(reentry.lastSeenBefore, "2026-09-17");
  assert.equal(reentry.gapTradingDays, 2);
  assert.deepEqual(reentry.recentSignalDates, ["2026-09-17", "2026-09-22"]);

  assert.equal(maintained.key, "maintain");
  assert.equal(maintained.streakDays, 2);
  assert.equal(maintained.totalSignalDays, 2);
});

test("uses market-specific actionable history", () => {
  const lookup = buildEntryTransitionLookup(selections, "2026-09-22");
  assert.equal(lookup.classify("KOSPI", "K").key, "maintain");
  assert.equal(lookup.classify("KOSPI", "A").key, "new");
});

test("returns unknown when there is no prior actionable snapshot", () => {
  const lookup = buildEntryTransitionLookup([], "2026-09-22");
  assert.deepEqual(lookup.classify("KOSDAQ", "A"), {
    key: "unknown",
    label: "이력없음",
    previousSignalDate: null,
    streakDays: null,
    totalSignalDays: null,
    firstSignalDate: null,
    lastSeenBefore: null,
    gapTradingDays: null,
    recentSignalDates: [],
    historyStartDate: null
  });
});
