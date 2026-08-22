import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const js = readFileSync(new URL("./public/index-entry-review.js", import.meta.url), "utf8");
const css = readFileSync(new URL("./public/home-entry-compact.css", import.meta.url), "utf8");
const review = readFileSync(new URL("./public/entry-review-candidates.js", import.meta.url), "utf8");

test("home dashboard shows the broadened entry shortlist before the market explorer", () => {
  assert.match(html, /<h2>오늘 진입후보<\/h2>/);
  assert.match(html, /home-entry-compact\.css/);
  assert.match(html, /<table class="holdings-table home-entry-table">/);
  assert.match(html, /<tbody id="homeEntryCandidates">/);
  assert.ok(html.indexOf("homeEntryCandidates") < html.indexOf("screenerMarkets"));
  assert.match(html, /<th>후보<\/th>/);
  assert.match(html, />Leader순위<\/th>/);
  assert.match(html, />타이밍<\/th>/);
  assert.match(html, /<th>RS<\/th>/);
  assert.match(html, /<th>전략·계열<\/th>/);
  assert.match(html, /<th>Risk\/Stab<\/th>/);
  assert.match(html, />기존진입<\/th>/);
  assert.match(html, /실제 주문 체결을 뜻하지 않습니다/);
});

test("home shortlist stays one-row compact without code or market labels", () => {
  assert.match(js, /home-entry-compact\.css/);
  assert.match(js, /class="home-entry-stock"/);
  assert.doesNotMatch(js, /class="code"/);
  assert.doesNotMatch(js, /row\.market \|\| row\.sourceLabel/);
  assert.match(css, /min-width: 0 !important/);
  assert.match(css, /overflow-x: hidden !important/);
  assert.match(css, /th:nth-child\(10\)/);
  assert.match(css, /white-space: nowrap/);
});

test("home shortlist exposes timing score and explicit Leader rank", () => {
  assert.match(review, /timingScore: numberOrNull\(feature\.combinedScore\)/);
  assert.match(js, /timingScore: numberOrNull\(feature\.combinedScore\)/);
  assert.match(js, /row\.timingScore/);
  assert.match(js, /위·/);
  assert.match(js, /home-entry-timing/);
  assert.match(js, /✅기존/);
  assert.match(js, /colspan="10"/);
});

test("home shortlist reuses the same strategy and entry-review engines as simulator", () => {
  assert.match(js, /buildStrategyCandidates/);
  assert.match(js, /buildEntryReviewCandidates/);
  assert.match(js, /mergeEntryCandidates/);
  assert.match(js, /feature\.actionable !== true/);
  assert.match(js, /🔥핵심/);
  assert.match(js, /⭐강한/);
  assert.match(js, /rows\.map\(renderRow\)/);
});
