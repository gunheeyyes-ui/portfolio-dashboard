import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

export const CLOUD_SNAPSHOT_SCHEMA = "portfolio-cloud-snapshot-1";

function iso(now = new Date()) {
  return now.toISOString();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function validateCloudSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("snapshot must be an object");
  if (snapshot.schemaVersion !== CLOUD_SNAPSHOT_SCHEMA) throw new Error("unsupported snapshot schema");
  if (!snapshot.generatedAt || !snapshot.marketScreener || !snapshot.portfolio) throw new Error("snapshot payload is incomplete");
  const kospi = snapshot.marketScreener?.rows?.KOSPI;
  const kosdaq = snapshot.marketScreener?.rows?.KOSDAQ;
  if (!Array.isArray(kospi) || !Array.isArray(kosdaq)) throw new Error("market rows are incomplete");
  if (!Array.isArray(snapshot.portfolio?.rows)) throw new Error("portfolio rows are incomplete");
  return snapshot;
}

export function createSnapshotStore({ snapshotFile, stateFile, fs = {} }) {
  const ops = {
    existsSync: fs.existsSync ?? existsSync,
    mkdirSync: fs.mkdirSync ?? mkdirSync,
    readFileSync: fs.readFileSync ?? readFileSync,
    renameSync: fs.renameSync ?? renameSync,
    unlinkSync: fs.unlinkSync ?? unlinkSync,
    writeFileSync: fs.writeFileSync ?? writeFileSync
  };

  function ensureParent(filePath) {
    ops.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  function readSnapshot() {
    if (!ops.existsSync(snapshotFile)) return null;
    return validateCloudSnapshot(JSON.parse(ops.readFileSync(snapshotFile, "utf8")));
  }

  function writeSnapshot(snapshot) {
    validateCloudSnapshot(snapshot);
    ensureParent(snapshotFile);
    const tempFile = `${snapshotFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      ops.writeFileSync(tempFile, JSON.stringify(snapshot), "utf8");
      validateCloudSnapshot(JSON.parse(ops.readFileSync(tempFile, "utf8")));
      ops.renameSync(tempFile, snapshotFile);
    } catch (error) {
      try {
        if (ops.existsSync(tempFile)) ops.unlinkSync(tempFile);
      } catch {
        // The previous last-known-good snapshot remains authoritative.
      }
      throw error;
    }
  }

  function readState() {
    if (!ops.existsSync(stateFile)) return null;
    try {
      return JSON.parse(ops.readFileSync(stateFile, "utf8"));
    } catch {
      return null;
    }
  }

  function writeState(state) {
    ensureParent(stateFile);
    const tempFile = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      ops.writeFileSync(tempFile, JSON.stringify(state), "utf8");
      JSON.parse(ops.readFileSync(tempFile, "utf8"));
      ops.renameSync(tempFile, stateFile);
    } catch (error) {
      try {
        if (ops.existsSync(tempFile)) ops.unlinkSync(tempFile);
      } catch {
        // State persistence must not take down snapshot serving.
      }
      throw error;
    }
  }

  return { readSnapshot, writeSnapshot, readState, writeState };
}

export function createCloudSnapshotManager({ store, performRefresh, logger = () => {}, now = () => new Date() }) {
  let snapshot = null;
  let refreshPromise = null;
  let state = {
    status: "idle",
    refreshId: null,
    kind: null,
    startedAt: null,
    completedAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    durationMs: null,
    error: null
  };

  function persistState() {
    try {
      store.writeState(state);
    } catch (error) {
      logger("REFRESH_STATE_WRITE_FAIL", { error: errorMessage(error) });
    }
  }

  function load() {
    const persistedState = store.readState();
    if (persistedState) {
      const interrupted = persistedState.status === "running";
      state = {
        ...state,
        ...persistedState,
        status: interrupted ? "error" : (persistedState.status === "error" ? "error" : "idle"),
        refreshId: null,
        error: interrupted ? "Previous refresh was interrupted; last-known-good snapshot retained" : persistedState.error
      };
    }
    try {
      snapshot = store.readSnapshot();
      if (snapshot) logger("SNAPSHOT_LOADED", { generatedAt: snapshot.generatedAt });
    } catch (error) {
      logger("SNAPSHOT_LOAD_FAIL", { error: errorMessage(error) });
      state = { ...state, status: "error", error: `Persisted snapshot ignored: ${errorMessage(error)}` };
      persistState();
    }
    return snapshot;
  }

  function getSnapshot() {
    if (snapshot) return snapshot;
    try {
      snapshot = store.readSnapshot();
    } catch (error) {
      state = { ...state, status: "error", error: `Persisted snapshot ignored: ${errorMessage(error)}` };
    }
    return snapshot;
  }

  function getState() {
    return { ...state, isRefreshing: Boolean(refreshPromise) };
  }

  function run(kind = "full", reason = "manual") {
    if (refreshPromise) {
      logger("REFRESH_SKIPPED_LOCK", { kind, reason, refreshId: state.refreshId });
      return { accepted: false, joined: true, refreshId: state.refreshId, promise: refreshPromise };
    }
    const started = now();
    const refreshId = `${started.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
    state = {
      ...state,
      status: "running",
      refreshId,
      kind,
      startedAt: iso(started),
      completedAt: null,
      lastAttemptAt: iso(started),
      durationMs: null,
      error: null
    };
    persistState();
    logger("REFRESH_START", { refreshId, kind, reason });

    refreshPromise = (async () => {
      try {
        const next = validateCloudSnapshot(await performRefresh({ kind, reason, previousSnapshot: snapshot, refreshId, startedAt: started }));
        store.writeSnapshot(next);
        snapshot = next;
        const completed = now();
        state = {
          ...state,
          status: "success",
          completedAt: iso(completed),
          lastSuccessAt: next.refresh?.lastSuccessAt ?? iso(completed),
          durationMs: completed.getTime() - started.getTime(),
          error: null
        };
        persistState();
        logger("SNAPSHOT_WRITTEN", { refreshId, generatedAt: next.generatedAt });
        logger("REFRESH_SUCCESS", {
          refreshId,
          kind,
          durationMs: state.durationMs,
          kospi: next.marketCounts?.KOSPI ?? 0,
          kosdaq: next.marketCounts?.KOSDAQ ?? 0
        });
        return next;
      } catch (error) {
        const completed = now();
        state = {
          ...state,
          status: "error",
          completedAt: iso(completed),
          durationMs: completed.getTime() - started.getTime(),
          error: errorMessage(error)
        };
        persistState();
        logger("REFRESH_FAIL", { refreshId, kind, durationMs: state.durationMs, error: state.error });
        throw error;
      } finally {
        refreshPromise = null;
      }
    })();
    refreshPromise.catch(() => {});
    return { accepted: true, joined: false, refreshId, promise: refreshPromise };
  }

  return { load, getSnapshot, getState, run };
}

export function kstParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    weekday: value("weekday"),
    hour: Number(value("hour")),
    minute: Number(value("minute"))
  };
}

export function scheduledRefreshKind({ date = new Date(), state = {}, intradayIntervalMinutes = 10, eodHour = 15, eodMinute = 50 }) {
  const kst = kstParts(date);
  if (["Sat", "Sun"].includes(kst.weekday)) return null;
  const minuteOfDay = kst.hour * 60 + kst.minute;
  const eodStart = eodHour * 60 + eodMinute;
  if (minuteOfDay >= eodStart && minuteOfDay <= 18 * 60) {
    if (state.lastEodTradingDate === kst.date || state.marketClosedDate === kst.date) return null;
    const lastAttempt = state.lastEodAttemptAt ? new Date(state.lastEodAttemptAt).getTime() : 0;
    if (date.getTime() - lastAttempt >= 20 * 60_000) return "full";
    return null;
  }
  if (minuteOfDay < 9 * 60 || minuteOfDay > 15 * 60 + 30) return null;
  const lastAttempt = state.lastIntradayAttemptAt ? new Date(state.lastIntradayAttemptAt).getTime() : 0;
  return date.getTime() - lastAttempt >= intradayIntervalMinutes * 60_000 ? "intraday" : null;
}
