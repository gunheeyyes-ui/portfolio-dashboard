import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deploymentCiDecision } from "./deploy/cloud/github-ci-gate.mjs";

const SHA = "a".repeat(40);

function payload(run = {}) {
  return {
    workflow_runs: [{
      id: 1,
      name: "test",
      head_sha: SHA,
      status: "completed",
      conclusion: "success",
      run_attempt: 1,
      created_at: "2026-08-21T00:00:00Z",
      ...run
    }]
  };
}

test("OCI deploy gate only allows the exact successful main SHA", () => {
  assert.equal(deploymentCiDecision(payload(), { sha: SHA }).status, "SUCCESS");
  assert.equal(deploymentCiDecision(payload({ status: "in_progress", conclusion: null }), { sha: SHA }).status, "PENDING");
  assert.equal(deploymentCiDecision(payload({ conclusion: "failure" }), { sha: SHA }).status, "FAILED");
  assert.equal(deploymentCiDecision(payload({ head_sha: "b".repeat(40) }), { sha: SHA }).status, "MISSING");
  assert.equal(deploymentCiDecision({ workflow_runs: [] }, { sha: SHA }).status, "MISSING");
});

test("a newer rerun for the same SHA can recover a previous CI failure", () => {
  const data = {
    workflow_runs: [
      { id: 1, name: "test", head_sha: SHA, status: "completed", conclusion: "failure", run_attempt: 1, created_at: "2026-08-21T00:00:00Z" },
      { id: 2, name: "test", head_sha: SHA, status: "completed", conclusion: "success", run_attempt: 2, created_at: "2026-08-21T00:10:00Z" }
    ]
  };
  assert.equal(deploymentCiDecision(data, { sha: SHA }).status, "SUCCESS");
});

test("deployment source requires CI before backup/merge and keeps rollback checks", () => {
  const update = readFileSync(new URL("./deploy/cloud/update.sh", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const ci = update.indexOf("GitHub CI passed for $target");
  const backup = update.indexOf("Persistent-data backup:");
  const merge = update.indexOf('git merge --ff-only "origin/$BRANCH"');
  assert.ok(ci >= 0 && backup > ci && merge > backup);
  assert.match(update, /rollback\(\)/);
  assert.match(update, /npm test/);
  assert.match(update, /deployment deferred until CI is green/);
});

test("backup source has bounded age retention while preserving a newest-count floor", () => {
  const backup = readFileSync(new URL("./deploy/cloud/backup.sh", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(backup, /DASHBOARD_BACKUP_RETENTION_DAYS:-30/);
  assert.match(backup, /DASHBOARD_BACKUP_MIN_KEEP:-30/);
  assert.match(backup, /i=MIN_KEEP/);
  assert.match(backup, /-mtime "\+\$RETENTION_DAYS"/);
});
