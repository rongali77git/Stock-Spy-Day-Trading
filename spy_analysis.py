"""
SPY Day-Trading Analyzer — LE Model Framework

Fetches 5-minute SPY bars, calculates 9 EMA and session VWAP,
then applies all six LE Model rules to produce a CALLS / PUTS / WAIT signal.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from datetime import time

import pandas as pd
import yfinance as yf

# ── Configuration ────────────────────────────────────────────────────────────

RUBBER_BAND_THRESHOLD = 0.25   # max acceptable distance between price and 9 EMA
MACRO_CANDLE_START    = time(9, 55)
MACRO_CANDLE_END      = time(10, 5)


# ── Data structures ──────────────────────────────────────────────────────────

@dataclass
class BarSignals:
    timestamp:       pd.Timestamp
    close:           float
    ema9:            float
    vwap:            float
    gate2_stack:     str    # 'BULLISH' | 'BEARISH' | 'NEUTRAL'
    physical_kiss:   bool
    rubber_band_ok:  bool
    in_macro_window: bool
    kill_switch:     bool


@dataclass
class SPYReport:
    current_price:      float
    ema9:               float
    vwap:               float
    gate2_stack:        str
    physical_kiss_seen: bool   # at least one kiss in today's session
    rubber_band_ok:     bool
    kill_switch_active: bool
    trade_signal:       str    # 'CALLS' | 'PUTS' | 'WAIT'
    signal_reason:      str
    bars:               list[BarSignals] = field(default_factory=list)


# ── Indicators ───────────────────────────────────────────────────────────────

def calc_ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()


def calc_vwap(df: pd.DataFrame) -> pd.Series:
    """Session VWAP anchored to the first bar of each trading day."""
    typical = (df["High"] + df["Low"] + df["Close"]) / 3
    tpv     = typical * df["Volume"]
    dates   = df.index.normalize()
    return tpv.groupby(dates).cumsum() / df["Volume"].groupby(dates).cumsum()


# ── LE Model rules ────────────────────────────────────────────────────────────

def gate2_stack(close: float, ema9: float, vwap: float) -> str:
    if close > ema9 > vwap:
        return "BULLISH"
    if vwap > ema9 > close:
        return "BEARISH"
    return "NEUTRAL"


def detect_physical_kiss(
    close: float, prev_close: float,
    ema9: float,  prev_ema9: float,
) -> bool:
    """True when price crosses through the 9 EMA (sign flip between bars)."""
    return (close >= ema9) != (prev_close >= prev_ema9)


def rubber_band_ok(close: float, ema9: float) -> bool:
    return abs(close - ema9) < RUBBER_BAND_THRESHOLD


def in_macro_window(ts: pd.Timestamp) -> bool:
    t = ts.time()
    return MACRO_CANDLE_START <= t <= MACRO_CANDLE_END


def kill_switch_triggered(close: float, ema9: float, stack: str) -> bool:
    if stack == "BEARISH" and close > ema9:
        return True
    if stack == "BULLISH" and close < ema9:
        return True
    return False


# ── Data fetch ────────────────────────────────────────────────────────────────

MARKET_OPEN  = time(9, 30)
MARKET_CLOSE = time(16, 0)

def fetch_spy(period: str = "5d", interval: str = "5m") -> pd.DataFrame:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        raw = yf.download(
            "SPY", period=period, interval=interval,
            auto_adjust=True, progress=False,
        )

    if raw.empty:
        raise ValueError("No SPY data returned")

    if isinstance(raw.columns, pd.MultiIndex):
        raw.columns = raw.columns.get_level_values(0)

    df = raw[["Open", "High", "Low", "Close", "Volume"]].dropna()

    if df.index.tz is None:
        df.index = df.index.tz_localize("America/New_York")
    else:
        df.index = df.index.tz_convert("America/New_York")

    # Strip pre-market and after-hours — VWAP must anchor to 9:30 AM open
    df = df[df.index.time >= MARKET_OPEN]
    df = df[df.index.time <= MARKET_CLOSE]

    return df


# ── Analysis ──────────────────────────────────────────────────────────────────

def analyze(df: pd.DataFrame) -> SPYReport:
    df = df.copy()
    df["ema9"] = calc_ema(df["Close"], 9)
    df["vwap"] = calc_vwap(df)

    bars: list[BarSignals] = []

    for i in range(1, len(df)):
        row, prev = df.iloc[i], df.iloc[i - 1]
        ts    = df.index[i]
        close = float(row["Close"])
        ema9  = float(row["ema9"])
        vwap  = float(row["vwap"])
        stack = gate2_stack(close, ema9, vwap)

        bars.append(BarSignals(
            timestamp       = ts,
            close           = close,
            ema9            = ema9,
            vwap            = vwap,
            gate2_stack     = stack,
            physical_kiss   = detect_physical_kiss(
                close, float(prev["Close"]),
                ema9,  float(prev["ema9"]),
            ),
            rubber_band_ok  = rubber_band_ok(close, ema9),
            in_macro_window = in_macro_window(ts),
            kill_switch     = kill_switch_triggered(close, ema9, stack),
        ))

    latest = bars[-1]
    today  = latest.timestamp.normalize()
    today_bars = [b for b in bars if b.timestamp.normalize() == today]

    stack      = latest.gate2_stack
    kiss_today = any(b.physical_kiss for b in today_bars)
    band_ok    = latest.rubber_band_ok
    kill       = latest.kill_switch

    # Signal logic
    if stack == "NEUTRAL":
        signal = "WAIT"
        reason = "Gate 2 not confirmed — EMA9 and VWAP have not cleanly crossed. Weapon safed."
    elif kill:
        signal = "WAIT"
        reason = "Kill switch active — last candle closed on wrong side of 9 EMA. Eject immediately."
    elif not band_ok:
        gap = abs(latest.close - latest.ema9)
        signal = "WAIT"
        reason = f"Rubber band stretched (${gap:.2f} from 9 EMA, limit ${RUBBER_BAND_THRESHOLD}). Wait for pullback to EMA."
    elif not kiss_today:
        signal = "WAIT"
        reason = "No physical kiss today — price has not re-tested the 9 EMA. Entry is premature."
    else:
        signal = "CALLS" if stack == "BULLISH" else "PUTS"
        reason = (
            f"Gate 2 {stack} confirmed. Physical kiss observed. "
            f"Rubber band within ${RUBBER_BAND_THRESHOLD} limit. "
            f"Price ${latest.close:.2f} | 9 EMA ${latest.ema9:.2f} | VWAP ${latest.vwap:.2f}."
        )

    return SPYReport(
        current_price      = latest.close,
        ema9               = latest.ema9,
        vwap               = latest.vwap,
        gate2_stack        = stack,
        physical_kiss_seen = kiss_today,
        rubber_band_ok     = band_ok,
        kill_switch_active = kill,
        trade_signal       = signal,
        signal_reason      = reason,
        bars               = bars,
    )


def run() -> SPYReport:
    return analyze(fetch_spy())


def print_report(r: SPYReport) -> None:
    div = "=" * 55
    print(div)
    print(" SPY ANALYSIS — LE MODEL")
    print(div)
    print(f"  Price : ${r.current_price:.2f}")
    print(f"  9 EMA : ${r.ema9:.2f}")
    print(f"  VWAP  : ${r.vwap:.2f}")
    print(f"  Stack : {r.gate2_stack}")
    print(f"  Kiss  : {'YES' if r.physical_kiss_seen else 'NO'}")
    print(f"  Band  : {'OK' if r.rubber_band_ok else 'STRETCHED'}")
    print(f"  Kill  : {'ACTIVE' if r.kill_switch_active else 'CLEAR'}")
    print(f"\n  Signal : *** {r.trade_signal} ***")
    print(f"  Reason : {r.signal_reason}")
    print(div)


if __name__ == "__main__":
    print_report(run())
