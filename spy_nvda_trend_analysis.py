"""
SPY / NVDA Trend-Correlation Analyzer — LE Model Framework

Applies all six LE Model rules to 5-minute intraday bars and determines
whether SPY and NVDA are in a matching trend (both bullish-stacked or both
bearish-stacked) suitable for a high-conviction options trade.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from datetime import datetime, time
from typing import Optional

import numpy as np
import pandas as pd
import yfinance as yf

# ──────────────────────────────────────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────────────────────────────────────

# Rubber-band thresholds (price distance from 9 EMA in dollars)
RUBBER_BAND_THRESHOLD = {
    "NVDA": 0.50,
    "SPY":  0.25,
}

# 10 AM macro-candle window (Eastern time)
MACRO_CANDLE_START = time(9, 55)
MACRO_CANDLE_END   = time(10, 5)


# ──────────────────────────────────────────────────────────────────────────────
# Data structures
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class BarSignals:
    """Per-bar LE Model signal state."""
    timestamp:          pd.Timestamp
    close:              float
    ema9:               float
    vwap:               float
    gate2_stack:        str          # 'BULLISH', 'BEARISH', 'NEUTRAL'
    physical_kiss:      bool         # price touched 9 EMA this bar
    rubber_band_ok:     bool         # gap between price and EMA is not overextended
    in_macro_window:    bool         # bar falls inside 10 AM danger zone
    kill_switch:        bool         # candle closed on wrong side of 9 EMA for active bias


@dataclass
class TrendReport:
    """Final report for a single ticker."""
    ticker:             str
    current_price:      float
    ema9:               float
    vwap:               float
    gate2_stack:        str
    physical_kiss_seen: bool
    rubber_band_ok:     bool
    kill_switch_active: bool
    bars:               list[BarSignals] = field(default_factory=list)


@dataclass
class CorrelationReport:
    """SPY × NVDA matching-trend analysis."""
    spy:                TrendReport
    nvda:               TrendReport
    trend_match:        bool         # both tickers share the same Gate 2 stack
    trade_signal:       str          # 'CALLS', 'PUTS', 'WAIT'
    signal_reason:      str


# ──────────────────────────────────────────────────────────────────────────────
# Indicator helpers
# ──────────────────────────────────────────────────────────────────────────────

def calc_ema(series: pd.Series, span: int) -> pd.Series:
    """Exponential moving average."""
    return series.ewm(span=span, adjust=False).mean()


def calc_vwap(df: pd.DataFrame) -> pd.Series:
    """
    Session VWAP anchored to the first bar of each trading day.
    Requires columns: Close, Volume, High, Low.
    """
    typical = (df["High"] + df["Low"] + df["Close"]) / 3
    tpv = typical * df["Volume"]

    # Group by date so VWAP resets each session
    dates = df.index.normalize()
    cum_tpv = tpv.groupby(dates).cumsum()
    cum_vol = df["Volume"].groupby(dates).cumsum()
    return cum_tpv / cum_vol


# ──────────────────────────────────────────────────────────────────────────────
# Data fetch
# ──────────────────────────────────────────────────────────────────────────────

def fetch_intraday(ticker: str, period: str = "5d", interval: str = "5m") -> pd.DataFrame:
    """
    Download 5-minute bars for *ticker* via yfinance.
    Returns a clean DataFrame with timezone-aware index (US/Eastern).
    """
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        raw = yf.download(
            ticker,
            period=period,
            interval=interval,
            auto_adjust=True,
            progress=False,
        )

    if raw.empty:
        raise ValueError(f"No data returned for {ticker}")

    # Flatten multi-level columns if present
    if isinstance(raw.columns, pd.MultiIndex):
        raw.columns = raw.columns.get_level_values(0)

    df = raw[["Open", "High", "Low", "Close", "Volume"]].copy()
    df.dropna(inplace=True)

    # Ensure Eastern tz
    if df.index.tz is None:
        df.index = df.index.tz_localize("America/New_York")
    else:
        df.index = df.index.tz_convert("America/New_York")

    return df


# ──────────────────────────────────────────────────────────────────────────────
# LE Model rule engines
# ──────────────────────────────────────────────────────────────────────────────

def gate2_stack(close: float, ema9: float, vwap: float) -> str:
    """
    Gate 2 Protocol.
      Bullish : Price > EMA9 > VWAP
      Bearish : VWAP > EMA9 > Price
      Neutral : anything else
    """
    if close > ema9 > vwap:
        return "BULLISH"
    if vwap > ema9 > close:
        return "BEARISH"
    return "NEUTRAL"


def detect_physical_kiss(
    close: float,
    prev_close: float,
    ema9: float,
    prev_ema9: float,
) -> bool:
    """
    Physical Kiss — price crossed through or touched the 9 EMA this bar.
    Detected when the bar straddles the EMA (one side on each close).
    """
    above_now  = close     >= ema9
    above_prev = prev_close >= prev_ema9
    return above_now != above_prev  # sign flip → price crossed EMA


def rubber_band_ok(close: float, ema9: float, ticker: str) -> bool:
    """Returns True if the price-to-EMA distance is NOT overextended."""
    threshold = RUBBER_BAND_THRESHOLD.get(ticker, 0.50)
    return abs(close - ema9) < threshold


def in_macro_window(ts: pd.Timestamp) -> bool:
    """True if the bar falls within the 10 AM macro-candle danger zone."""
    t = ts.time()
    return MACRO_CANDLE_START <= t <= MACRO_CANDLE_END


def kill_switch_triggered(
    close: float,
    ema9: float,
    stack: str,
) -> bool:
    """
    Hard Kill Switch.
    - Holding Puts (bearish bias)  → kill if candle closes ABOVE 9 EMA.
    - Holding Calls (bullish bias) → kill if candle closes BELOW 9 EMA.
    """
    if stack == "BEARISH" and close > ema9:
        return True
    if stack == "BULLISH" and close < ema9:
        return True
    return False


# ──────────────────────────────────────────────────────────────────────────────
# Per-ticker analysis
# ──────────────────────────────────────────────────────────────────────────────

def analyze_ticker(ticker: str, df: pd.DataFrame) -> TrendReport:
    """
    Run all LE Model rules on a 5-min bar DataFrame and return a TrendReport.
    """
    df = df.copy()
    df["ema9"] = calc_ema(df["Close"], 9)
    df["vwap"] = calc_vwap(df)

    bars: list[BarSignals] = []

    for i in range(1, len(df)):
        row      = df.iloc[i]
        prev_row = df.iloc[i - 1]

        ts    = df.index[i]
        close = float(row["Close"])
        ema9  = float(row["ema9"])
        vwap  = float(row["vwap"])

        stack = gate2_stack(close, ema9, vwap)

        kiss = detect_physical_kiss(
            close, float(prev_row["Close"]),
            ema9,  float(prev_row["ema9"]),
        )

        band_ok   = rubber_band_ok(close, ema9, ticker)
        macro_win = in_macro_window(ts)
        kill      = kill_switch_triggered(close, ema9, stack)

        bars.append(BarSignals(
            timestamp       = ts,
            close           = close,
            ema9            = ema9,
            vwap            = vwap,
            gate2_stack     = stack,
            physical_kiss   = kiss,
            rubber_band_ok  = band_ok,
            in_macro_window = macro_win,
            kill_switch     = kill,
        ))

    latest = bars[-1]

    # Physical kiss seen in the most recent session
    today = latest.timestamp.normalize()
    today_bars = [b for b in bars if b.timestamp.normalize() == today]
    kiss_today = any(b.physical_kiss for b in today_bars)

    return TrendReport(
        ticker             = ticker,
        current_price      = latest.close,
        ema9               = latest.ema9,
        vwap               = latest.vwap,
        gate2_stack        = latest.gate2_stack,
        physical_kiss_seen = kiss_today,
        rubber_band_ok     = latest.rubber_band_ok,
        kill_switch_active = latest.kill_switch,
        bars               = bars,
    )


# ──────────────────────────────────────────────────────────────────────────────
# Correlation engine
# ──────────────────────────────────────────────────────────────────────────────

def compute_price_correlation(spy_df: pd.DataFrame, nvda_df: pd.DataFrame) -> float:
    """
    Pearson correlation of 5-min returns between SPY and NVDA
    over the overlapping time range.
    """
    spy_ret  = spy_df["Close"].pct_change().dropna()
    nvda_ret = nvda_df["Close"].pct_change().dropna()

    # Align on common timestamps
    aligned = pd.concat([spy_ret, nvda_ret], axis=1, join="inner").dropna()
    aligned.columns = ["SPY", "NVDA"]

    if len(aligned) < 5:
        return float("nan")

    return float(aligned["SPY"].corr(aligned["NVDA"]))


def build_correlation_report(
    spy_report:  TrendReport,
    nvda_report: TrendReport,
    price_corr:  float,
) -> CorrelationReport:
    """
    Synthesize the two LE Model reports into a trade signal.

    Trade logic:
      - Both must share the same Gate 2 stack (no NEUTRAL)
      - Kill switch must be inactive on both
      - Rubber band must be OK on both
      - Physical kiss must have been seen today (at least one ticker)
    """
    spy_stack  = spy_report.gate2_stack
    nvda_stack = nvda_report.gate2_stack

    trend_match = (
        spy_stack == nvda_stack
        and spy_stack in ("BULLISH", "BEARISH")
    )

    reasons: list[str] = []

    if not trend_match:
        signal = "WAIT"
        reasons.append(
            f"Gate 2 mismatch — SPY={spy_stack}, NVDA={nvda_stack}. "
            "Wait for both tickers to align."
        )
    elif spy_report.kill_switch_active or nvda_report.kill_switch_active:
        signal = "WAIT"
        reasons.append(
            "Kill switch active — candle closed on wrong side of 9 EMA. Eject / stand aside."
        )
    elif not spy_report.rubber_band_ok or not nvda_report.rubber_band_ok:
        signal = "WAIT"
        ticker_str = ", ".join(
            t for t, r in [("SPY", spy_report), ("NVDA", nvda_report)]
            if not r.rubber_band_ok
        )
        reasons.append(
            f"Rubber band overextended on {ticker_str}. "
            "Wait for pullback to 9 EMA before entry."
        )
    elif not (spy_report.physical_kiss_seen or nvda_report.physical_kiss_seen):
        signal = "WAIT"
        reasons.append(
            "No physical kiss observed today. "
            "Price has not re-tested the 9 EMA — entry is premature."
        )
    else:
        signal = "CALLS" if spy_stack == "BULLISH" else "PUTS"
        reasons.append(
            f"Gate 2 confirmed {spy_stack} on both SPY & NVDA. "
            f"Physical kiss detected. Rubber band within limits. "
            f"5-min return correlation: {price_corr:.2%}."
        )

    return CorrelationReport(
        spy          = spy_report,
        nvda         = nvda_report,
        trend_match  = trend_match,
        trade_signal = signal,
        signal_reason= " | ".join(reasons),
    )


# ──────────────────────────────────────────────────────────────────────────────
# Public entry point
# ──────────────────────────────────────────────────────────────────────────────

def run_analysis(period: str = "5d", interval: str = "5m") -> CorrelationReport:
    """Download data, run LE Model, return a CorrelationReport."""
    spy_df  = fetch_intraday("SPY",  period=period, interval=interval)
    nvda_df = fetch_intraday("NVDA", period=period, interval=interval)

    spy_report  = analyze_ticker("SPY",  spy_df)
    nvda_report = analyze_ticker("NVDA", nvda_df)
    price_corr  = compute_price_correlation(spy_df, nvda_df)

    return build_correlation_report(spy_report, nvda_report, price_corr)


def print_report(report: CorrelationReport) -> None:
    """Pretty-print the correlation report to stdout."""
    div = "=" * 60
    print(div)
    print(" SPY / NVDA TREND ANALYSIS — LE MODEL")
    print(div)

    for tr in (report.spy, report.nvda):
        print(f"\n  [{tr.ticker}]")
        print(f"    Price : ${tr.current_price:.2f}")
        print(f"    9 EMA : ${tr.ema9:.2f}")
        print(f"    VWAP  : ${tr.vwap:.2f}")
        print(f"    Stack : {tr.gate2_stack}")
        print(f"    Kiss  : {'YES' if tr.physical_kiss_seen else 'NO'}")
        print(f"    Band  : {'OK' if tr.rubber_band_ok else 'STRETCHED'}")
        print(f"    Kill  : {'ACTIVE' if tr.kill_switch_active else 'CLEAR'}")

    print(f"\n  Trend Match : {'YES' if report.trend_match else 'NO'}")
    print(f"  Signal      : *** {report.trade_signal} ***")
    print(f"  Reason      : {report.signal_reason}")
    print(div)


if __name__ == "__main__":
    report = run_analysis()
    print_report(report)
