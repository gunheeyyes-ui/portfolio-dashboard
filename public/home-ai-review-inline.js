if (!document.querySelector('link[href="/home-ai-review-inline.css"]')) {
  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = "/home-ai-review-inline.css";
  document.head.appendChild(style);
}

const inlineAiState = { scheduled: false };

function candidateRows() {
  return [...document.querySelectorAll("#homeEntryCandidates tr")]
    .filter((row) => row.querySelector('a.stock-link[href*="/domestic/stock/"]'));
}

function desiredInlineMarkup(aiCell) {
  if (!aiCell) return null;
  const button = aiCell.querySelector("[data-ai-review-code]");
  if (button) {
    const clone = button.cloneNode(true);
    clone.classList.add("ai-review-inline-btn");
    clone.textContent = `AI ${button.textContent?.trim() || "검토"}`;
    const holder = document.createElement("div");
    holder.appendChild(clone);
    return holder.innerHTML;
  }

  const text = aiCell.textContent?.trim() || "";
  if (!text || text === "—") return null;
  const span = document.createElement("span");
  span.className = "ai-review-inline-muted";
  span.textContent = `AI ${text}`;
  span.title = aiCell.querySelector("[title]")?.title || "GPT-5.6 Luna 독립 검토 상태";
  const holder = document.createElement("div");
  holder.appendChild(span);
  return holder.innerHTML;
}

function syncCandidateBadgeVisibility(candidateCell) {
  const badge = candidateCell?.querySelector(":scope > .home-entry-badge");
  const isCore = Boolean(badge?.textContent?.includes("핵심"));
  candidateCell?.classList.toggle("home-entry-core-compact", isCore);
}

function syncInlineAi() {
  const loadingCell = document.querySelector("#homeEntryCandidates tr:not(:has(a.stock-link)) td[colspan]");
  if (loadingCell && loadingCell.colSpan !== 9) loadingCell.colSpan = 9;

  for (const row of candidateRows()) {
    const candidateCell = row.children[0];
    const aiCell = row.querySelector(".ai-review-cell");
    if (!candidateCell || !aiCell) continue;

    syncCandidateBadgeVisibility(candidateCell);

    const markup = desiredInlineMarkup(aiCell);
    const signature = markup || "__none__";
    let wrap = candidateCell.querySelector(":scope > .ai-review-inline-wrap");

    if (!markup) {
      if (wrap) wrap.remove();
      candidateCell.dataset.aiInlineSignature = signature;
      continue;
    }

    if (wrap && candidateCell.dataset.aiInlineSignature === signature) continue;
    if (!wrap) {
      wrap = document.createElement("span");
      wrap.className = "ai-review-inline-wrap";
      candidateCell.appendChild(wrap);
    }
    wrap.innerHTML = markup;
    candidateCell.dataset.aiInlineSignature = signature;
  }
}

function scheduleInlineAi() {
  if (inlineAiState.scheduled) return;
  inlineAiState.scheduled = true;
  setTimeout(() => {
    inlineAiState.scheduled = false;
    syncInlineAi();
  }, 60);
}

const table = document.querySelector(".home-entry-table");
if (table) new MutationObserver(scheduleInlineAi).observe(table, { childList: true, subtree: true, characterData: true });
scheduleInlineAi();
