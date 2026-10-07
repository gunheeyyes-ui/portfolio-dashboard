import test from "node:test";
import assert from "node:assert/strict";
import { fetchNpayMarketCapCandidates, npayMarketCapUrl } from "./market-cap-source.js";

test("Npay market-cap URL uses the live stock API contract", () => {
  const url = new URL(npayMarketCapUrl("KOSDAQ", 1, 100));
  assert.equal(url.origin, "https://stock.naver.com");
  assert.equal(url.pathname, "/api/domestic/market/stock/default");
  assert.equal(url.searchParams.get("tradeType"), "KRX");
  assert.equal(url.searchParams.get("marketType"), "KOSDAQ");
  assert.equal(url.searchParams.get("orderType"), "marketSum");
  assert.equal(url.searchParams.get("startIdx"), "1");
  assert.equal(url.searchParams.get("pageSize"), "100");
});

test("Npay market-cap source parses, excludes, deduplicates and paginates", async () => {
  const calls = [];
  const pages = [
    [
      { itemcode: "005930", itemname: "삼성전자" },
      { itemcode: "005935", itemname: "삼성전자우" },
      { itemcode: "000660", itemname: "SK하이닉스" }
    ],
    [
      { itemcode: "000660", itemname: "SK하이닉스" },
      { itemcode: "035420", itemname: "NAVER" }
    ]
  ];
  const fetchImpl = async (url) => {
    calls.push(new URL(url));
    const page = Number(new URL(url).searchParams.get("startIdx"));
    return {
      ok: true,
      async json() { return pages[page] ?? []; }
    };
  };

  const result = await fetchNpayMarketCapCandidates("KOSPI", 3, {
    fetchImpl,
    isExcluded: (name) => name.endsWith("우")
  });

  assert.deepEqual(result.map((row) => row.code), ["005930", "000660", "035420"]);
  assert.deepEqual(result.map((row) => row.rank), [1, 2, 3]);
  assert.ok(result.every((row) => row.rankType === "시총"));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].searchParams.get("startIdx"), "1");
});

test("Npay source fails closed on a non-array response", async () => {
  await assert.rejects(
    fetchNpayMarketCapCandidates("KOSPI", 10, {
      fetchImpl: async () => ({ ok: true, async json() { return { items: [] }; } })
    }),
    /not an array/
  );
});
