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
  assert.match(js, />낙폭\(2년\)<\/th>/);
  assert.match(js, />Leader<\/th>/);
  assert.match(js, />타이밍<\/th>/);
  assert.match(js, />반등<\/th>/);
  assert.match(js, /home-entry-risk-head/);
  assert.doesNotMatch(js, />기존진입<\/th>/);
  assert.match(html, /아래 ‘기존 실제진입’ 보기에서 따로 확인/);
});

test("home shortlist keeps price changes beside the stock and drawdown in its own column", () => {
  assert.match(js, /home-entry-compact\.css/);
  assert.match(js, /class="home-entry-stock"/);
  assert.match(js, /class="home-stock-meta"/);
  assert.match(js, />전 \$\{pct\(row\.changeRate\)\}<\/span>/);
  assert.match(js, />3일 \$\{pct\(row\.changeRate3d\)\}<\/span>/);
  assert.match(js, /class="home-entry-drawdown"/);
  assert.match(js, /최근 2년 고점 대비 현재가 하락률/);
  assert.doesNotMatch(js, /class="code"/);
  assert.match(css, /min-width: 0 !important/);
  assert.match(css, /overflow-x: hidden !important/);
  assert.match(css, /th:nth-child\(9\)/);
  assert.doesNotMatch(css, /th:nth-child\(10\)/);
  assert.match(css, /9-column shortlist/);
  assert.match(css, /white-space: nowrap/);
});

test("home shortlist drops actual-only rows because the existing-entry view remains below", () => {
  assert.match(js, /filter\(\(row\) => row\.coreCandidate \|\| row\.strongCandidate\)/);
  assert.doesNotMatch(js, /✅기존/);
  assert.match(js, /colspan="9"/);
  assert.doesNotMatch(js, /home-entry-actual/);
});

test("home shortlist uses larger desktop typography and separates rebound from risk", () => {
  assert.match(css, /font-size: 12px/);
  assert.match(css, /font-size: 11px/);
  assert.match(css, /home-entry-table th:nth-child\(8\)/);
  assert.match(css, /home-entry-table th:nth-child\(9\)/);
  assert.match(css, /border-left: 1px solid rgba\(148, 163, 184, 0\.22\)/);
  assert.match(css, /padding-left: 10px/);
});

test("home shortlist keeps market Leader rank for validated logic but hides duplicate ranks from display", () => {
  assert.match(review, /leaderRank/);
  assert.match(js, /leaderRank: numberOrNull\(feature\.leaderRank\)/);
  assert.match(js, /화면에는 등급\/점수만 표시/);
  assert.match(js, /\$\{row\.leaderGrade \?\? "-"\}\$\{fmtInt\.format\(row\.leaderScore\)\}/);
  assert.doesNotMatch(js, /\$\{fmtInt\.format\(row\.leaderRank\)\}위·/);
  assert.match(js, /row\.timingScore/);
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
