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

function allRows(model, field) {
  return (model.accounts ?? []).flatMap((account) => (account[field] ?? []).map((row) => ({ ...row, accountId: account.id, accountLabel: account.label })));
}

function renderMetrics(model) {
  const target = document.querySelector("#paperAutoMetrics");
  if (!target) return;
  const policy = model.arenaPolicy ?? {};
  const slip = policy.slippageByLiquidity ?? {};
  const items = [
    ["가상계좌", `${model.accounts?.length ?? 0}개`],
    ["계좌당 자금", money(policy.initialCapitalPerAccount)],
    ["종목당", money(policy.positionBudget)],
    ["최대보유", `${policy.maxPositions ?? 10}종목`],
    ["보유기간", `${policy.holdTradingDays ?? 3}거래일`],
    ["기본비용", percent(policy.trackerRoundTripCostPct)],
    ["추가 슬리피지", `${percent(slip.highPct)}~${percent(slip.lowPct)}`],
    ["실주문", "없음"]
  ];
  target.innerHTML = items.map(([label, value]) => `
    <article class="metric-card">
      <span>${label}</span>
      <strong>${value}</strong>
    </article>`).join("");
}

function renderAccounts(model) {
  const target = document.querySelector("#paperAutoAccounts");
  if (!target) return;
  const accounts = model.accounts ?? [];
  target.innerHTML = accounts.length ? accounts.map((account) => {
    const s = account.summary ?? {};
    return `<tr>
      <td><b>${account.label}</b><div class="cell-sub">${account.description ?? ""}</div></td>
      <td><b>${money(s.equity)}</b></td>
      <td class="${signClass(s.totalReturnPct)}"><b>${percent(s.totalReturnPct)}</b></td>
      <td>${s.signalCount ?? 0}</td>
      <td>${s.openPositions ?? 0}</td>
      <td>${s.closedTrades ?? 0}</td>
      <td>${percent(s.winRatePct)}</td>
      <td>${Number.isFinite(Number(s.profitFactor)) ? Number(s.profitFactor).toFixed(2) : "—"}</td>
      <td class="${signClass(s.maxDrawdownPct)}">${percent(s.maxDrawdownPct)}</td>
      <td>${percent(s.averageEffectiveFrictionPct)}</td>
    </tr>`;
  }).join("") : emptyRow(10, "Shadow Auto 계좌가 없습니다.");
}

function renderOpen(model) {
  const target = document.querySelector("#paperAutoOpen");
  if (!target) return;
  const rows = allRows(model, "open");
  target.innerHTML = rows.length ? rows.map((row) => `
    <tr>
      <td><b>${row.accountLabel}</b></td>
      <td><b>${row.name || row.code}</b><br><small>${row.code}</small></td>
      <td>${dateText(row.entryDate)}<br><small>${currency.format(row.entryPrice)}원</small></td>
      <td>${currency.format(row.quantity)}주<br><small>${money(row.principal)}</small></td>
      <td>${Number.isFinite(Number(row.currentPrice)) ? `${currency.format(row.currentPrice)}원` : "—"}</td>
      <td class="${signClass(row.paperReturnPct)}"><b>${percent(row.paperReturnPct)}</b><br><small>${money(row.unrealizedPnl)}</small></td>
      <td>${percent(row.executionSlippagePct)}<br><small>총 ${percent(row.effectiveFrictionPct)}</small></td>
      <td>${row.tradingDaysElapsed ?? "—"}D<br><small>${row.plannedExit}</small></td>
    </tr>`).join("") : emptyRow(8, "현재 보유 중인 Shadow Auto 포지션이 없습니다.");
}

function renderQueued(model) {
  const target = document.querySelector("#paperAutoQueued");
  if (!target) return;
  const rows = allRows(model, "queued");
  target.innerHTML = rows.length ? rows.map((row) => `
    <tr>
      <td><b>${row.accountLabel}</b></td>
      <td>${row.signalDate}</td>
      <td><b>${row.name || row.code}</b><br><small>${row.code}</small></td>
      <td>${Number.isFinite(Number(row.signalPrice)) ? `${currency.format(row.signalPrice)}원` : "—"}</td>
      <td>${row.strategyCount}전략 · ${row.axisCount}계열</td>
      <td>다음 거래일 시가 대기</td>
    </tr>`).join("") : emptyRow(6, "대기 중인 가상 주문이 없습니다.");
}

function renderClosed(model) {
  const target = document.querySelector("#paperAutoClosed");
  if (!target) return;
  const rows = allRows(model, "closed").sort((a, b) => String(b.exitDate).localeCompare(String(a.exitDate)));
  target.innerHTML = rows.length ? rows.slice(0, 100).map((row) => `
    <tr>
      <td><b>${row.accountLabel}</b></td>
      <td><b>${row.name || row.code}</b><br><small>${row.code}</small></td>
      <td>${dateText(row.entryDate)} → ${dateText(row.exitDate)}</td>
      <td>${currency.format(row.entryPrice)} → ${Number.isFinite(Number(row.exitPrice)) ? currency.format(row.exitPrice) : "—"}</td>
      <td>${currency.format(row.quantity)}주</td>
      <td class="${signClass(row.paperReturnPct)}"><b>${percent(row.paperReturnPct)}</b><br><small>${money(row.pnl)}</small></td>
      <td>${percent(row.executionSlippagePct)}<br><small>총 ${percent(row.effectiveFrictionPct)}</small></td>
      <td>${row.strategyCount}전략 · ${row.axisCount}계열</td>
    </tr>`).join("") : emptyRow(8, "아직 3거래일 청산이 완료된 거래가 없습니다.");
}

function renderStatus(model) {
  const target = document.querySelector("#paperAutoStatus");
  if (!target) return;
  const p = model.arenaPolicy ?? {};
  const s = p.slippageByLiquidity ?? {};
  target.textContent = `${p.startSignalDate} 신호부터 · ${model.accounts?.length ?? 0}개 독립 1억원 계좌 · 다음날 시가 매수 · ${p.holdTradingDays}거래일 종가 청산 · 기본 왕복비용 ${p.trackerRoundTripCostPct}% + 유동성별 추가 슬리피지 ${s.highPct}%/${s.midPct}%/${s.lowPct}% · 실주문 없음`;
}

async function loadPaperAuto() {
  const status = document.querySelector("#paperAutoStatus");
  try {
    const response = await fetch("/api/paper-auto", { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const model = await response.json();
    renderMetrics(model);
    renderAccounts(model);
    renderStatus(model);
    renderOpen(model);
    renderQueued(model);
    renderClosed(model);
  } catch (error) {
    if (status) status.textContent = `Shadow Auto 데이터를 불러오지 못했습니다: ${error.message}`;
  }
}

loadPaperAuto();
