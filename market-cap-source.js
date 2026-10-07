const NPAY_STOCK_API = "https://stock.naver.com/api/domestic/market/stock/default";

export function npayMarketCapUrl(market, page = 0, pageSize = 100) {
  const normalizedMarket = market === "KOSDAQ" ? "KOSDAQ" : "KOSPI";
  const params = new URLSearchParams({
    tradeType: "KRX",
    marketType: normalizedMarket,
    orderType: "marketSum",
    startIdx: String(Math.max(0, Number(page) || 0)),
    pageSize: String(Math.min(100, Math.max(1, Number(pageSize) || 100)))
  });
  return `${NPAY_STOCK_API}?${params.toString()}`;
}

export async function fetchNpayMarketCapCandidates(market, count, {
  fetchImpl = fetch,
  userAgent = "Mozilla/5.0 PortfolioSignalDashboard/0.2",
  isExcluded = () => false
} = {}) {
  const target = Math.max(1, Number(count) || 1);
  const pageSize = Math.min(100, target);
  const candidates = [];
  const seen = new Set();

  for (let page = 0; page < 8 && candidates.length < target; page += 1) {
    const response = await fetchImpl(npayMarketCapUrl(market, page, pageSize), {
      headers: {
        "user-agent": userAgent,
        referer: "https://stock.naver.com/"
      }
    });
    if (!response.ok) throw new Error(`Npay market-cap request failed: ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("Npay market-cap response is not an array");

    let accepted = 0;
    for (const row of rows) {
      const code = String(row?.itemcode ?? "").trim().padStart(6, "0");
      const name = String(row?.itemname ?? code).trim();
      if (!/^\d{6}$/.test(code) || seen.has(code) || isExcluded(name)) continue;
      seen.add(code);
      accepted += 1;
      candidates.push({
        market: market === "KOSDAQ" ? "KOSDAQ" : "KOSPI",
        code,
        name,
        rank: candidates.length + 1,
        rankType: "시총"
      });
      if (candidates.length >= target) break;
    }

    if (rows.length < pageSize) break;
    if (!accepted && rows.every((row) => seen.has(String(row?.itemcode ?? "").trim().padStart(6, "0")))) break;
  }

  return candidates;
}
