"""
Unit and integration tests for spy_nvda_trend_analysis.py

Tests are designed to run without network access by constructing
synthetic DataFrames that replicate real chart conditions.
"""

from __future__ import annotations

import sys
import os
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import pytest

# ── path setup ──────────────────────────────────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from spy_nvda_trend_analysis import (
    BarSignals,
    TrendReport,
    CorrelationReport,
    calc_ema,
    calc_vwap,
    gate2_stack,
    detect_physical_kiss,
    rubber_band_ok,
    in_macro_window,
    kill_switch_triggered,
    analyze_ticker,
    compute_price_correlation,
    build_correlation_report,
)

ET = ZoneInfo("America/New_York")


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def make_ohlcv(
    closes: list[float],
    base_ts: pd.Timestamp | None = None,
    freq: str = "5min",
    ticker: str = "TEST",
) -> pd.DataFrame:
    """Build a minimal OHLCV DataFrame from a list of close prices."""
    if base_ts is None:
        base_ts = pd.Timestamp("2026-05-01 09:30:00", tz="America/New_York")

    idx = pd.date_range(start=base_ts, periods=len(closes), freq=freq)
    spread = 0.05
    data = {
        "Open":   [c - spread for c in closes],
        "High":   [c + spread for c in closes],
        "Low":    [c - spread for c in closes],
        "Close":  closes,
        "Volume": [100_000] * len(closes),
    }
    return pd.DataFrame(data, index=idx)


# ──────────────────────────────────────────────────────────────────────────────
# calc_ema
# ──────────────────────────────────────────────────────────────────────────────

class TestCalcEMA:
    def test_length_preserved(self):
        s = pd.Series(range(1, 21), dtype=float)
        result = calc_ema(s, 9)
        assert len(result) == len(s)

    def test_converges_on_constant(self):
        s = pd.Series([100.0] * 50)
        result = calc_ema(s, 9)
        assert abs(result.iloc[-1] - 100.0) < 0.001

    def test_rising_series_ema_lags(self):
        s = pd.Series(range(1, 30), dtype=float)
        result = calc_ema(s, 9)
        # EMA lags on the way up — last EMA < last price
        assert result.iloc[-1] < s.iloc[-1]


# ──────────────────────────────────────────────────────────────────────────────
# calc_vwap
# ──────────────────────────────────────────────────────────────────────────────

class TestCalcVWAP:
    def test_single_bar(self):
        df = make_ohlcv([100.0])
        vwap = calc_vwap(df)
        assert abs(vwap.iloc[0] - 100.0) < 0.10  # typical ≈ close for tight spread

    def test_resets_each_session(self):
        # Two sessions: 2 bars each
        ts1 = pd.Timestamp("2026-04-30 09:30:00", tz="America/New_York")
        ts2 = pd.Timestamp("2026-05-01 09:30:00", tz="America/New_York")
        idx = pd.DatetimeIndex([
            ts1,
            ts1 + pd.Timedelta(minutes=5),
            ts2,
            ts2 + pd.Timedelta(minutes=5),
        ])
        df = pd.DataFrame({
            "Open":  [100, 101, 200, 201],
            "High":  [101, 102, 201, 202],
            "Low":   [99,  100, 199, 200],
            "Close": [100, 101, 200, 201],
            "Volume":[1000, 1000, 1000, 1000],
        }, index=idx)
        vwap = calc_vwap(df)
        # VWAP on day-2 first bar ≈ 200
        assert abs(vwap.iloc[2] - 200.0) < 0.5
        # VWAP day-2 should NOT be influenced by day-1 prices
        assert vwap.iloc[2] < 150  # day-2 vwap should be near 200, not blended with 100s

    def test_volume_weighted(self):
        ts = pd.Timestamp("2026-05-01 09:30:00", tz="America/New_York")
        idx = pd.DatetimeIndex([ts, ts + pd.Timedelta(minutes=5)])
        # Bar 1: typical=100, vol=1000  → cumTPV=100000, cumVol=1000
        # Bar 2: typical=200, vol=3000  → cumTPV=700000, cumVol=4000 → VWAP=175
        df = pd.DataFrame({
            "Open":  [100, 200],
            "High":  [100, 200],
            "Low":   [100, 200],
            "Close": [100, 200],
            "Volume":[1000, 3000],
        }, index=idx)
        vwap = calc_vwap(df)
        assert abs(vwap.iloc[1] - 175.0) < 0.01


# ──────────────────────────────────────────────────────────────────────────────
# gate2_stack
# ──────────────────────────────────────────────────────────────────────────────

