import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
const tracker = readFileSync(new URL("./strategy-oos-tracker.js", import.meta.url), "utf8");
const frontend = readFileSync(new URL("./public/simulator-v2.js", import.meta.url), "utf8");

test("Simulation V2 has a server-side full-history endpoint instead of the old 120-cohort browser join", () => {
  assert.match(server, /url\.pathname === "\/api\/simulation-v2"/);
  assert.match(server, /strategyOosTracker\.readAll\(\)/);
  assert.match(server, /buildSimulationV2ServerModel/);
  assert.doesNotMatch(frontend, /strategy-validation\/detail/);
  assert.doesNotMatch(frontend, /limit:\s*"120"/);
  assert.match(frontend, /\/api\/simulation-v2/);
});

test("OOS records freeze consensus and add entry-day execution diagnostics", () => {
  assert.match(tracker, /frozenConsensus:\s*freezeBaseConsensus\(factors\)/);
  assert.match(tracker, /entryDayOutcome/);
  assert.match(tracker, /entryGapPct/);
  assert.match(tracker, /universeMeta/);
});

test("real market index history is maintained automatically and screener expansion is explicit/configurable", () => {
  assert.match(server, /inquire-daily-indexchartprice/);
  assert.match(server, /FHKUP03500100/);
  assert.match(server, /scheduleMarketIndexMaintenance\(\{ force: true \}\)/);
  assert.match(server, /CLOUD_SCREENER_LIMIT \|\| 100/);
});
