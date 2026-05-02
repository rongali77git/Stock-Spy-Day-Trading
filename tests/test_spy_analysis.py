"""
Unit tests for spy_analysis.py — all run without network access.
"""

from __future__ import annotations

import sys
import os

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from spy_analysis import (
    BarSignals,
    SPYReport,
    calc_ema,
    calc_vwap,
    gate2_stack,
    detect_physical_kiss,
    rubber_band_ok,
    in_macro_window,
    kill_switch_triggered,
    analyze,
    RUBBER_BAND_THRESHOLD,
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def make_ohlcv(closes: list[float], base_ts: pd.Timestamp | None = None) -> pd.DataFrame:
    if base_ts is None:
        base_ts = pd.Timestamp("2026-05-01 09:30:00", tz="America/New_York")
    idx = pd.date_range(start=base_ts, periods=len(closes), freq="5min")
    spread = 0.05
    return pd.DataFrame({
        "Open":   [c - spread for c in closes],
        "High":   [c + spread for c in closes],
        "Low":    [c - spread for c in closes],
        "Close":  closes,
        "Volume": [500_000] * len(closes),
    }, index=idx)


# ── calc_ema ──────────────────────────────────────────────────────────────────

class TestCalcEMA:
    def test_length_preserved(self):
        s = pd.Series(range(1, 21), dtype=float)
        assert len(calc_ema(s, 9)) == len(s)

    def test_converges_on_constant(self):
        s = pd.Series([720.0] * 50)
        assert abs(calc_ema(s, 9).iloc[-1] - 720.0) < 0.001

    def test_rising_series_ema_lags_price(self):
        s = pd.Series(range(700, 730), dtype=float)
        ema = calc_ema(s, 9)
        assert ema.iloc[-1] < s.iloc[-1]


# ── calc_vwap ─────────────────────────────────────────────────────────────────

class TestCalcVWAP:
    def test_single_bar_near_close(self):
        df = make_ohlcv([720.0])
        vwap = calc_vwap(df)
        assert abs(vwap.iloc[0] - 720.0) < 0.10

    def test_resets_each_session(self):
        ts1 = pd.Timestamp("2026-04-30 09:30:00", tz="America/New_York")
        ts2 = pd.Timestamp("2026-05-01 09:30:00", tz="America/New_York")
        idx = pd.DatetimeIndex([
            ts1, ts1 + pd.Timedelta(minutes=5),
            ts2, ts2 + pd.Timedelta(minutes=5),
        ])
        df = pd.DataFrame({
            "Open":  [710, 711, 720, 721],
            "High":  [711, 712, 721, 722],
            "Low":   [709, 710, 719, 720],
            "Close": [710, 711, 720, 721],
            "Volume": [1000, 1000, 1000, 1000],
        }, index=idx)
        vwap = calc_vwap(df)
        # Day-2 first bar VWAP should be near 720, not blended with day-1 ~710
        assert abs(vwap.iloc[2] - 720.0) < 0.5

    def test_volume_weighted(self):
        ts = pd.Timestamp("2026-05-01 09:30:00", tz="America/New_York")
        idx = pd.DatetimeIndex([ts, ts + pd.Timedelta(minutes=5)])
        # Bar1: typical=710, vol=1000 | Bar2: typical=730, vol=3000 → VWAP = (710000+2190000)/4000 = 725
        df = pd.DataFrame({
            "Open":  [710, 730], "High": [710, 730],
            "Low":   [710, 730], "Close": [710, 730],
            "Volume": [1000, 3000],
        }, index=idx)
        vwap = calc_vwap(df)
        assert abs(vwap.iloc[1] - 725.0) < 0.01


# ── gate2_stack ───────────────────────────────────────────────────────────────

class TestGate2Stack:
    def test_bullish(self):
        # Price > EMA9 > VWAP
        assert gate2_stack(close=721.00, ema9=720.50, vwap=720.00) == "BULLISH"

    def test_bearish(self):
        # VWAP > EMA9 > Price
        assert gate2_stack(close=719.50, ema9=720.00, vwap=720.50) == "BEARISH"

    def test_neutral_price_between_ema_and_vwap(self):
        # EMA > Price > VWAP — not a clean stack
        assert gate2_stack(close=720.25, ema9=720.50, vwap=720.00) == "NEUTRAL"

    def test_neutral_when_ema_equals_vwap(self):
        assert gate2_stack(close=720.00, ema9=720.50, vwap=720.50) == "NEUTRAL"

    def test_screenshot_state(self):
        # Actual screenshot values: Price=720.00, EMA9=720.11, VWAP=720.39
        # VWAP(720.39) > EMA9(720.11) > Price(720.00) → BEARISH
        assert gate2_stack(close=720.00, ema9=720.11, vwap=720.39) == "BEARISH"


# ── detect_physical_kiss ──────────────────────────────────────────────────────

class TestPhysicalKiss:
    def test_crosses_from_above(self):
        assert detect_physical_kiss(
            close=719.50, prev_close=720.50,
            ema9=720.00,  prev_ema9=720.00,
        ) is True

    def test_crosses_from_below(self):
        assert detect_physical_kiss(
            close=720.50, prev_close=719.50,
            ema9=720.00,  prev_ema9=720.00,
        ) is True

    def test_stays_above_no_kiss(self):
        assert detect_physical_kiss(
            close=721.00, prev_close=720.50,
            ema9=720.00,  prev_ema9=720.00,
        ) is False

    def test_stays_below_no_kiss(self):
        assert detect_physical_kiss(
            close=719.00, prev_close=719.50,
            ema9=720.00,  prev_ema9=720.00,
        ) is False


# ── rubber_band_ok ────────────────────────────────────────────────────────────

class TestRubberBand:
    def test_within_threshold(self):
        assert rubber_band_ok(close=720.20, ema9=720.00) is True

    def test_at_threshold_is_not_ok(self):
        # strict < so exactly at threshold fails
        assert rubber_band_ok(close=720.00 + RUBBER_BAND_THRESHOLD, ema9=720.00) is False

    def test_overextended(self):
        assert rubber_band_ok(close=721.00, ema9=720.00) is False

    def test_below_threshold(self):
        assert rubber_band_ok(close=719.50, ema9=720.00) is False

    def test_screenshot_state(self):
        # SPY screenshot: |720.00 - 720.11| = 0.11 < 0.25 → OK
        assert rubber_band_ok(close=720.00, ema9=720.11) is True


# ── in_macro_window ───────────────────────────────────────────────────────────

class TestMacroWindow:
    def _ts(self, h: int, m: int) -> pd.Timestamp:
        return pd.Timestamp(f"2026-05-01 {h:02d}:{m:02d}:00", tz="America/New_York")

    def test_exactly_1000(self):
        assert in_macro_window(self._ts(10, 0)) is True

    def test_exactly_1005(self):
        assert in_macro_window(self._ts(10, 5)) is True

    def test_0957(self):
        assert in_macro_window(self._ts(9, 57)) is True

    def test_before_window(self):
        assert in_macro_window(self._ts(9, 30)) is False

    def test_after_window(self):
        assert in_macro_window(self._ts(10, 30)) is False


# ── kill_switch_triggered ─────────────────────────────────────────────────────

class TestKillSwitch:
    def test_bearish_bias_killed_when_price_above_ema(self):
        assert kill_switch_triggered(close=720.20, ema9=720.00, stack="BEARISH") is True

    def test_bearish_bias_safe_when_price_below_ema(self):
        assert kill_switch_triggered(close=719.80, ema9=720.00, stack="BEARISH") is False

    def test_bullish_bias_killed_when_price_below_ema(self):
        assert kill_switch_triggered(close=719.80, ema9=720.00, stack="BULLISH") is True

    def test_bullish_bias_safe_when_price_above_ema(self):
        assert kill_switch_triggered(close=720.20, ema9=720.00, stack="BULLISH") is False

    def test_neutral_never_triggers(self):
        assert kill_switch_triggered(close=720.20, ema9=720.00, stack="NEUTRAL") is False
        assert kill_switch_triggered(close=719.80, ema9=720.00, stack="NEUTRAL") is False


# ── analyze (integration) ─────────────────────────────────────────────────────

class TestAnalyze:
    def _bearish_df(self) -> pd.DataFrame:
        # Steadily falling: VWAP > EMA > Price
        closes = [725.0 - i * 0.3 for i in range(30)]
        return make_ohlcv(closes)

    def _bullish_df(self) -> pd.DataFrame:
        closes = [715.0 + i * 0.3 for i in range(30)]
        return make_ohlcv(closes)

    def test_returns_spy_report(self):
        assert isinstance(analyze(self._bearish_df()), SPYReport)

    def test_bearish_stack_detected(self):
        assert analyze(self._bearish_df()).gate2_stack == "BEARISH"

    def test_bullish_stack_detected(self):
        assert analyze(self._bullish_df()).gate2_stack == "BULLISH"

    def test_current_price_matches_last_close(self):
        df = self._bullish_df()
        report = analyze(df)
        assert abs(report.current_price - float(df["Close"].iloc[-1])) < 0.001

    def test_bars_count(self):
        df = self._bearish_df()
        assert len(analyze(df).bars) == len(df) - 1

    def test_neutral_issues_wait(self):
        # Flat price — EMA ≈ VWAP ≈ Price → NEUTRAL
        closes = [720.0] * 30
        report = analyze(make_ohlcv(closes))
        assert report.trade_signal == "WAIT"

    def test_stretched_rubber_band_issues_wait(self):
        # Start high, drop hard so |price - EMA| >> threshold
        closes = [730.0] * 10 + [720.0] * 20
        report = analyze(make_ohlcv(closes))
        # EMA will still be above 720 → band stretched
        if not report.rubber_band_ok:
            assert report.trade_signal == "WAIT"

    # ── Screenshot state ──────────────────────────────────────────────────────
    # SPY chart: Price=720.00, EMA9=720.11, VWAP=720.39 → BEARISH, band OK

    def test_screenshot_gate2_bearish(self):
        assert gate2_stack(close=720.00, ema9=720.11, vwap=720.39) == "BEARISH"

    def test_screenshot_rubber_band_ok(self):
        # |720.00 - 720.11| = 0.11 < 0.25
        assert rubber_band_ok(close=720.00, ema9=720.11) is True

    def test_screenshot_kill_switch_clear(self):
        # Price(720.00) < EMA9(720.11) while BEARISH → price IS below EMA → kill switch NOT triggered
        assert kill_switch_triggered(close=720.00, ema9=720.11, stack="BEARISH") is False
