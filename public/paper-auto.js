import "./market-integrity-ui.js";

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

function displayAccounts(model) {
  return model.comparisonAccounts ?? model.accounts ?? [];
}

function allRows(model, field) {
  return displayAccounts(model).flatMap((account) => (account[field] ?? []).map((row) => ({
    ...row,
    accountId: account.id,
    accountLabel: account.label,
    exitVariant: account.exitVariant
  })));
}

function exitReasonText(row) {
  if (row.exitReason === "TAKE_PROFIT") return "익절 +8%";
  if (row.exitReason === "STOP_LOSS") return "손절 -5%";
  if (row.exitReason === "STOP_LOSS_AMBIGUOUS") return "손절 -5%*";
  if (row.exitReason === "TIME_EXIT") return "3D 종가";
  return "—";
}

function renderExperimentCopy(model) {
  const p = model.arenaPolicy ?? {};
  const st = p.stopTakeExperiment ?? {};
  const metrics = document.querySelector("#paperAutoMetrics");
  const guide = metrics?.previousElementSibling;
  if (guide?.classList?.contains("score-guide")) {
    const spans = guide.querySelectorAll("span");
    if (spans[0]) spans[0].innerHTML = `<b>${displayAccounts(model).length}개 비교계좌</b> ${model.accounts?.length ?? 0}개 후보군 × 3D 고정/SL5·TP8`;
    if (spans[2]) spans[2].innerHTML = `<b>청산 A/B</b> 기준군은 ${p.holdTradingDays ?? 3}거래일 종가 · 실험군은 ${st.stopLossPct}% 손절 / +${st.takeProfitPct}% 익절 / 미도달 시 ${p.holdTradingDays ?? 3}D 종가`;
    const small = guide.querySelector("small");
    if (small) small.textContent = "2026-09-07 신호부터 forward-only입니다. 손절·익절은 저장된 OOS MFE/MAE 구간으로 판정하며 한 구간 안에서 -5%와 +8%가 모두 관측되면 장중 선후를 알 수 없어 보수적으로 손절 우선 처리합니다. 다음날 실제 시가·갭·정수주·현금·보유한도·유동성별 슬리피지를 반영하고 기존 Ranking·Simulation·전략 OOS 산식은 변경하지 않습니다.";
  }

  const closedBody = document.querySelector("#paperAutoClosed");
  const closedPanel = closedBody?.closest?.(".sim-panel");
  const closedDescription = closedPanel?.querySelector?.(".section-title p");
  if (closedDescription) closedDescription.textContent = "3D 고정청산과 -5% 손절/+8% 익절 가상계좌의 forward OOS 종료 거래를 함께 비교합니다. *표시는 같은 저장 구간에서 손절·익절이 모두 관측돼 보수적으로 손절을 먼저 적용한 경우입니다.";
}

function renderMetrics(model) {
  const target = document.querySelector("#paperAutoMetrics");
  if (!target) return;
  const policy = model.arenaPolicy ?? {};
  const slip = policy.slippageByLiquidity ?? {};
  const accounts = displayAccounts(model);
  const items = [
    ["비교계좌", `${accounts.length}개`],
    ["구성", `${model.accounts?.length ?? 0}후보군 × ${model.exitVariants?.length ?? 1}청산`],
    ["계좌당 자금", money(policy.initialCapitalPerAccount)],
    ["종목당", money(policy.positionBudget)],
    ["최대보유", `${policy.maxPositions ?? 10}종목`],
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
  const accounts = displayAccounts(model);
  target.innerHTML = accounts.length ? accounts.map((account) => {
    const s = account.summary ?? {};
    const exits = account.exitVariant === "sl5tp8"
      ? `<div class="cell-sub">손절 ${s.stopLossExits ?? 0} · 익절 ${s.takeProfitExits ?? 0} · 3D ${s.timeExits ?? 0}</div>`
      : "";
    const integrity = s.marketStatusBlockedOrders || s.integrityQuarantinedClosedTrades
      ? `<div class="cell-sub">사전차단 ${s.marketStatusBlockedOrders ?? 0} · 정합성격리 ${s.integrityQuarantinedClosedTrades ?? 0} · 비교수익 ${percent(s.comparableReturnPct)}</div>`
      : "";
    return `<tr>
      <td><b>${account.label}</b><div class="cell-sub">${account.description ?? ""}</div>${exits}${integrity}</td>
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
  target.innerHTML = rows.length ? rows.slice(0, 160).map((row) => `
    <tr>
      <td><b>${row.accountLabel}</b></td>
      <td><b>${row.name || row.code}</b><br><small>${row.code}</small></td>
      <td>${dateText(row.entryDate)} → ${dateText(row.exitDate)}<br><small>${exitReasonText(row)}</small></td>
      <td>${currency.format(row.entryPrice)} → ${Number.isFinite(Number(row.exitPrice)) ? currency.format(row.exitPrice) : "—"}</td>
      <td>${currency.format(row.quantity)}주</td>
      <td class="${signClass(row.paperReturnPct)}"><b>${percent(row.paperReturnPct)}</b><br><small>${money(row.pnl)}</small></td>
      <td>${percent(row.executionSlippagePct)}<br><small>총 ${percent(row.effectiveFrictionPct)}</small></td>
      <td>${row.strategyCount}전략 · ${row.axisCount}계열</td>
    </tr>`).join("") : emptyRow(8, "아직 청산이 완료된 거래가 없습니다.");
}

function renderStatus(model) {
  const target = document.querySelector("#paperAutoStatus");
  if (!target) return;
  const p = model.arenaPolicy ?? {};
  const s = p.slippageByLiquidity ?? {};
  const st = p.stopTakeExperiment ?? {};
  const blocked = (model.accounts ?? []).reduce((sum, account) => sum + Number(account.summary?.marketStatusBlockedOrders ?? 0), 0);
  target.textContent = `${p.startSignalDate} 신호부터 · ${model.accounts?.length ?? 0}개 후보군을 3D 고정 vs SL ${st.stopLossPct}% / TP +${st.takeProfitPct}%로 병렬 비교 · 각 1억원 · 다음날 시가 매수 · 기본 왕복비용 ${p.trackerRoundTripCostPct}% + 유동성별 추가 슬리피지 ${s.highPct}%/${s.midPct}%/${s.lowPct}% · 특수시장 사전차단 ${blocked}건 · 실주문 없음`;
}

async function loadPaperAuto() {
  const status = document.querySelector("#paperAutoStatus");
  try {
    const response = await fetch("/api/paper-auto", { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const model = await response.json();
    renderExperimentCopy(model);
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