class TestGate2Stack:
    def test_bullish(self):
        # Price > EMA9 > VWAP
        assert gate2_stack(close=720.30, ema9=720.11, vwap=720.00) == "BULLISH"

    def test_bearish(self):
        # VWAP > EMA9 > Price  (matches NVDA chart: VWAP=200.65 > EMA=200.29 > Price=198.12)
        assert gate2_stack(close=198.12, ema9=200.29, vwap=200.65) == "BEARISH"

    def test_neutral_price_between(self):
        # EMA9 > Price > VWAP — not a clean stack
        assert gate2_stack(close=100.50, ema9=101.00, vwap=100.00) == "NEUTRAL"

    def test_neutral_vwap_equals_ema(self):
        assert gate2_stack(close=100.0, ema9=100.5, vwap=100.5) == "NEUTRAL"

    def test_spy_chart_state(self):
        # SPY screenshot: Price=720.00, EMA9=720.11, VWAP=720.39
        # VWAP(720.39) > EMA9(720.11) > Price(720.00) → BEARISH
        assert gate2_stack(close=720.00, ema9=720.11, vwap=720.39) == "BEARISH"


# ──────────────────────────────────────────────────────────────────────────────
# detect_physical_kiss
# ──────────────────────────────────────────────────────────────────────────────

class TestPhysicalKiss:
    def test_price_crosses_ema_from_above(self):
        # prev close above prev EMA; current close below current EMA
        assert detect_physical_kiss(
            close=199.0, prev_close=201.0,
            ema9=200.0,  prev_ema9=200.0,
        ) is True

    def test_price_crosses_ema_from_below(self):
        assert detect_physical_kiss(
            close=201.0, prev_close=199.0,
            ema9=200.0,  prev_ema9=200.0,
        ) is True

    def test_price_stays_above(self):
        assert detect_physical_kiss(
            close=202.0, prev_close=201.0,
            ema9=200.0,  prev_ema9=200.0,
        ) is False

    def test_price_stays_below(self):
        assert detect_physical_kiss(
            close=198.0, prev_close=199.0,
            ema9=200.0,  prev_ema9=200.0,
        ) is False


# ──────────────────────────────────────────────────────────────────────────────
# rubber_band_ok
# ──────────────────────────────────────────────────────────────────────────────

class TestRubberBand:
    def test_nvda_within_threshold(self):
        assert rubber_band_ok(close=200.30, ema9=200.00, ticker="NVDA") is True

    def test_nvda_at_threshold_boundary(self):
        # Exactly at threshold (0.50) → not overextended (strict <)
        assert rubber_band_ok(close=200.50, ema9=200.00, ticker="NVDA") is False

    def test_nvda_overextended(self):
        assert rubber_band_ok(close=201.00, ema9=200.00, ticker="NVDA") is False

    def test_spy_within_threshold(self):
        assert rubber_band_ok(close=720.20, ema9=720.00, ticker="SPY") is True

    def test_spy_overextended(self):
        assert rubber_band_ok(close=720.50, ema9=720.00, ticker="SPY") is False

    def test_unknown_ticker_defaults_to_nvda_threshold(self):
        assert rubber_band_ok(close=100.30, ema9=100.00, ticker="AAPL") is True
        assert rubber_band_ok(close=100.60, ema9=100.00, ticker="AAPL") is False


# ──────────────────────────────────────────────────────────────────────────────
# in_macro_window
# ──────────────────────────────────────────────────────────────────────────────

class TestMacroWindow:
    def _ts(self, h: int, m: int) -> pd.Timestamp:
        return pd.Timestamp(f"2026-05-01 {h:02d}:{m:02d}:00", tz="America/New_York")

    def test_inside_window_exactly_1000(self):
        assert in_macro_window(self._ts(10, 0)) is True

    def test_inside_window_exactly_1005(self):
        assert in_macro_window(self._ts(10, 5)) is True

    def test_inside_window_0957(self):
        assert in_macro_window(self._ts(9, 57)) is True

    def test_before_window(self):
        assert in_macro_window(self._ts(9, 30)) is False

    def test_after_window(self):
        assert in_macro_window(self._ts(10, 30)) is False


# ──────────────────────────────────────────────────────────────────────────────
# kill_switch_triggered
# ──────────────────────────────────────────────────────────────────────────────

class TestKillSwitch:
    def test_puts_killed_when_price_above_ema(self):
        # Holding Puts (BEARISH bias) but price closed above EMA → eject
        assert kill_switch_triggered(close=200.50, ema9=200.00, stack="BEARISH") is True

    def test_puts_safe_when_price_below_ema(self):
        assert kill_switch_triggered(close=199.50, ema9=200.00, stack="BEARISH") is False

    def test_calls_killed_when_price_below_ema(self):
        # Holding Calls (BULLISH bias) but price closed below EMA → eject
        assert kill_switch_triggered(close=199.50, ema9=200.00, stack="BULLISH") is True

    def test_calls_safe_when_price_above_ema(self):
        assert kill_switch_triggered(close=200.50, ema9=200.00, stack="BULLISH") is False

    def test_neutral_stack_never_triggers(self):
        # No bias → kill switch not applicable
        assert kill_switch_triggered(close=200.50, ema9=200.00, stack="NEUTRAL") is False
        assert kill_switch_triggered(close=199.50, ema9=200.00, stack="NEUTRAL") is False


