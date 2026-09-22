const MARKETS = ["KOSPI", "KOSDAQ"];

function actionableSelections(selections, currentSignalDate) {
  return (selections ?? [])
    .filter((row) => row?.strategyId === "ACTIONABLE_ALL")
    .filter((row) => MARKETS.includes(row?.market))
    .filter((row) => typeof row?.signalDate === "string" && row.signalDate < currentSignalDate)
    .sort((a, b) => a.signalDate.localeCompare(b.signalDate));
}

function membersSet(selection) {
  return new Set((selection?.members ?? []).map((member) => String(member?.code ?? "")).filter(Boolean));
}

export function buildEntryTransitionLookup(selections, currentSignalDate) {
  const byMarket = new Map();

  for (const market of MARKETS) {
    const rows = actionableSelections(selections, currentSignalDate).filter((row) => row.market === market);
    const byDate = new Map();
    for (const row of rows) byDate.set(row.signalDate, membersSet(row));
    const dates = [...byDate.keys()].sort();
    byMarket.set(market, { dates, byDate });
  }

  function classify(market, code) {
    const history = byMarket.get(market);
    const dates = history?.dates ?? [];
    if (!dates.length) {
      return {
        key: "unknown",
        label: "이력없음",
        previousSignalDate: null,
        streakDays: null
      };
    }

    const ticker = String(code ?? "");
    const previousSignalDate = dates.at(-1);
    const previousMembers = history.byDate.get(previousSignalDate) ?? new Set();
    const wasActionablePrevious = previousMembers.has(ticker);

    if (wasActionablePrevious) {
      let priorStreak = 0;
      for (let index = dates.length - 1; index >= 0; index -= 1) {
        const date = dates[index];
        if (!(history.byDate.get(date) ?? new Set()).has(ticker)) break;
        priorStreak += 1;
      }
      return {
        key: "maintain",
        label: `유지 ${priorStreak + 1}일`,
        previousSignalDate,
        streakDays: priorStreak + 1
      };
    }

    const appearedEarlier = dates
      .slice(0, -1)
      .some((date) => (history.byDate.get(date) ?? new Set()).has(ticker));

    return {
      key: appearedEarlier ? "reentry" : "new",
      label: appearedEarlier ? "재진입" : "신규",
      previousSignalDate,
      streakDays: 1
    };
  }

  return {
    currentSignalDate,
    classify
  };
}
