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

test("classifies maintained actionable signals and counts consecutive recorded days", () => {
  const lookup = buildEntryTransitionLookup(selections, "2026-09-22");
  assert.deepEqual(lookup.classify("KOSDAQ", "A"), {
    key: "maintain",
    label: "유지 4일",
    previousSignalDate: "2026-09-21",
    streakDays: 4
  });
});

test("distinguishes first tracked entry from re-entry", () => {
  const lookup = buildEntryTransitionLookup(selections, "2026-09-22");
  assert.equal(lookup.classify("KOSDAQ", "N").key, "new");
  assert.equal(lookup.classify("KOSDAQ", "R").key, "reentry");
  assert.equal(lookup.classify("KOSDAQ", "M").key, "maintain");
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
    streakDays: null
  });
});
