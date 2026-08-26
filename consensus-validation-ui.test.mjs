import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./public/strategy-validation.html", import.meta.url), "utf8");
const js = readFileSync(new URL("./public/strategy-validation.js", import.meta.url), "utf8");
const simulatorHtml = readFileSync(new URL("./public/simulator.html", import.meta.url), "utf8");
const simulatorJs = readFileSync(new URL("./public/simulator-strategy-candidates.js", import.meta.url), "utf8");

test("strategy validation exposes a dedicated consensus-only scope", () => {
  assert.match(html, /data-scope="consensus"[^>]*>합의 조합</);
  assert.match(js, /state\.scope === "consensus"/);
  assert.match(js, /row\.group === "consensus"/);
  assert.match(js, /기본 \$\{baseCount\} · 합의 \$\{consensusCount\}/);
});

test("simulator exposes high-consensus filters while preserving the legacy actual-entry ledger", () => {
  assert.match(simulatorHtml, /data-strategy-filter="five-three"/);
  assert.match(simulatorHtml, /data-strategy-filter="four-actionable"/);
  assert.match(simulatorHtml, /data-strategy-filter="leader-rs-three"/);
  assert.match(simulatorJs, /state\.filter === "five-three"/);
  assert.match(simulatorJs, /state\.filter === "four-actionable"/);
  assert.match(simulatorHtml, /기존 simulation-ledger의 신규 포지션은 ✅ 실제진입 규칙만 기록합니다/);
  assert.match(simulatorHtml, /실제 가상매수는 기존 실제진입 규칙만 따릅니다/);
  assert.match(simulatorHtml, /Simulation V2/);
  assert.match(simulatorHtml, /기존 simulation-ledger V1 기록은 보존됩니다/);
});
