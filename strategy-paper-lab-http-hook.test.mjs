import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

import "./strategy-paper-lab-http-hook.mjs";

test("strategy paper lab HTTP route enforces auth and returns 107x4 forward accounts", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "strategy-paper-lab-"));
  const oldData = process.env.DASHBOARD_DATA_DIR;
  const oldPassword = process.env.DASHBOARD_PASSWORD;
  const oldUsername = process.env.DASHBOARD_USERNAME;
  let server;
  try {
    const summary = { meta: { lastDate: "2026-10-08", missingSnapshotDates: [] }, markets: { ALL: [] } };
    writeFileSync(path.join(dir, "strategy-oos-summary.json"), JSON.stringify(summary));
    for (const name of ["strategy-oos-history.jsonl", "strategy-oos-selections.jsonl", "market-status-history.jsonl"]) {
      writeFileSync(path.join(dir, name), "");
    }
    process.env.DASHBOARD_DATA_DIR = dir;
    process.env.DASHBOARD_USERNAME = "lab-user";
    process.env.DASHBOARD_PASSWORD = "only-test";
    server = http.createServer((_req, res) => { res.writeHead(204); res.end(); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const forbidden = await fetch(base + "/api/strategy-paper-lab");
    assert.equal(forbidden.status, 401);
    const auth = { Authorization: "Basic " + Buffer.from("lab-user:only-test").toString("base64") };
    const method = await fetch(base + "/api/strategy-paper-lab", { method: "POST", headers: auth });
    assert.equal(method.status, 405);
    const ok = await fetch(base + "/api/strategy-paper-lab", { headers: auth });
    assert.equal(ok.status, 200);
    const result = await ok.json();
    assert.equal(result.diagnostics.strategyCount, 107);
    assert.equal(result.diagnostics.independentAccountCount, 428);
    assert.equal(result.diagnostics.noBackfillBefore, "2026-10-12");
    assert.equal(result.diagnostics.realOrderApiUsed, undefined);
    assert.equal(result.policy.realOrderApiUsed, false);
    assert.equal(result.leaderboard.length, 107);
    assert.ok(result.leaderboard.every((a) => Object.keys(a.holds).length === 4));
    assert.ok(result.leaderboard.every((a) => a.holds["10"].closedTrades === 0));
    const unaffected = await fetch(base + "/not-our-endpoint");
    assert.equal(unaffected.status, 204);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (oldData === undefined) delete process.env.DASHBOARD_DATA_DIR;
    else process.env.DASHBOARD_DATA_DIR = oldData;
    if (oldPassword === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = oldPassword;
    if (oldUsername === undefined) delete process.env.DASHBOARD_USERNAME;
    else process.env.DASHBOARD_USERNAME = oldUsername;
    rmSync(dir, { force: true, recursive: true });
  }
});
