import assert from "node:assert/strict";
import test from "node:test";

import { buildMarketStatusFromKisQuote } from "./market-integrity.js";

test("reference-price discontinuity is a hard pre-entry block", () => {
  const status = buildMarketStatusFromKisQuote({
    temp_stop_yn: "N",
    sltr_yn: "N",
    mang_issu_cls_code: "00",
    invt_caful_yn: "N",
    mrkt_warn_cls_code: "00",
    short_over_yn: "N",
    stck_sdpr: "1000",
    stck_prdy_clpr: "10000"
  }, { signalDate: "2026-09-11", market: "KOSDAQ", code: "046070", phase: "EOD_PREENTRY" });
  assert.equal(status.flags.referencePriceDiscontinuity, true);
  assert.equal(status.blockEntry, true);
  assert(status.blockReasons.includes("REFERENCE_PRICE_DISCONTINUITY"));
});
