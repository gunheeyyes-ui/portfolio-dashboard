import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const bootstrap = readFileSync(new URL("./public/index-entry-review.js", import.meta.url), "utf8");
const inline = readFileSync(new URL("./public/home-ai-review-inline.js", import.meta.url), "utf8");
const css = readFileSync(new URL("./public/home-ai-review-inline.css", import.meta.url), "utf8");
const core = readFileSync(new URL("./public/index-entry-review-core.js", import.meta.url), "utf8");

test("home AI review is mirrored into the existing candidate cell instead of a visible extra column", () => {
  assert.match(bootstrap, /import "\.\/home-ai-review-inline\.js"/);
  assert.match(inline, /row\.children\[0\]/);
  assert.match(inline, /AI \$\{button\.textContent/);
  assert.match(css, /th\.ai-review-head[\s\S]*display:\s*none\s*!important/);
  assert.match(css, /td\.ai-review-cell[\s\S]*display:\s*none\s*!important/);
});

test("repeated core badge is hidden while strong remains an explicit row exception", () => {
  assert.match(inline, /textContent\?\.includes\("핵심"\)/);
  assert.match(inline, /classList\.toggle\("home-entry-core-compact", isCore\)/);
  assert.match(css, /home-entry-core-compact\s*>\s*\.home-entry-badge[\s\S]*display:\s*none\s*!important/);
  assert.doesNotMatch(inline, /includes\("강한"\)/);
  assert.match(css, /th:nth-child\(1\) \{ width: 20%; \}/);
  assert.match(css, /th:nth-child\(2\) \{ width: 25%; \}/);
});

test("inline AI presentation does not move candidate selection into the wrapper", () => {
  assert.doesNotMatch(inline, /buildStrategyCandidates|buildEntryReviewCandidates|coreCandidate\s*=|strongCandidate\s*=/);
  assert.match(core, /buildStrategyCandidates/);
  assert.match(core, /buildEntryReviewCandidates/);
});
