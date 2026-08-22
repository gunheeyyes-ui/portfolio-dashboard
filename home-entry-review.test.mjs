import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const js = readFileSync(new URL("./public/index-entry-review.js", import.meta.url), "utf8");
const css = readFileSync(new URL("./public/home-entry-compact.css", import.meta.url), "utf8");
const review = readFileSync(new URL("./public/entry-review-candidates.js", import.meta.url), "utf8");

test("home dashboard keeps the broadened entry shortlist before the market explorer", () => {
  assert.match(html, /<h2>오늘 진입후보<\/h2>/);
  assert.match(html, /home-entry-compact\.css/);
  assert.match(html, /<table class="holdings-table home-entry-table">/);
  assert.match(html, /<tbody id="homeEntryCandidates">/);
  assert.ok(html.indexOf("homeEntryCandidates") < html.indexOf("screenerMarkets"));
  assert.match(js, /종목 · 가격\/등락/);
  assert.match(js, />Leader<\/th>/);
  assert.match(js, />타이밍<\/th>/);
  assert.match(js, />반등<\/th>/);
  assert.match(js, />기존진입<\/th>/);
  assert.match(html, /실제 주문 체결을 뜻하지 않습니다/);
});

test("home shortlist stays one-row compact and moves price context beside the stock", () => {
  assert.match(js, /home-entry-compact\.css/);
  assert.match(js, /class="home-entry-stock"/);
  assert.match(js, /class="home-stock-meta"/);
  assert.match(js, />전 \$\{pct\(row\.changeRate\)\}<\/span>/);
  assert.match(js, />3일 \$\{pct\(row\.changeRate3d\)\}<\/span>/);
  assert.match(js, />낙 \$\{pct\(row\.drawdownFromHighPct\)\}<\/span>/);
  assert.doesNotMatch(js, /class="code"/);
  assert.match(css, /min-width: 0 !important/);
  assert.match(css, /overflow-x: hidden !important/);
  assert.match(css, /th:nth-child\(9\)/);
  assert.doesNotMatch(css, /th:nth-child\(10\)/);
  assert.match(css, /white-space: nowrap/);
});

test("home shortlist keeps market Leader rank for validated logic but hides duplicate ranks from display", () => {
  assert.match(review, /leaderRank/);
  assert.match(js, /leaderRank: numberOrNull\(feature\.leaderRank\)/);
  assert.match(js, /화면에는 등급\/점수만 표시/);
  assert.match(js, /\$\{row\.leaderGrade \?\? "-"\}\$\{fmtInt\.format\(row\.leaderScore\)\}/);
  assert.doesNotMatch(js, /\$\{fmtInt\.format\(row\.leaderRank\)\}위·/);
  assert.match(js, /row\.timingScore/);
  assert.match(js, /colspan="9"/);
});

test("home stock cell exposes confirmation and StockEasy badges", () => {
  assert.match(js, /MTT\(미네르비니\) 통과/);
  assert.match(js, /CAFE 전략 통과/);
  assert.match(js, /SE-MOM/);
  assert.match(js, /SE-PEAK/);
  assert.match(js, /SE-VALUE/);
  assert.match(js, /stockEasy\.seMomentum/);
  assert.match(js, /stockEasy\.sePeak/);
  assert.match(js, /stockEasy\.seValue/);
});

test("home rebound cell exposes Ranking V2 tier plus rebound-priority and scout ranks", () => {
  assert.match(js, /rankingV2Tier/);
  assert.match(js, /rankingV2Rank/);
  assert.match(js, /scoutRank/);
  assert.match(js, /반등우선\(Ranking V2\) 시장 내/);
  assert.match(js, /반등후보\(Scout\) 시장 내/);
  assert.match(js, /home-rebound-tier/);
  assert.match(js, /home-rebound-rank/);
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
