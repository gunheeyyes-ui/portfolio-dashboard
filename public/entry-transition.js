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

function normalizeTradingDate(value) {
  const text = String(value ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return null;
}

function normalizeTradingDates(values, currentSignalDate) {
  return [...new Set((values ?? []).map(normalizeTradingDate).filter(Boolean))]
    .filter((date) => date < currentSignalDate)
    .sort();
}

export function buildEntryTransitionLookup(selections, currentSignalDate, tradingDatesByMarket = {}) {
  const byMarket = new Map();

  for (const market of MARKETS) {
    const rows = actionableSelections(selections, currentSignalDate).filter((row) => row.market === market);
    const byDate = new Map();
    for (const row of rows) byDate.set(row.signalDate, membersSet(row));
    const dates = [...byDate.keys()].sort();
    const tradingDates = normalizeTradingDates(tradingDatesByMarket?.[market], currentSignalDate);
    const historyStartDate = dates[0] ?? null;
    const trackedTradingDates = historyStartDate
      ? tradingDates.filter((date) => date >= historyStartDate)
      : tradingDates;
    const missingSelectionDates = trackedTradingDates.filter((date) => !byDate.has(date));
    byMarket.set(market, {
      dates,
      byDate,
      tradingDates,
      historyStartDate,
      missingSelectionDates,
      calendarAvailable: tradingDates.length > 0
    });
  }

  function classify(market, code) {
    const history = byMarket.get(market);
    const dates = history?.dates ?? [];
    const tradingDates = history?.tradingDates ?? [];
    const calendarAvailable = history?.calendarAvailable === true;
    const previousRecordedSignalDate = dates.at(-1) ?? null;
    const previousTradingDate = calendarAvailable ? (tradingDates.at(-1) ?? null) : previousRecordedSignalDate;
    const historyStartDate = history?.historyStartDate ?? null;

    if (!dates.length) {
      return {
        key: "unknown",
        label: "이력없음",
        previousSignalDate: null,
        previousTradingDate,
        streakDays: null,
        totalSignalDays: null,
        firstSignalDate: null,
        lastSeenBefore: null,
        gapTradingDays: null,
        recentSignalDates: [],
        historyStartDate: null,
        historyBasis: calendarAvailable ? "market-calendar" : "recorded-only",
        historyGap: false,
        missingSelectionDates: []
      };
    }

    const ticker = String(code ?? "");
    const historicalDates = dates.filter((date) => (history.byDate.get(date) ?? new Set()).has(ticker));
    const firstSignalDate = historicalDates[0] ?? currentSignalDate;
    const lastSeenBefore = historicalDates.at(-1) ?? null;
    const totalSignalDays = historicalDates.length + 1;
    const recentSignalDates = [...historicalDates, currentSignalDate].slice(-8);
    const missingSelectionDates = (history.missingSelectionDates ?? []).slice(-12);

    // If the immediately preceding real market session has no ACTIONABLE_ALL
    // snapshot, we cannot honestly call today's signal 신규/유지/재진입.
    // Keep the stock actionable, but mark the transition as unknown instead of
    // fabricating continuity from the nearest older recorded day.
    if (calendarAvailable && previousTradingDate && !history.byDate.has(previousTradingDate)) {
      return {
        key: "unknown",
        label: "이력누락",
        previousSignalDate: previousRecordedSignalDate,
        previousTradingDate,
        streakDays: null,
        totalSignalDays,
        firstSignalDate,
        lastSeenBefore,
        gapTradingDays: null,
        recentSignalDates,
        historyStartDate,
        historyBasis: "market-calendar",
        historyGap: true,
        missingSelectionDates
      };
    }

    const comparisonDate = previousTradingDate ?? previousRecordedSignalDate;
    const previousMembers = comparisonDate ? (history.byDate.get(comparisonDate) ?? new Set()) : new Set();
    const wasActionablePrevious = previousMembers.has(ticker);

    if (wasActionablePrevious) {
      let priorStreak = 0;
      const sequence = calendarAvailable ? tradingDates : dates;
      for (let index = sequence.length - 1; index >= 0; index -= 1) {
        const date = sequence[index];
        const members = history.byDate.get(date);
        if (!members || !members.has(ticker)) break;
        priorStreak += 1;
      }
      return {
        key: "maintain",
        label: `유지 ${priorStreak + 1}일`,
        previousSignalDate: comparisonDate,
        previousTradingDate,
        streakDays: priorStreak + 1,
        totalSignalDays,
        firstSignalDate,
        lastSeenBefore,
        gapTradingDays: 0,
        recentSignalDates,
        historyStartDate,
        historyBasis: calendarAvailable ? "market-calendar" : "recorded-only",
        historyGap: false,
        missingSelectionDates
      };
    }

    const appearedEarlier = historicalDates.length > 0;
    const calendar = calendarAvailable ? tradingDates : dates;
    const gapTradingDays = appearedEarlier && lastSeenBefore
      ? calendar.filter((date) => date > lastSeenBefore && date < currentSignalDate).length
      : 0;

    return {
      key: appearedEarlier ? "reentry" : "new",
      label: appearedEarlier ? "재진입" : "신규",
      previousSignalDate: comparisonDate,
      previousTradingDate,
      streakDays: 1,
      totalSignalDays,
      firstSignalDate,
      lastSeenBefore,
      gapTradingDays,
      recentSignalDates,
      historyStartDate,
      historyBasis: calendarAvailable ? "market-calendar" : "recorded-only",
      historyGap: false,
      missingSelectionDates
    };
  }

  return {
    currentSignalDate,
    classify
  };
}
