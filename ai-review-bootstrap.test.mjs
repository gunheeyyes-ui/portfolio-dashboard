import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const serverBootstrap = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
const serverCore = readFileSync(new URL("./server-core.mjs", import.meta.url), "utf8");
const homeBootstrap = readFileSync(new URL("./public/index-entry-review.js", import.meta.url), "utf8");
const homeCore = readFileSync(new URL("./public/index-entry-review-core.js", import.meta.url), "utf8");

test("server bootstrap preloads only the extension hook before the preserved dashboard core", () => {
  assert.match(serverBootstrap, /import "\.\/ai-review-http-hook\.mjs"/);
  assert.match(serverBootstrap, /await import\("\.\/server-core\.mjs"\)/);
  assert.match(serverCore, /url\.pathname === "\/api\/simulation-v2"/);
  assert.match(serverCore, /const actionableToday = collected\.candidates/);
  assert.doesNotMatch(serverBootstrap, /rankMarketRowsV2\(/);
});

test("home bootstrap observes freshness and AI review without moving candidate-selection logic out of preserved core", () => {
  assert.match(homeBootstrap, /import "\.\/home-candidate-freshness\.js"/);
  assert.match(homeBootstrap, /import "\.\/home-ai-review\.js"/);
  assert.match(homeBootstrap, /await import\("\.\/index-entry-review-core\.js"\)/);
  assert.match(homeCore, /buildStrategyCandidates/);
  assert.match(homeCore, /buildEntryReviewCandidates/);
  assert.match(homeCore, /filter\(\(row\) => row\.coreCandidate \|\| row\.strongCandidate\)/);
  assert.doesNotMatch(homeBootstrap, /buildStrategyCandidates/);
});
