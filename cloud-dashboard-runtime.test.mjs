import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLOUD_SNAPSHOT_SCHEMA,
  createCloudSnapshotManager,
  createSnapshotStore,
  scheduledRefreshKind
} from "./cloud-dashboard-runtime.js";

function fixture(generatedAt = "2026-08-13T07:00:00.000Z") {
  return {
    schemaVersion: CLOUD_SNAPSHOT_SCHEMA,
    generatedAt,
    marketDataAsOf: "2026-08-13",
    dataMode: "EOD_FULL",
    marketCounts: { KOSPI: 1, KOSDAQ: 1 },
    marketScreener: { rows: { KOSPI: [{ code: "005930" }], KOSDAQ: [{ code: "035720" }] } },
    portfolio: { rows: [{ code: "005930" }] },
    refresh: { status: "SUCCESS", lastSuccessAt: generatedAt }
  };
}

function tempStore(options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "portfolio-cloud-"));
  const snapshotFile = path.join(dir, "latest-snapshot.json");
  const stateFile = path.join(dir, "refresh-state.json");
  return {
    dir,
    snapshotFile,
    stateFile,
    store: createSnapshotStore({ snapshotFile, stateFile, ...options })
  };
}

test("snapshot persists and loads as last-known-good", () => {
  const item = tempStore();
  try {
    item.store.writeSnapshot(fixture());
    assert.deepEqual(item.store.readSnapshot(), fixture());
  } finally {
    rmSync(item.dir, { recursive: true, force: true });
  }
});

test("malformed persisted snapshot is ignored by manager", () => {
  const item = tempStore();
  try {
    writeFileSync(item.snapshotFile, "{broken", "utf8");
    const manager = createCloudSnapshotManager({
      store: item.store,
      performRefresh: async () => fixture()
    });
    assert.equal(manager.load(), null);
    assert.equal(manager.getState().status, "error");
  } finally {
    rmSync(item.dir, { recursive: true, force: true });
  }
});

test("failed atomic write preserves previous snapshot", () => {
  const item = tempStore();
  try {
    item.store.writeSnapshot(fixture());
    const failingStore = createSnapshotStore({
      snapshotFile: item.snapshotFile,
      stateFile: item.stateFile,
      fs: {
        writeFileSync(filePath, content, encoding) {
          if (String(filePath).includes("latest-snapshot.json.")) throw new Error("disk full");
          writeFileSync(filePath, content, encoding);
        }
      }
    });
    assert.throws(() => failingStore.writeSnapshot(fixture("2026-08-13T08:00:00.000Z")), /disk full/);
    assert.equal(JSON.parse(readFileSync(item.snapshotFile, "utf8")).generatedAt, fixture().generatedAt);
  } finally {
    rmSync(item.dir, { recursive: true, force: true });
  }
});

test("single-flight joins concurrent refresh requests", async () => {
  const item = tempStore();
  let executions = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  try {
    const manager = createCloudSnapshotManager({
      store: item.store,
      performRefresh: async () => {
        executions += 1;
        await gate;
        return fixture();
      }
    });
    const first = manager.run("full", "test");
    const second = manager.run("full", "test");
    assert.equal(first.accepted, true);
    assert.equal(second.accepted, false);
    assert.equal(second.joined, true);
    assert.equal(first.promise, second.promise);
    release();
    await first.promise;
    assert.equal(executions, 1);
  } finally {
    rmSync(item.dir, { recursive: true, force: true });
  }
});

test("refresh failure keeps memory and disk snapshot", async () => {
  const item = tempStore();
  try {
    item.store.writeSnapshot(fixture());
    const manager = createCloudSnapshotManager({
      store: item.store,
      performRefresh: async () => { throw new Error("KIS unavailable"); }
    });
    manager.load();
    await assert.rejects(manager.run("full", "test").promise, /KIS unavailable/);
    assert.equal(manager.getSnapshot().generatedAt, fixture().generatedAt);
    assert.equal(item.store.readSnapshot().generatedAt, fixture().generatedAt);
    assert.equal(manager.getState().status, "error");
  } finally {
    rmSync(item.dir, { recursive: true, force: true });
  }
});

test("scheduler uses Seoul weekdays and separates intraday from EOD", () => {
  assert.equal(scheduledRefreshKind({ date: new Date("2026-08-13T01:00:00Z") }), "intraday");
  assert.equal(scheduledRefreshKind({ date: new Date("2026-08-13T06:51:00Z") }), "full");
  assert.equal(scheduledRefreshKind({ date: new Date("2026-08-15T01:00:00Z") }), null);
});