# ──────────────────────────────────────────────────────────────────────────────
# analyze_ticker
# ──────────────────────────────────────────────────────────────────────────────

class TestAnalyzeTicker:
    def _bearish_df(self) -> pd.DataFrame:
        """20 bars drifting downward so VWAP > EMA > Price."""
        closes = [210.0 - i * 0.6 for i in range(20)]
        return make_ohlcv(closes)

    def _bullish_df(self) -> pd.DataFrame:
        """20 bars drifting upward so Price > EMA > VWAP."""
        closes = [200.0 + i * 0.6 for i in range(20)]
        return make_ohlcv(closes)

    def test_returns_trend_report(self):
        report = analyze_ticker("NVDA", self._bearish_df())
        assert isinstance(report, TrendReport)
        assert report.ticker == "NVDA"

    def test_bearish_stack_detected(self):
        report = analyze_ticker("NVDA", self._bearish_df())
        assert report.gate2_stack == "BEARISH"

    def test_bullish_stack_detected(self):
        report = analyze_ticker("NVDA", self._bullish_df())
        assert report.gate2_stack == "BULLISH"

    def test_bars_length(self):
        df = self._bearish_df()
        report = analyze_ticker("NVDA", df)
        # bars = len(df) - 1 (first bar has no previous)
        assert len(report.bars) == len(df) - 1

    def test_current_price_matches_last_close(self):
        df = self._bullish_df()
        report = analyze_ticker("SPY", df)
        assert abs(report.current_price - float(df["Close"].iloc[-1])) < 0.001


# ──────────────────────────────────────────────────────────────────────────────
# compute_price_correlation
# ──────────────────────────────────────────────────────────────────────────────

class TestPriceCorrelation:
    def test_perfect_positive_correlation(self):
        closes = [100.0 + i * 0.1 for i in range(30)]
        spy_df  = make_ohlcv(closes)
        nvda_df = make_ohlcv([c * 2 for c in closes])  # scaled, same direction
        corr = compute_price_correlation(spy_df, nvda_df)
        # Identical return series → correlation == 1.0
        assert abs(corr - 1.0) < 1e-6

    def test_perfect_negative_correlation(self):
        closes = [100.0 + i * 0.1 for i in range(30)]
        spy_df  = make_ohlcv(closes)
        nvda_df = make_ohlcv(list(reversed(closes)))
        corr = compute_price_correlation(spy_df, nvda_df)
        assert corr < -0.8

    def test_returns_nan_for_insufficient_data(self):
        spy_df  = make_ohlcv([100.0, 101.0])
        nvda_df = make_ohlcv([200.0, 201.0])
        corr = compute_price_correlation(spy_df, nvda_df)
        assert np.isnan(corr)


# ──────────────────────────────────────────────────────────────────────────────
# build_correlation_report  (integration)
# ──────────────────────────────────────────────────────────────────────────────

