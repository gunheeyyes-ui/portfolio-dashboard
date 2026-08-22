import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const js = readFileSync(new URL("./public/index-entry-review.js", import.meta.url), "utf8");

test("home dashboard shows the broadened entry shortlist before the market explorer", () => {
  assert.match(html, /<h2>오늘 진입후보<\/h2>/);
  assert.match(html, /id="homeEntryCandidates"/);
  assert.ok(html.indexOf("homeEntryCandidates") < html.indexOf("screenerMarkets"));
  assert.match(html, /🔥 핵심후보/);
  assert.match(html, /⭐ 강한후보/);
  assert.match(html, /✅ 실제진입/);
  assert.match(html, />기존 실제진입<\/button>/);
});

test("home shortlist reuses the same strategy and entry-review engines as simulator", () => {
  assert.match(js, /buildStrategyCandidates/);
  assert.match(js, /buildEntryReviewCandidates/);
  assert.match(js, /mergeEntryCandidates/);
  assert.match(js, /feature\.actionable !== true/);
  assert.match(js, /Leader TOP10 \+ 5전략\+ \+ 3계열\+/);
  assert.match(js, /Leader A \+ RS80\+ \+ 3계열\+/);
});
