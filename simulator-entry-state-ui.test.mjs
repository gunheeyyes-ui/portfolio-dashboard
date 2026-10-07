import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./public/simulator.html", import.meta.url), "utf8");
const sim = readFileSync(new URL("./public/simulator.js", import.meta.url), "utf8");
const paper = readFileSync(new URL("./public/paper-auto.js", import.meta.url), "utf8");
const arena = readFileSync(new URL("./paper-auto-arena.js", import.meta.url), "utf8");

test("simulator clearly separates current signals, held positions, and closed history", () => {
  assert.match(html, /오늘 검토후보 \(현재 신호\)/);
  assert.match(html, /현재 보유 포지션/);
  assert.match(html, /오늘 신규 진입후보가 아닙니다/);
  assert.match(html, /다음 거래일 주문대기/);
  assert.match(html, /과거 청산 거래/);
  assert.match(html, /과거 종료된 V1 거래/);
  assert.doesNotMatch(html, /실제진입/);
});

test("V1 cards and tables label actionable signals separately from existing holdings", () => {
  assert.match(sim, /✅ 오늘 진입판정/);
  assert.match(sim, /오늘 ACTIONABLE 진입판정/);
  assert.match(sim, /과거 진입 후 보유 중/);
  assert.match(sim, /보유 중/);
  assert.match(sim, /진입 \$\{row\.entryDate \?\? "-"\}/);
  assert.doesNotMatch(sim, /실제진입/);
});

test("paper account rows distinguish held queued and closed states", () => {
  assert.match(arena, /✅ 진입판정 계좌/);
  assert.match(paper, /현재 보유 · 과거 진입/);
  assert.match(paper, /신규 주문대기/);
  assert.match(paper, /과거 청산 완료/);
  assert.doesNotMatch(paper, /실제진입/);
});
