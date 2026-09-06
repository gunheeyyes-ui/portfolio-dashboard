import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Importing the hook patches http.createServer. The fallback listener must still
// receive every non-extension route unchanged.
await import("./ai-review-http-hook.mjs");

test("HTTP hook delegates non-extension routes to the original dashboard listener", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`core:${req.url}`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(await response.text(), "core:/api/health");
  await new Promise((resolve) => server.close(resolve));
});

test("status route is fail-soft when OPENAI_API_KEY is absent", async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const server = http.createServer((req, res) => {
    res.writeHead(404); res.end("core");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/ai-review/status`);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.enabled, false);
  await new Promise((resolve) => server.close(resolve));
  if (previous) process.env.OPENAI_API_KEY = previous;
});

test("candidate freshness works from existing OOS files even without an OpenAI key", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousDir = process.env.DASHBOARD_DATA_DIR;
  delete process.env.OPENAI_API_KEY;
  const dir = mkdtempSync(path.join(os.tmpdir(), "candidate-freshness-http-"));
  process.env.DASHBOARD_DATA_DIR = dir;
  const selections = [
    { signalDate: "2026-09-04", market: "KOSPI", strategyId: "LEADER_TOP10", members: [{ code: "000001" }] },
    { signalDate: "2026-09-04", market: "KOSPI", strategyId: "CONSENSUS_5S_3A", members: [{ code: "000001" }] },
    { signalDate: "2026-09-04", market: "KOSPI", strategyId: "LEADER_A_AND_RS80", members: [] },
    { signalDate: "2026-09-04", market: "KOSPI", strategyId: "CONSENSUS_AXIS_3_PLUS", members: [] }
  ];
  writeFileSync(path.join(dir, "strategy-oos-selections.jsonl"), `${selections.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  writeFileSync(path.join(dir, "strategy-oos-history.jsonl"), `${JSON.stringify({ signalDate: "2026-09-04", market: "KOSPI", code: "000001", factors: { leaderRank: 8 } })}\n`, "utf8");

  const server = http.createServer((req, res) => {
    res.writeHead(404); res.end("core");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/candidate-freshness`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      signalDate: "2026-09-05",
      candidates: [{ code: "000001", market: "KOSPI", leaderRank: 5 }]
    })
  });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.rows[0].status, "MAINTAIN");
  assert.equal(data.rows[0].streakTradingDays, 2);
  assert.equal(data.rows[0].leaderRankDelta, -3);
  await new Promise((resolve) => server.close(resolve));

  if (previousKey) process.env.OPENAI_API_KEY = previousKey;
  else delete process.env.OPENAI_API_KEY;
  if (previousDir) process.env.DASHBOARD_DATA_DIR = previousDir;
  else delete process.env.DASHBOARD_DATA_DIR;
});
