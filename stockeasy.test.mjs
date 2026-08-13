import test from "node:test";
import assert from "node:assert/strict";
import { extractHoldingCodes, createStockEasyCache } from "./stockeasy.js";

test("extractHoldingCodes reads exact 6-digit codes from sector-grouped holdings", () => {
  const payload = {
    success: true,
    holdings: {
      "제약": [
        { stock_code: "008930", stock_name: "한미사이언스" },
        { stock_code: "000100", stock_name: "유한양행" }
      ],
      "CDMO": [{ stock_code: "207940", stock_name: "삼성바이오로직스" }]
    }
  };
  const codes = extractHoldingCodes(payload);
  assert.equal(codes.size, 3);
  assert.ok(codes.has("008930"));
  assert.ok(codes.has("207940"));
});

test("extractHoldingCodes never throws on malformed input", () => {
  assert.equal(extractHoldingCodes(null).size, 0);
  assert.equal(extractHoldingCodes({}).size, 0);
  assert.equal(extractHoldingCodes({ holdings: null }).size, 0);
  assert.equal(extractHoldingCodes({ holdings: "not an object" }).size, 0);
  assert.equal(extractHoldingCodes({ holdings: { a: "not an array" } }).size, 0);
  assert.equal(extractHoldingCodes({ holdings: { a: [{ stock_code: 5930 }, { stock_code: "abc" }, {}] } }).size, 0);
});

function fakeFetch(responses) {
  return async (url) => {
    const id = Number(url.match(/portfolio\/(\d+)\/holdings/)[1]);
    const entry = responses[id];
    if (entry?.error) throw new Error(entry.error);
    return {
      ok: entry?.httpStatus ? entry.httpStatus < 400 : true,
      status: entry?.httpStatus ?? 200,
      json: async () => entry.body
    };
  };
}

test("cache badgesFor reflects fetched portfolios after refresh (exact code match)", async () => {
  const fetchImpl = fakeFetch({
    1: { body: { success: true, holdings: { a: [{ stock_code: "005930" }] } } },
    2: { body: { success: true, holdings: { a: [{ stock_code: "000660" }] } } },
    3: { body: { success: true, holdings: { a: [{ stock_code: "005930" }] } } }
  });
  const cache = createStockEasyCache({ fetchImpl });
  await cache.refresh();
  assert.deepEqual(cache.badgesFor("005930"), { seMomentum: true, sePeak: false, seValue: true });
  assert.deepEqual(cache.badgesFor("000660"), { seMomentum: false, sePeak: true, seValue: false });
  assert.deepEqual(cache.badgesFor("999999"), { seMomentum: false, sePeak: false, seValue: false });
});

test("a stock not present in a portfolio never gets that badge (no false positives)", async () => {
  const fetchImpl = fakeFetch({
    1: { body: { success: true, holdings: { a: [{ stock_code: "005930" }] } } },
    2: { body: { success: true, holdings: {} } },
    3: { body: { success: true, holdings: {} } }
  });
  const cache = createStockEasyCache({ fetchImpl });
  await cache.refresh();
  assert.equal(cache.badgesFor("005930").sePeak, false);
  assert.equal(cache.badgesFor("005930").seValue, false);
});

test("fail-soft: one source erroring keeps the other two working and does not throw", async () => {
  const fetchImpl = fakeFetch({
    1: { body: { success: true, holdings: { a: [{ stock_code: "005930" }] } } },
    2: { error: "network down" },
    3: { httpStatus: 500, body: {} }
  });
  const cache = createStockEasyCache({ fetchImpl });
  await assert.doesNotReject(cache.refresh());
  assert.deepEqual(cache.badgesFor("005930"), { seMomentum: true, sePeak: false, seValue: false });
  const diag = cache.diagnostics();
  assert.equal(diag.momentum.ok, true);
  assert.equal(diag.peak.ok, false);
  assert.equal(diag.value.ok, false);
});

test("a later failed refresh keeps the previous successful codes instead of clearing them", async () => {
  let call = 0;
  const fetchImpl = async (url) => {
    call += 1;
    const id = Number(url.match(/portfolio\/(\d+)\/holdings/)[1]);
    if (call <= 3) {
      return { ok: true, json: async () => ({ success: true, holdings: { a: [{ stock_code: "005930" }] } }) };
    }
    if (id === 1) throw new Error("timeout");
    return { ok: true, json: async () => ({ success: true, holdings: { a: [{ stock_code: "005930" }] } }) };
  };
  const cache = createStockEasyCache({ fetchImpl });
  await cache.refresh();
  assert.equal(cache.badgesFor("005930").seMomentum, true);
  await cache.refresh();
  assert.equal(cache.badgesFor("005930").seMomentum, true, "stale-but-last-known-good codes must survive a failed refresh");
  assert.equal(cache.diagnostics().momentum.ok, false);
});

test("diagnostics reports cache age and stale flag based on ttlMs", async () => {
  const fetchImpl = fakeFetch({
    1: { body: { success: true, holdings: {} } },
    2: { body: { success: true, holdings: {} } },
    3: { body: { success: true, holdings: {} } }
  });
  const cache = createStockEasyCache({ fetchImpl, ttlMs: 1 });
  assert.equal(cache.diagnostics().stale, true);
  await cache.refresh();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cache.diagnostics().stale, true);
  assert.ok(cache.diagnostics().cacheAgeSeconds >= 0);
});

test("ensureFresh does not block the caller (fire-and-forget) and does not throw", () => {
  const fetchImpl = fakeFetch({
    1: { error: "slow/broken" },
    2: { error: "slow/broken" },
    3: { error: "slow/broken" }
  });
  const cache = createStockEasyCache({ fetchImpl, ttlMs: 1 });
  assert.doesNotThrow(() => cache.ensureFresh());
});
