const VERDICT_LABELS = {
  STRONG_POSITIVE: ["강한긍정", "strong-positive"],
  POSITIVE: ["긍정", "positive"],
  NEUTRAL: ["중립", "neutral"],
  NEGATIVE: ["부정", "negative"],
  REJECT: ["제외", "reject"]
};

const state = {
  status: null,
  requestedKey: null,
  reviews: new Map(),
  meta: null,
  inFlight: false,
  scheduled: false
};

if (!document.querySelector('link[href="/home-ai-review.css"]')) {
  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = "/home-ai-review.css";
  document.head.appendChild(style);
}

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function num(value) {
  return finite(value) ? Number(value) : null;
}

function candidateRows() {
  return [...document.querySelectorAll("#homeEntryCandidates tr")]
    .filter((row) => row.querySelector('a.stock-link[href*="/domestic/stock/"]'));
}

function rowCode(row) {
  return row.querySelector('a.stock-link[href*="/domestic/stock/"]')?.href.match(/\/stock\/(\d{6})\//)?.[1] ?? null;
}

function ensureColumn() {
  const headerRow = document.querySelector(".home-entry-table thead tr");
  if (headerRow && !headerRow.querySelector(".ai-review-head")) {
    const th = document.createElement("th");
    th.className = "ai-review-head";
    th.title = "기존 산식을 바꾸지 않는 GPT-5.6 Luna 독립 검토. 상위 후보 최대 5개만 분석합니다.";
    th.textContent = "AI 검토";
    headerRow.appendChild(th);
  }
  const loadingRow = document.querySelector("#homeEntryCandidates tr:not(:has(a.stock-link)) td[colspan]");
  if (loadingRow) loadingRow.colSpan = 10;
  for (const row of candidateRows()) {
    if (row.querySelector(".ai-review-cell")) continue;
    const td = document.createElement("td");
    td.className = "ai-review-cell";
    td.innerHTML = '<span class="ai-review-muted">대기</span>';
    row.appendChild(td);
  }
}

function setCell(row, html) {
  const cell = row.querySelector(".ai-review-cell");
  if (cell) cell.innerHTML = html;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

function renderCells() {
  ensureColumn();
  const max = state.status?.maxCandidates ?? 5;
  candidateRows().forEach((row, index) => {
    const code = rowCode(row);
    if (!code) return;
    if (index >= max) return setCell(row, '<span class="ai-review-muted">—</span>');
    if (state.status && !state.status.enabled) return setCell(row, '<span class="ai-review-muted" title="서버 OPENAI_API_KEY 필요">키 필요</span>');
    const review = state.reviews.get(code);
    if (!review) return setCell(row, `<span class="ai-review-muted">${state.inFlight ? "분석중" : "대기"}</span>`);
    const [label, cls] = VERDICT_LABELS[review.verdict] ?? [review.verdict, "neutral"];
    setCell(row, `<button class="ai-review-btn ${cls}" type="button" data-ai-review-code="${code}" title="${escapeHtml(review.summary)}">${label} ${review.confidence}</button>`);
  });
}

function readDisplayContext(row) {
  const cells = [...row.children];
  return {
    candidateDisplay: cells[0]?.textContent?.trim() ?? "",
    strategyConsensus: cells[6]?.textContent?.trim() ?? "",
    rebound: cells[7]?.textContent?.trim() ?? ""
  };
}

function candidateFromSource(source, display) {
  return {
    code: String(source.code ?? ""),
    name: source.name ?? "",
    market: source.market ?? null,
    candidateLabel: display.candidateDisplay.includes("핵심") ? "core" : (display.candidateDisplay.includes("강한") ? "strong" : "unknown"),
    candidateDisplay: display.candidateDisplay,
    price: num(source.price ?? source.quote?.price),
    changeRate: num(source.changeRate ?? source.quote?.changeRate ?? source.strategy?.dayChangePct),
    changeRate3d: num(source.changeRate3d ?? source.strategy?.change3dPct),
    drawdownFromHighPct: num(source.scout?.drawdownFromHighPct),
    leader: {
      grade: source.leader?.grade ?? null,
      score: num(source.leader?.score),
      rank: num(source.leader?.rank)
    },
    timing: {
      score: num(source.combined?.score),
      label: source.combined?.label ?? null
    },
    rs20: num(source.scout?.rs20),
    strategyConsensus: display.strategyConsensus,
    rebound: display.rebound,
    risk: num(source.scout?.riskScore),
    stabilize: num(source.scout?.stabilizeScore),
    supply: {
      liquidityScore: num(source.supply?.liquidityScore),
      foreignStreak: num(source.supply?.foreignStreak),
      institutionStreak: num(source.supply?.instStreak),
      totalNetAmount: num(source.supply?.totalNetAmount),
      smartMoneyTradingSharePct: num(source.supply?.smartMoneyTradingSharePct)
    },
    confirmations: {
      cafe: source.confirmation?.cafePass === true,
      mtt: source.confirmation?.minerviniPass === true,
      leaderRebound: source.confirmation?.leaderReboundPass === true
    },
    judgement: source.judgement ?? "",
    reasons: Array.isArray(source.reasons) ? source.reasons.slice(0, 6) : []
  };
}

async function loadStatus() {
  if (state.status) return state.status;
  const response = await fetch("/api/ai-review/status", { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("AI 검토 상태를 불러오지 못했습니다.");
  state.status = await response.json();
  return state.status;
}

async function reviewVisibleCandidates() {
  ensureColumn();
  const rows = candidateRows();
  if (!rows.length || state.inFlight) return;

  let status;
  try {
    status = await loadStatus();
  } catch {
    renderCells();
    return;
  }
  if (!status.enabled) return renderCells();

  const selectedRows = rows.slice(0, status.maxCandidates ?? 5);
  const selected = selectedRows.map((row) => ({ code: rowCode(row), display: readDisplayContext(row) })).filter((item) => item.code);
  const requestedKey = selected.map((item) => item.code).join(",");
  if (!requestedKey || state.requestedKey === requestedKey) return renderCells();

  state.requestedKey = requestedKey;
  state.inFlight = true;
  renderCells();
  try {
    const screener = await fetch("/api/market-screener?limit=100&market=ALL", { signal: AbortSignal.timeout(30000) });
    if (!screener.ok) throw new Error("시장 데이터를 다시 확인하지 못했습니다.");
    const payload = await screener.json();
    const sourceRows = [...(payload.rows?.KOSPI ?? []), ...(payload.rows?.KOSDAQ ?? [])];
    const byCode = new Map(sourceRows.map((row) => [String(row.code ?? ""), row]));
    const candidates = selected
      .map((item) => byCode.has(item.code) ? candidateFromSource(byCode.get(item.code), item.display) : null)
      .filter(Boolean);
    if (!candidates.length) throw new Error("AI 검토 대상 데이터를 찾지 못했습니다.");

    const signalDate = payload.marketDataAsOf || new Date(payload.asOf || Date.now()).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
    const response = await fetch("/api/ai-review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(70000),
      body: JSON.stringify({
        signalDate,
        marketDataAsOf: payload.marketDataAsOf || signalDate,
        dataMode: payload.dataMode || payload.cloud?.dataMode || null,
        candidates
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || result.error || "AI 검토 실패");
    state.reviews = new Map((result.reviews ?? []).map((review) => [review.code, review]));
    state.meta = result;
  } catch (error) {
    console.warn("[home-ai-review]", error);
    for (const row of selectedRows) setCell(row, `<span class="ai-review-muted" title="${escapeHtml(error.message)}">확인필요</span>`);
  } finally {
    state.inFlight = false;
    renderCells();
  }
}

function ensureDialog() {
  let dialog = document.querySelector("#aiReviewDialog");
  if (dialog) return dialog;
  dialog = document.createElement("dialog");
  dialog.id = "aiReviewDialog";
  dialog.className = "ai-review-dialog";
  dialog.innerHTML = '<div class="ai-review-dialog-card"></div>';
  document.body.appendChild(dialog);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog || event.target.closest("[data-ai-review-close]")) dialog.close();
  });
  return dialog;
}

function openReview(code) {
  const review = state.reviews.get(code);
  if (!review) return;
  const row = candidateRows().find((item) => rowCode(item) === code);
  const name = row?.querySelector("a.stock-link")?.textContent?.trim() || code;
  const [label] = VERDICT_LABELS[review.verdict] ?? [review.verdict, "neutral"];
  const dialog = ensureDialog();
  dialog.querySelector(".ai-review-dialog-card").innerHTML = `
    <div class="ai-review-dialog-header">
      <div><h3>${escapeHtml(name)} · ${escapeHtml(label)} ${review.confidence}</h3><p class="ai-review-kicker">${escapeHtml(state.meta?.model ?? "GPT-5.6 Luna")} · 기존 순위/산식 비개입 독립검토</p></div>
      <button class="ai-review-dialog-close" type="button" data-ai-review-close aria-label="닫기">×</button>
    </div>
    <div class="ai-review-block"><b>BULL</b><p>${escapeHtml(review.bull_case)}</p></div>
    <div class="ai-review-block"><b>BEAR</b><p>${escapeHtml(review.bear_case)}</p></div>
    <div class="ai-review-block"><b>핵심 리스크</b><ul class="ai-review-risk-list">${(review.key_risks ?? []).map((risk) => `<li>${escapeHtml(risk)}</li>`).join("") || "<li>별도 핵심 리스크 없음</li>"}</ul></div>
    <div class="ai-review-block"><b>무효화 조건</b><p>${escapeHtml(review.invalidation)}</p></div>
    <div class="ai-review-block"><b>요약</b><p>${escapeHtml(review.summary)}</p></div>`;
  dialog.showModal();
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-ai-review-code]");
  if (button) openReview(button.dataset.aiReviewCode);
});

function scheduleReview() {
  if (state.scheduled) return;
  state.scheduled = true;
  setTimeout(() => {
    state.scheduled = false;
    ensureColumn();
    reviewVisibleCandidates();
  }, 120);
}

const target = document.querySelector("#homeEntryCandidates");
if (target) new MutationObserver(scheduleReview).observe(target, { childList: true, subtree: true });
scheduleReview();
