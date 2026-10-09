#!/usr/bin/env python3
"""As-of KOSPI/KOSDAQ top-100 sample from full historical markets (price-only RS20).
Retains subsequently delisted members on their actual historical dates.
No real orders. No assumption that this tests all 107 strategies.
"""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import urllib.request
import pandas as pd

YEARS = (2022, 2023, 2024, 2025, 2026)
COLUMNS = ["Date","Code","Name","Market","Open","High","Low","Close","Volume","Amount","Marcap","Stocks"]

def run(cache, output, source_sha="master", start="2024-09-19", end="2026-07-14"):
    cache = Path(cache)
    cache.mkdir(parents=True, exist_ok=True)
    frames, digests = [], {}
    for year in YEARS:
        p = cache / f"marcap-{year}.parquet"
        if not p.exists():
            url = f"https://raw.githubusercontent.com/FinanceData/marcap/{source_sha}/data/marcap-{year}.parquet"
            urllib.request.urlretrieve(url, p)
        digests[str(year)] = hashlib.sha256(p.read_bytes()).hexdigest()
        frames.append(pd.read_parquet(p, columns=COLUMNS))
    df = pd.concat(frames, ignore_index=True)
    df = df[df.Market.isin(["KOSPI","KOSDAQ","KOSDAQ GLOBAL"])].copy()
    df.loc[df.Market == "KOSDAQ GLOBAL", "Market"] = "KOSDAQ"
    df["Code"] = df.Code.astype(str).str.zfill(6)
    df["Date"] = pd.to_datetime(df.Date)
    for col in ["Open","High","Low","Close","Volume","Amount","Marcap","Stocks"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    if df.duplicated(["Date","Market","Code"]).any():
        raise ValueError("Duplicate dated stock. PIT results must fail closed.")
    if df[["Marcap","Stocks"]].isna().any(axis=1).any():
        raise ValueError("Historical market capitalizations / share counts unavailable.")
    df.sort_values(["Code","Date"], inplace=True)
    df["ret20"] = (df.Close / df.groupby("Code").Close.shift(20) - 1) * 100
    df = df[df.Date.between(pd.Timestamp(start),pd.Timestamp(end)+pd.Timedelta(days=60))]
    date_market = df[df.Date.between(start,end)].groupby(["Date","Market"]).size()
    dates = list(pd.DatetimeIndex(sorted(df.Date.unique())))
    signal_dates = [date for date in dates if pd.Timestamp(start) <= date <= pd.Timestamp(end)]
    if len(signal_dates) < 300 or len(date_market) != len(signal_dates)*2 or date_market.min() < 500:
        raise ValueError("Missing historical whole-market coverage. Research blocked.")
    selected = df[df.Date.between(start,end)].sort_values(
        ["Date","Market","Marcap"], ascending=[True,True,False])
    selected = selected.groupby(["Date","Market"],sort=False).head(100).copy()
    if (selected.groupby(["Date","Market"]).size() != 100).any():
        raise ValueError("As-of market membership not complete.")
    last = selected.Date.max()
    future_symbols = {market:set(gr.Code) for market,gr in selected[selected.Date == last].groupby("Market")}
    fixed = df[df.Date.between(start,end)].copy()
    fixed = fixed[[code in future_symbols.get(market,set()) for market,code in zip(fixed.Market,fixed.Code)]]
    next_day = {date: dates[i+1] for i,date in enumerate(dates[:-1])}
    exits = {h:{date:dates[i+1+h] for i,date in enumerate(dates[:-h-1])} for h in (5,10,20)}
    lookup = df.set_index(["Date","Code"])[["Open","Close"]]
    experiments = []
    for sample, universe in [("HISTORICAL_AS_OF",selected),("FUTURE_FIXED_CONTROL",fixed)]:
        signal_rows = []
        for (date,market),group in universe.groupby(["Date","Market"],sort=True):
            signals = group[group.ret20.notna()].sort_values("ret20",ascending=False).head(10)
            for rank,item in enumerate(signals.itertuples(index=False),1):
                for horizon in (5,10,20):
                    entry_day,exit_day = next_day.get(date),exits[horizon].get(date)
                    entry = float(lookup.loc[(entry_day,item.Code),"Open"]) if entry_day is not None and (entry_day,item.Code) in lookup.index else None
                    close = float(lookup.loc[(exit_day,item.Code),"Close"]) if exit_day is not None and (exit_day,item.Code) in lookup.index else None
                    if entry is not None and entry <= 0: entry = None
                    if close is not None and close <= 0: close = None
                    status = "NO_NEXT_OPEN" if entry is None else "CENSORED_EXIT" if close is None else "CLOSED"
                    net = 100*(close/entry-1)-0.23 if status=="CLOSED" else None
                    signal_rows.append((rank,horizon,status,net))
        trades = pd.DataFrame(signal_rows,columns=["rank","horizon","status","net"])
        for top_n in (3,5,10):
            for horizon in (5,10,20):
                g = trades[(trades["rank"] <= top_n)&(trades["horizon"]==horizon)]
                good = g[g.status=="CLOSED"]
                empty = int((g.status=="NO_NEXT_OPEN").sum())
                censored = int((g.status=="CENSORED_EXIT").sum())
                # Do not silently drop disappearing firms. Cash for unfilled orders;
                # worst-case loss for censored exits is a sensitivity, not real proceeds.
                sensitivity = (good.net.sum() - censored*100.23)/len(g) if len(g) else None
                experiments.append({"universe":sample,"topN":top_n,"holdingSessions":horizon,
                  "observedSignals":int(len(g)),"completed":int(len(good)),
                  "unfilledEntries":empty,"missingExits":censored,
                  "averageCompletedTradePct":round(float(good.net.mean()),4) if len(good) else None,
                  "conservativeMissingExitStressPct":round(float(sensitivity),4) if sensitivity is not None else None})
    all_past=set(selected.Code)
    fixed_all=set.union(*future_symbols.values())
    report = {"schema":"pit-price-only-rs20-v1","createdAt":dt.datetime.now(dt.timezone.utc).isoformat(),
      "source":{"repo":"FinanceData/marcap","ref":source_sha,"yearSHA256":digests,"raw":"KRX-date-market snapshots"},
      "coverage":{"from":start,"through":end,"tradingSessions":len(signal_dates),
        "historicalMembershipRows":len(selected),"historicalDistinctStocks":len(all_past),
        "futureFixedControlStocks":len(fixed_all),
        "historicalStocksAbsentFromFutureSample":len(all_past-fixed_all)},
      "method":{"sample":"Top 100 daily historical market cap each of KOSPI and KOSDAQ",
        "signal":"Price RS20 (20 ticker-sessions), EOD only","entry":"next market session open",
        "exit":"h sessions after next open at close","costPct":0.23,
        "warning":"PRICE-ONLY exploratory comparison, NOT existing 107-strategy validation. No investor flows, corporate-action reconciliation, liquidity impact, exact delisting cash proceeds, or real-order fills."},
      "experiments":experiments,"realMoneyApproved":False}
    target = Path(output)
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({"coverage":report["coverage"],"top3":experiments[:3],"report":str(target)}))
    return report

if __name__ == "__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--cache",required=True)
    p.add_argument("--output",required=True)
    p.add_argument("--source-sha",default="master")
    args=p.parse_args()
    run(args.cache,args.output,args.source_sha)
