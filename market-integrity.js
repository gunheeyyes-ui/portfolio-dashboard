function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function text(value) {
  return String(value ?? "").trim().toUpperCase();
}

function yes(value) {
  return ["Y", "YES", "1", "TRUE"].includes(text(value));
}

function nonNormalCode(value) {
  const v = text(value);
  return Boolean(v) && !["0", "00", "000", "N", "NO", "FALSE"].includes(v);
}

export function marketStatusKey(signalDate, market, code) {
  return `${signalDate}|${market}|${code}`;
}

export function buildMarketStatusFromKisQuote(output = {}, meta = {}) {
  const referencePrice = finite(output.stck_sdpr) ? Number(output.stck_sdpr) : null;
  const prevClose = finite(output.stck_prdy_clpr) ? Number(output.stck_prdy_clpr) : null;
  const referenceGapPct = referencePrice > 0 && prevClose > 0
    ? (referencePrice / prevClose - 1) * 100
    : null;

  const flags = {
    temporaryHalt: yes(output.temp_stop_yn),
    liquidationTrading: yes(output.sltr_yn),
    managedIssue: nonNormalCode(output.mang_issu_cls_code),
    investmentCaution: yes(output.invt_caful_yn),
    marketWarning: nonNormalCode(output.mrkt_warn_cls_code),
    shortTermOverheat: yes(output.short_over_yn),
    referencePriceDiscontinuity: finite(referenceGapPct) && Math.abs(referenceGapPct) >= 45
  };
  const blockReasons = [];
  if (flags.temporaryHalt) blockReasons.push("TEMPORARY_HALT");
  if (flags.liquidationTrading) blockReasons.push("LIQUIDATION_TRADING");
  if (flags.managedIssue) blockReasons.push("MANAGED_ISSUE");
  if (flags.investmentCaution) blockReasons.push("INVESTMENT_CAUTION");
  if (flags.referencePriceDiscontinuity) blockReasons.push("REFERENCE_PRICE_DISCONTINUITY");

  return {
    schemaVersion: "market-integrity-status-v1",
    signalDate: meta.signalDate ?? null,
    checkedAt: meta.checkedAt ?? new Date().toISOString(),
    phase: meta.phase ?? "UNKNOWN",
    market: meta.market ?? null,
    code: meta.code ?? null,
    name: meta.name ?? null,
    flags,
    blockEntry: blockReasons.length > 0,
    blockReasons,
    riskFlags: [
      ...(flags.marketWarning ? ["MARKET_WARNING"] : []),
      ...(flags.shortTermOverheat ? ["SHORT_TERM_OVERHEAT"] : [])
    ],
    raw: {
      temp_stop_yn: text(output.temp_stop_yn),
      sltr_yn: text(output.sltr_yn),
      mang_issu_cls_code: text(output.mang_issu_cls_code),
      invt_caful_yn: text(output.invt_caful_yn),
      mrkt_warn_cls_code: text(output.mrkt_warn_cls_code),
      short_over_yn: text(output.short_over_yn),
      new_mkop_cls_code: text(output.new_mkop_cls_code),
      stck_sdpr: referencePrice,
      stck_prdy_clpr: prevClose,
      referenceGapPct: finite(referenceGapPct) ? Number(referenceGapPct.toFixed(3)) : null
    }
  };
}

export function buildMarketStatusMap(rows = []) {
  const map = new Map();
  for (const row of rows) {
    if (!row?.signalDate || !row?.market || !row?.code) continue;
    const key = marketStatusKey(row.signalDate, row.market, row.code);
    const prior = map.get(key);
    if (!prior || String(row.checkedAt ?? "") > String(prior.checkedAt ?? "")) map.set(key, row);
  }
  return map;
}

function outcomeFor(record, horizon) {
  return Number(horizon) === 0 ? record?.entryDayOutcome ?? null : record?.outcomes?.[String(horizon)] ?? null;
}

export function classifyOutcomeIntegrity(record, horizon, statusMap = null) {
  const reasons = [];
  const status = statusMap?.get?.(marketStatusKey(record?.signalDate, record?.market, record?.code)) ?? null;
  if (status?.blockEntry) reasons.push(...(status.blockReasons ?? ["MARKET_STATUS_BLOCK"]));

  const signalPrice = finite(record?.signalPrice) ? Number(record.signalPrice) : null;
  const entryOpen = finite(record?.entryOpen) ? Number(record.entryOpen) : null;
  if (signalPrice > 0 && entryOpen > 0) {
    const gapPct = (entryOpen / signalPrice - 1) * 100;
    if (Math.abs(gapPct) >= 45) reasons.push("ENTRY_REFERENCE_DISCONTINUITY");
  }

  const outcome = outcomeFor(record, horizon);
  if (outcome && entryOpen > 0 && finite(outcome.exitPrice) && Number(outcome.exitPrice) > 0) {
    const ratio = Number(outcome.exitPrice) / entryOpen;
    if (ratio <= 0.10 || ratio >= 10) reasons.push("HARD_PRICE_DISCONTINUITY");
  }
  const gross = finite(outcome?.grossReturnPct) ? Number(outcome.grossReturnPct) : null;
  if (gross !== null && Number(horizon) <= 3 && (gross <= -80 || gross >= 200)) {
    reasons.push("HARD_SHORT_HORIZON_DISCONTINUITY");
  }

  const uniqueReasons = [...new Set(reasons)];
  return {
    comparable: uniqueReasons.length === 0,
    reasons: uniqueReasons,
    status
  };
}

export function isEntryBlocked(record, statusMap = null) {
  const status = statusMap?.get?.(marketStatusKey(record?.signalDate, record?.market, record?.code)) ?? null;
  return status?.blockEntry === true ? status : null;
}
