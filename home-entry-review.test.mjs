import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const js = readFileSync(new URL("./public/index-entry-review.js", import.meta.url), "utf8");

test("home dashboard shows the broadened entry shortlist before the market explorer", () => {
  assert.match(html, /<h2>오늘 진입후보<\/h2>/);
  assert.match(html, /<table class="holdings-table home-entry-table">/);
  assert.match(html, /<tbody id="homeEntryCandidates">/);
  assert.ok(html.indexOf("homeEntryCandidates") < html.indexOf("screenerMarkets"));
  assert.match(html, /<th>후보<\/th>/);
  assert.match(html, /<th>Leader<\/th>/);
  assert.match(html, /<th>RS<\/th>/);
  assert.match(html, /<th>전략·계열<\/th>/);
  assert.match(html, /<th>Risk\/Stab<\/th>/);
  assert.match(html, /<th>실제<\/th>/);
  assert.match(html, />기존 실제진입<\/button>/);
});

test("home shortlist reuses the same strategy and entry-review engines as simulator", () => {
  assert.match(js, /buildStrategyCandidates/);
  assert.match(js, /buildEntryReviewCandidates/);
  assert.match(js, /mergeEntryCandidates/);
  assert.match(js, /feature\.actionable !== true/);
  assert.match(js, /🔥 핵심/);
  assert.match(js, /⭐ 강한/);
  assert.match(js, /✅ 실제/);
  assert.match(js, /rows\.map\(renderRow\)/);
});
