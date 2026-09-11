const fmt = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function pct(value) {
  if (!finite(value)) return "—";
  const n = Number(value);
  return `${n > 0 ? "+" : ""}${fmt.format(n)}%`;
}

function tone(value) {
  return finite(value) && Number(value) < 0 ? "negative" : "positive";
}

function reasonText(reason) {
  const labels = {
    TEMPORARY_HALT: "거래정지",
    LIQUIDATION_TRADING: "정리매매",
    MANAGED_ISSUE: "관리종목",
    INVESTMENT_CAUTION: "투자유의",
    REFERENCE_PRICE_DISCONTINUITY: "기준가 단절",
    ENTRY_REFERENCE_DISCONTINUITY: "진입가 단절",
    HARD_PRICE_DISCONTINUITY: "가격단절 의심",
    HARD_SHORT_HORIZON_DISCONTINUITY: "단기 가격단절 의심"
  };
  return labels[reason] ?? reason;
}

function ensurePanel() {
  if (document.querySelector("#marketIntegrityPanel")) return document.querySelector("#marketIntegrityPanel");
  const anchor = document.querySelector("#simV2Metrics");
  if (!anchor) return null;
  anchor.insertAdjacentHTML("afterend", `
    <section class="sim-panel" id="marketIntegrityPanel">
      <div class="section-title">
        <div>
          <h2>데이터 정합성 · 특수종목 격리</h2>
          <p id="marketIntegrityStatus">정리매매·관리종목·거래정지·가격단절을 점검 중입니다.</p>
        </div>
      </div>
      <div class="metrics" id="marketIntegrityMetrics"></div>
      <div class="table-wrap" style="margin-top:12px">
        <table class="sim-table">
          <thead><tr><th>후보군</th><th>3D 원본 → 정합성</th><th>5D 원본 → 정합성</th><th>5D 정합성 포트</th><th>격리</th></tr></thead>
          <tbody id="marketIntegrityCohorts"><tr><td colspan="5" class="loading">불러오는 중...</td></tr></tbody>
        </table>
      </div>
      <div class="table-wrap" style="margin-top:12px">
        <table class="sim-table">
          <thead><tr><th>신호일</th><th>종목</th><th>구간</th><th>원본수익</th><th>격리사유</th></tr></thead>
          <tbody id="marketIntegrityRecent"><tr><td colspan="5" class="loading">불러오는 중...</td></tr></tbody>
        </table>
      </div>
    </section>`);
  return document.querySelector("#marketIntegrityPanel");
}

function renderIntegrity(integrity, paper) {
  ensurePanel();
  const baselineAccounts = paper?.accounts ?? [];
  const blocked = baselineAccounts.flatMap((account) => (account.blocked ?? []).map((row) => ({ ...row, account: account.label })));
  const uniqueBlocked = new Set(blocked.map((row) => `${row.signalDate}|${row.market}|${row.code}`));
  const metrics = [
    ["시장상태 스냅샷", `${integrity.marketStatusSnapshots ?? 0}건`],
    ["정합성 격리", `${integrity.quarantineEvents ?? 0}건`],
    ["가상주문 사전차단", `${uniqueBlocked.size}종목`],
    ["원본 OOS", "보존"]
  ];
  document.querySelector("#marketIntegrityMetrics").innerHTML = metrics.map(([label, value]) => `
    <article class="metric-card"><span>${label}</span><strong>${value}</strong></article>`).join("");

  const status = document.querySelector("#marketIntegrityStatus");
  if (status) status.textContent = "원본 OOS·가상계좌 손익은 삭제하지 않습니다. 알려진 특수시장 상태는 다음 시가 주문 전에 차단하고, 과거의 강한 가격단절 의심은 비교용 정합성 성과에서만 별도 격리합니다.";

  const cohorts = [
    ["actual", "✅ 진입판정"],
    ["core", "🔥 핵심후보"],
    ["strong", "⭐ 강한후보"]
  ];
  document.querySelector("#marketIntegrityCohorts").innerHTML = cohorts.map(([id, label]) => {
    const c = integrity.cohorts?.[id] ?? {};
    const h3 = c.horizons?.["3"] ?? {};
    const h5 = c.horizons?.["5"] ?? {};
    const p5 = integrity.portfolio?.[id]?.["5"] ?? {};
    const q = Number(h3.quarantined ?? 0) + Number(h5.quarantined ?? 0);
    return `<tr>
      <td><b>${label}</b></td>
      <td><span class="${tone(h3.raw?.avgReturnPct)}">${pct(h3.raw?.avgReturnPct)}</span> → <b class="${tone(h3.comparable?.avgReturnPct)}">${pct(h3.comparable?.avgReturnPct)}</b><div class="cell-sub">n ${h3.raw?.n ?? 0} → ${h3.comparable?.n ?? 0}</div></td>
      <td><span class="${tone(h5.raw?.avgReturnPct)}">${pct(h5.raw?.avgReturnPct)}</span> → <b class="${tone(h5.comparable?.avgReturnPct)}">${pct(h5.comparable?.avgReturnPct)}</b><div class="cell-sub">n ${h5.raw?.n ?? 0} → ${h5.comparable?.n ?? 0}</div></td>
      <td><b class="${tone(p5.totalReturnPct)}">${pct(p5.totalReturnPct)}</b><div class="cell-sub">${p5.completedTrades ?? 0}건 · MDD ${pct(p5.realizedMaxDrawdownPct)}</div></td>
      <td>${q}건</td>
    </tr>`;
  }).join("");

  const recent = integrity.quarantinedRecent ?? [];
  document.querySelector("#marketIntegrityRecent").innerHTML = recent.length ? recent.slice(0, 30).map((row) => `
    <tr>
      <td>${row.signalDate}<div class="cell-sub">${row.market}</div></td>
      <td><b>${row.name || row.code}</b><div class="cell-sub">${row.code}</div></td>
      <td>${row.horizon === 0 ? "0D" : `${row.horizon}D`}</td>
      <td class="${tone(row.netReturnPct)}"><b>${pct(row.netReturnPct)}</b></td>
      <td>${(row.reasons ?? []).map(reasonText).join(" · ")}</td>
    </tr>`).join("") : `<tr><td colspan="5" class="loading">현재 격리된 가격단절/특수종목 결과가 없습니다.</td></tr>`;
}

async function loadMarketIntegrity() {
  ensurePanel();
  try {
    const [integrityResponse, paperResponse] = await Promise.all([
      fetch("/api/simulation-integrity", { signal: AbortSignal.timeout(20000) }),
      fetch("/api/paper-auto", { signal: AbortSignal.timeout(20000) })
    ]);
    if (!integrityResponse.ok) throw new Error(`integrity HTTP ${integrityResponse.status}`);
    const integrity = await integrityResponse.json();
    const paper = paperResponse.ok ? await paperResponse.json() : null;
    renderIntegrity(integrity, paper);
  } catch (error) {
    const status = document.querySelector("#marketIntegrityStatus");
    if (status) status.textContent = `데이터 정합성 결과를 불러오지 못했습니다: ${error.message}`;
  }
}

loadMarketIntegrity();
