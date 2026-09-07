import assert from "node:assert/strict";
import test from "node:test";

import { buildPaperAutoModel, PAPER_AUTO_POLICY } from "./paper-auto-service.js";

function selection(signalDate, members, market = "KOSPI") {
  return { signalDate, market, strategyId: "ACTIONABLE_ALL", members: members.map((code) => ({ code })) };
}

function record({ signalDate, code, entryDate = null, entryOpen = null, strategyCount = 6, axisCount = 3, outcome3 = null, live = null }) {
  return {
    signalDate,
    market: "KOSPI",
    code,
    name: `종목${code}`,
    signalPrice: 10_000,
    entryDate,
    entryOpen,
    factors: { leaderRank: 5, rs20: 80 },
    frozenConsensus: { strategyCount, axisCount },
    outcomes: outcome3 ? { "3": outcome3 } : {},
    live
  };
}

test("Shadow Auto V1 starts forward-only, fills next-open records, and charges conservative slippage", () => {
  const records = [
    record({ signalDate: "2026-09-04", code: "000001", entryDate: "20260907", entryOpen: 10_000, outcome3: { targetTradingDate: "20260910", exitPrice: 11_000, netReturnPct: 9.77 } }),
    record({ signalDate: "2026-09-07", code: "000002", entryDate: "20260908", entryOpen: 10_000, outcome3: { targetTradingDate: "20260911", exitPrice: 11_000, netReturnPct: 9.77 } }),
    record({ signalDate: "2026-09-08", code: "000003", entryDate: "20260909", entryOpen: 20_000, live: { currentPrice: 21_000, currentReturnPct: 4.77, tradingDaysElapsed: 1 } }),
    record({ signalDate: "2026-09-11", code: "000004" })
  ];
  const selections = [
    selection("2026-09-04", ["000001"]),
    selection("2026-09-07", ["000002"]),
    selection("2026-09-08", ["000003"]),
    selection("2026-09-11", ["000004"])
  ];

  const model = buildPaperAutoModel({ records, selections });
  assert.equal(model.policy.id, PAPER_AUTO_POLICY.id);
  assert.equal(model.summary.signalCount, 3);
  assert.equal(model.summary.closedTrades, 1);
  assert.equal(model.summary.openPositions, 1);
  assert.equal(model.summary.queuedOrders, 1);
  assert.equal(model.closed[0].quantity, 1000);
  assert.equal(model.closed[0].paperReturnPct, 9.57);
  assert.equal(model.closed[0].pnl, 957000);
  assert.equal(model.open[0].quantity, 500);
  assert.equal(model.open[0].paperReturnPct, 4.57);
  assert.equal(model.summary.realizedPnl, 957000);
  assert.equal(model.summary.unrealizedPnl, 457000);
  assert.equal(model.summary.equity, 101414000);
  assert.equal(model.summary.totalReturnPct, 1.414);
  assert.equal(model.diagnostics.realOrderApiUsed, false);
  assert.equal(model.diagnostics.aiAffectsOrders, false);
});

test("entries use frozen priority and same-day close does not free an open slot before the open", () => {
  const policy = { ...PAPER_AUTO_POLICY, initialCapital: 20_000_000, maxPositions: 1, positionBudget: 10_000_000 };
  const records = [
    record({ signalDate: "2026-09-07", code: "100001", entryDate: "20260908", entryOpen: 10_000, strategyCount: 9, outcome3: { targetTradingDate: "20260911", exitPrice: 10_500, netReturnPct: 4.77 } }),
    record({ signalDate: "2026-09-07", code: "100002", entryDate: "20260908", entryOpen: 10_000, strategyCount: 5 }),
    record({ signalDate: "2026-09-10", code: "100003", entryDate: "20260911", entryOpen: 10_000, strategyCount: 12 })
  ];
  const selections = [
    selection("2026-09-07", ["100001", "100002"]),
    selection("2026-09-10", ["100003"])
  ];

  const model = buildPaperAutoModel({ records, selections, policy });
  assert.equal(model.closed.length, 1);
  assert.equal(model.closed[0].code, "100001");
  assert.equal(model.skipped.filter((row) => row.reason === "MAX_POSITIONS").length, 2);
  assert.equal(model.open.length, 0);
});

test("paper auto is isolated from real-order and ranking formula code", async () => {
  const { readFile } = await import("node:fs/promises");
  const [service, hook, server, core] = await Promise.all([
    readFile(new URL("./paper-auto-service.js", import.meta.url), "utf8"),
    readFile(new URL("./paper-auto-http-hook.mjs", import.meta.url), "utf8"),
    readFile(new URL("./server.mjs", import.meta.url), "utf8"),
    readFile(new URL("./server-core.mjs", import.meta.url), "utf8")
  ]);
  assert.match(server, /paper-auto-http-hook\.mjs/);
  assert.doesNotMatch(`${service}\n${hook}`, /TTTC0802U|order-cash|KIS_APP_KEY|rankMarketRowsV2\(/);
  assert.match(core, /url\.pathname === "\/api\/simulation-v2"/);
});
