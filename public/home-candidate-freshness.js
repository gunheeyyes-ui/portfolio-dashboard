const freshnessState = {
  requestedKey: null,
  inFlight: false,
  scheduled: false
};

if (!document.querySelector('link[href="/home-candidate-freshness.css"]')) {
  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = "/home-candidate-freshness.css";
  document.head.appendChild(style);
}

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function candidateRows() {
  return [...document.querySelectorAll("#homeEntryCandidates tr")]
    .filter((row) => row.querySelector('a.stock-link[href*="/domestic/stock/"]'));
}

function rowCode(row) {
  return row.querySelector('a.stock-link[href*="/domestic/stock/"]')?.href.match(/\/stock\/(\d{6})\//)?.[1] ?? null;
}

function formatRankTrend(item) {
  if (!finite(item.previousLeaderRank) || !finite(item.currentLeaderRank) || !finite(item.leaderRankDelta)) return null;
  const previous = Math.trunc(Number(item.previousLeaderRank));
  const current = Math.trunc(Number(item.currentLeaderRank));
  const delta = Math.trunc(Number(item.leaderRankDelta));
  if (delta < 0) return { cls: "up", text: `${previous}→${current} ↑${Math.abs(delta)}` };
  if (delta > 0) return { cls: "down", text: `${previous}→${current} ↓${Math.abs(delta)}` };
  return { cls: "flat", text: `${previous}→${current} =` };
}

function freshnessPresentation(item, meta) {
  if (!meta.earliestSignalDate) {
    return {
      cls: "unknown",
      label: "기록대기",
      title: "후보 OOS 기록이 아직 없어 신규/유지/재진입을 구분하지 않습니다."
    };
  }
  if (item.status === "MAINTAIN") {
    return {
      cls: "maintain",
      label: `유지 ${item.streakTradingDays}일`,
      title: `OOS 기준 ${item.streakTradingDays}거래일 연속 후보 · 직전 거래일 ${item.previousSignalDate || "-"}`
    };
  }
  if (item.status === "REENTRY") {
    const gap = Number(item.gapTradingDays || 0);
    return {
      cls: "reentry",
      label: "↩ 재진입",
      title: `OOS 기준 마지막 후보 ${item.lastSeenBefore || "-"} 이후 ${gap}거래일 비포착 후 다시 진입`
    };
  }
  return {
    cls: "new",
    label: "🆕 신규",
    title: `OOS 기록 시작일 ${meta.earliestSignalDate} 이후 처음 포착된 후보`
  };
}

function applyFreshness(result) {
  const byCode = new Map((result.rows ?? []).map((item) => [item.code, item]));
  for (const row of candidateRows()) {
    const code = rowCode(row);
    const item = byCode.get(code);
    if (!item) continue;

    row.querySelector(".home-freshness-wrap")?.remove();
    row.querySelector(".home-leader-trend")?.remove();

    const candidateCell = row.children[0];
    if (candidateCell) {
      const presentation = freshnessPresentation(item, result);
      const wrap = document.createElement("span");
      wrap.className = "home-freshness-wrap";
      const badge = document.createElement("span");
      badge.className = `home-freshness-badge ${presentation.cls}`;
      badge.textContent = presentation.label;
      badge.title = presentation.title;
      wrap.appendChild(badge);
      candidateCell.appendChild(wrap);
    }

    const trend = formatRankTrend(item);
    const leaderCell = row.querySelector(".home-entry-leader");
    if (leaderCell && trend) {
      const small = document.createElement("small");
      small.className = `home-leader-trend ${trend.cls}`;
      small.textContent = trend.text;
      small.title = `직전 OOS 거래일(${item.previousSignalDate || "-"}) Leader ${item.previousLeaderRank}위 → 현재 ${item.currentLeaderRank}위`;
      leaderCell.appendChild(small);
    }
  }
}

async function loadFreshness() {
  const rows = candidateRows();
  if (!rows.length || freshnessState.inFlight) return;
  const codes = rows.map(rowCode).filter(Boolean);
  const requestedKey = codes.join(",");
  const alreadyRendered = rows.every((row) => row.querySelector(".home-freshness-wrap"));
  if (!requestedKey || (freshnessState.requestedKey === requestedKey && alreadyRendered)) return;

  freshnessState.inFlight = true;
  freshnessState.requestedKey = requestedKey;
  try {
    const screener = await fetch("/api/market-screener?limit=100&market=ALL", { signal: AbortSignal.timeout(30000) });
    if (!screener.ok) throw new Error("후보 이력용 시장 데이터를 불러오지 못했습니다.");
    const payload = await screener.json();
    const sourceRows = [...(payload.rows?.KOSPI ?? []), ...(payload.rows?.KOSDAQ ?? [])];
    const byCode = new Map(sourceRows.map((row) => [String(row.code ?? ""), row]));
    const candidates = codes.map((code) => {
      const source = byCode.get(code);
      if (!source) return null;
      return {
        code,
        market: source.market,
        leaderRank: finite(source.leader?.rank) ? Number(source.leader.rank) : null
      };
    }).filter((item) => item?.market);
    if (!candidates.length) return;

    const signalDate = payload.marketDataAsOf
      || new Date(payload.asOf || Date.now()).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
    const response = await fetch("/api/candidate-freshness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ signalDate, candidates })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "후보 이력 계산 실패");
    applyFreshness(result);
  } catch (error) {
    console.warn("[home-candidate-freshness]", error);
  } finally {
    freshnessState.inFlight = false;
  }
}

function scheduleFreshness() {
  if (freshnessState.scheduled) return;
  freshnessState.scheduled = true;
  setTimeout(() => {
    freshnessState.scheduled = false;
    loadFreshness();
  }, 150);
}

const freshnessTarget = document.querySelector("#homeEntryCandidates");
if (freshnessTarget) new MutationObserver(scheduleFreshness).observe(freshnessTarget, { childList: true, subtree: true });
scheduleFreshness();
