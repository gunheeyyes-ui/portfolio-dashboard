const currency = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const pct = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function money(value) {
  return Number.isFinite(Number(value)) ? `${currency.format(Number(value))}원` : "—";
}

function percent(value) {
  if (!Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  return `${number > 0 ? "+" : ""}${pct.format(number)}%`;
}

function signClass(value) {
  if (!Number.isFinite(Number(value))) return "";
  return Number(value) > 0 ? "positive" : Number(value) < 0 ? "negative" : "";
}

function dateText(value) {
  const text = String(value ?? "");
  return /^\d{8}$/.test(text) ? `${text.slice(4, 6)}/${text.slice(6, 8)}` : text || "—";
}

function emptyRow(colspan, text) {
  return `<tr><td colspan="${colspan}" class="loading">${text}</td></tr>`;
}

function renderMetrics(model) {
  const target = document.querySelector("#paperAutoMetrics");
  if (!target) return;
  const summary = model.summary ?? {};
  const items = [
    ["가상자산", money(summary.equity)],
    ["누적수익", percent(summary.totalReturnPct)],
    ["실현손익", money(summary.realizedPnl)],
    ["미실현손익", money(summary.unrealizedPnl)],
    ["보유", `${summary.openPositions ?? 0} / ${model.policy?.maxPositions ?? 10}`],
    ["완료", `${summary.closedTrades ?? 0}건`],
    ["승률", percent(summary.winRatePct)],
    ["PF", Number.isFinite(Number(summary.profitFactor)) ? Number(summary.profitFactor).toFixed(2) : "—"]
  ];
  target.innerHTML = items.map(([label, value]) => `
    <article class="metric-card">
      <span>${label}</span>
      <strong>${value}</strong>
    </article>`).join("");
}

function renderOpen(model) {
  const target = document.querySelector("#paperAutoOpen");
  if (!target) return;
  const rows = model.open ?? [];
  target.innerHTML = rows.length ? rows.map((row) => `
    <tr>
      <td><b>${row.name || row.code}</b><br><small>${row.code}</small></td>
      <td>${dateText(row.entryDate)}<br><small>${currency.format(row.entryPrice)}원</small></td>
      <td>${currency.format(row.quantity)}주<br><small>${money(row.principal)}</small></td>
      <td>${Number.isFinite(Number(row.currentPrice)) ? `${currency.format(row.currentPrice)}원` : "—"}</td>
      <td class="${signClass(row.paperReturnPct)}"><b>${percent(row.paperReturnPct)}</b><br><small>${money(row.unrealizedPnl)}</small></td>
      <td>${row.tradingDaysElapsed ?? "—"}D<br><small>${row.plannedExit}</small></td>
      <td>${row.strategyCount}전략 · ${row.axisCount}계열</td>
    </tr>`).join("") : emptyRow(7, "현재 보유 중인 Shadow Auto 포지션이 없습니다.");
}

function renderQueued(model) {
  const target = document.querySelector("#paperAutoQueued");
  if (!target) return;
  const rows = model.queued ?? [];
  target.innerHTML = rows.length ? rows.map((row) => `
    <tr>
      <td>${row.signalDate}</td>
      <td><b>${row.name || row.code}</b><br><small>${row.code}</small></td>
      <td>${Number.isFinite(Number(row.signalPrice)) ? `${currency.format(row.signalPrice)}원` : "—"}</td>
      <td>${row.strategyCount}전략 · ${row.axisCount}계열</td>
      <td>다음 거래일 시가 대기</td>
    </tr>`).join("") : emptyRow(5, "대기 중인 가상 주문이 없습니다.");
}

function renderClosed(model) {
  const target = document.querySelector("#paperAutoClosed");
  if (!target) return;
  const rows = model.closed ?? [];
  target.innerHTML = rows.length ? rows.slice(0, 50).map((row) => `
    <tr>
      <td><b>${row.name || row.code}</b><br><small>${row.code}</small></td>
      <td>${dateText(row.entryDate)} → ${dateText(row.exitDate)}</td>
      <td>${currency.format(row.entryPrice)} → ${Number.isFinite(Number(row.exitPrice)) ? currency.format(row.exitPrice) : "—"}</td>
      <td>${currency.format(row.quantity)}주</td>
      <td class="${signClass(row.paperReturnPct)}"><b>${percent(row.paperReturnPct)}</b></td>
      <td class="${signClass(row.pnl)}">${money(row.pnl)}</td>
      <td>${row.strategyCount}전략 · ${row.axisCount}계열</td>
    </tr>`).join("") : emptyRow(7, "아직 3거래일 청산이 완료된 거래가 없습니다.");
}

function renderStatus(model) {
  const target = document.querySelector("#paperAutoStatus");
  if (!target) return;
  const policy = model.policy ?? {};
  const summary = model.summary ?? {};
  target.textContent = `${policy.startSignalDate} 신호부터 · 실제진입만 · 다음날 시가 매수 · 3거래일 종가 청산 · 종목당 ${money(policy.positionBudget)} · 최대 ${policy.maxPositions}종목 · 왕복비용 ${policy.trackerRoundTripCostPct}% + 보수적 슬리피지 ${policy.extraExecutionSlippagePct}% · 실주문 없음 · 신호 ${summary.signalCount ?? 0}건`;
}

async function loadPaperAuto() {
  const status = document.querySelector("#paperAutoStatus");
  try {
    const response = await fetch("/api/paper-auto", { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const model = await response.json();
    renderMetrics(model);
    renderStatus(model);
    renderOpen(model);
    renderQueued(model);
    renderClosed(model);
  } catch (error) {
    if (status) status.textContent = `Shadow Auto 데이터를 불러오지 못했습니다: ${error.message}`;
  }
}

loadPaperAuto();