class TestBuildCorrelationReport:
    def _make_report(
        self,
        ticker: str,
        stack: str,
        kiss: bool = True,
        band_ok: bool = True,
        kill: bool = False,
    ) -> TrendReport:
        return TrendReport(
            ticker             = ticker,
            current_price      = 200.0,
            ema9               = 200.0,
            vwap               = 200.5,
            gate2_stack        = stack,
            physical_kiss_seen = kiss,
            rubber_band_ok     = band_ok,
            kill_switch_active = kill,
        )

    def test_both_bearish_matching_issues_puts(self):
        spy  = self._make_report("SPY",  "BEARISH")
        nvda = self._make_report("NVDA", "BEARISH")
        rpt  = build_correlation_report(spy, nvda, price_corr=0.75)
        assert rpt.trade_signal == "PUTS"
        assert rpt.trend_match is True

    def test_both_bullish_matching_issues_calls(self):
        spy  = self._make_report("SPY",  "BULLISH")
        nvda = self._make_report("NVDA", "BULLISH")
        rpt  = build_correlation_report(spy, nvda, price_corr=0.80)
        assert rpt.trade_signal == "CALLS"
        assert rpt.trend_match is True

    def test_mismatch_issues_wait(self):
        spy  = self._make_report("SPY",  "BULLISH")
        nvda = self._make_report("NVDA", "BEARISH")
        rpt  = build_correlation_report(spy, nvda, price_corr=0.10)
        assert rpt.trade_signal == "WAIT"
        assert rpt.trend_match is False

    def test_neutral_issues_wait(self):
        spy  = self._make_report("SPY",  "NEUTRAL")
        nvda = self._make_report("NVDA", "NEUTRAL")
        rpt  = build_correlation_report(spy, nvda, price_corr=0.50)
        assert rpt.trade_signal == "WAIT"

    def test_kill_switch_overrides_signal(self):
        spy  = self._make_report("SPY",  "BEARISH", kill=True)
        nvda = self._make_report("NVDA", "BEARISH")
        rpt  = build_correlation_report(spy, nvda, price_corr=0.70)
        assert rpt.trade_signal == "WAIT"
        assert "Kill switch" in rpt.signal_reason

    def test_rubber_band_overrides_signal(self):
        spy  = self._make_report("SPY",  "BEARISH", band_ok=False)
        nvda = self._make_report("NVDA", "BEARISH")
        rpt  = build_correlation_report(spy, nvda, price_corr=0.65)
        assert rpt.trade_signal == "WAIT"
        assert "Rubber band" in rpt.signal_reason

    def test_no_kiss_issues_wait(self):
        spy  = self._make_report("SPY",  "BEARISH", kiss=False)
        nvda = self._make_report("NVDA", "BEARISH", kiss=False)
        rpt  = build_correlation_report(spy, nvda, price_corr=0.60)
        assert rpt.trade_signal == "WAIT"
        assert "physical kiss" in rpt.signal_reason.lower()

    def test_signal_reason_non_empty(self):
        spy  = self._make_report("SPY",  "BEARISH")
        nvda = self._make_report("NVDA", "BEARISH")
        rpt  = build_correlation_report(spy, nvda, price_corr=0.72)
        assert len(rpt.signal_reason) > 0

    # ── Screenshot state validation ──────────────────────────────────────────
    # Based on the actual screenshots provided:
    #   SPY  : Price=720.00, EMA9=720.11, VWAP=720.39 → BEARISH
    #   NVDA : Price=198.12, EMA9=200.29, VWAP=200.65 → BEARISH
    # Both are bearish-stacked → matching, signal should lean PUTS
    # (kill switch / rubber band / kiss checks may modify final signal)

    def test_screenshot_spy_state_is_bearish(self):
        """Validates Gate 2 for the exact SPY screenshot values."""
        stack = gate2_stack(close=720.00, ema9=720.11, vwap=720.39)
        assert stack == "BEARISH"

    def test_screenshot_nvda_state_is_bearish(self):
        """Validates Gate 2 for the exact NVDA screenshot values."""
        stack = gate2_stack(close=198.12, ema9=200.29, vwap=200.65)
        assert stack == "BEARISH"

    def test_screenshot_nvda_rubber_band_stretched(self):
        """
        NVDA: |Price - EMA9| = |198.12 - 200.29| = 2.17 >> 0.50 threshold.
        Rubber band is stretched — do NOT chase entry.
        """
        assert rubber_band_ok(close=198.12, ema9=200.29, ticker="NVDA") is False

    def test_screenshot_spy_rubber_band_ok(self):
        """
        SPY: |Price - EMA9| = |720.00 - 720.11| = 0.11 < 0.25 threshold.
        Rubber band is fine on SPY side.
        """
        assert rubber_band_ok(close=720.00, ema9=720.11, ticker="SPY") is True

    def test_screenshot_full_signal(self):
        """
        End-to-end signal for the screenshot state:
          - Both BEARISH  → trend matches
          - NVDA rubber band stretched (2.17 > 0.50) → WAIT
        """
        spy  = TrendReport(
            ticker             = "SPY",
            current_price      = 720.00,
            ema9               = 720.11,
            vwap               = 720.39,
            gate2_stack        = "BEARISH",
            physical_kiss_seen = True,
            rubber_band_ok     = True,   # SPY band is fine
            kill_switch_active = False,
        )
        nvda = TrendReport(
            ticker             = "NVDA",
            current_price      = 198.12,
            ema9               = 200.29,
            vwap               = 200.65,
            gate2_stack        = "BEARISH",
            physical_kiss_seen = True,
            rubber_band_ok     = False,  # NVDA stretched
            kill_switch_active = False,
        )
        rpt = build_correlation_report(spy, nvda, price_corr=0.68)
        # Rubber band on NVDA is stretched → must WAIT for pullback to 9 EMA
        assert rpt.trade_signal == "WAIT"
        assert "Rubber band" in rpt.signal_reason
        assert "NVDA" in rpt.signal_reason
