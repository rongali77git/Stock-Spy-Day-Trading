# Stock SPY Day Trading

Day-trading analysis suite built around the **LE Model** framework.

## Modules

| File | Description |
|------|-------------|
| `spy_nvda_trend_analysis.py` | Core SPY / NVDA trend-correlation engine |
| `tests/test_spy_nvda_trend_analysis.py` | Unit & integration tests |

## LE Model Core Directives

1. **Gate 2 Protocol** – Bullish stack: Price > 9 EMA > VWAP. Bearish stack: VWAP > 9 EMA > Price.
2. **Physical Kiss** – Wait for price to pull back and touch the 9 EMA before entry.
3. **Rubber Band Limit** – Never chase a stretched gap between price and 9 EMA (≥ $0.50 NVDA / ≥ $0.25 SPY).
4. **10:00 AM Macro Candle** – Treat the 10 AM bar as a potential reversal zone; do not hold a stretched position into it.
5. **Hard Kill Switch** – If a 5-min candle closes on the wrong side of the 9 EMA, exit immediately.
6. **Engineer's Discipline** – Trade the math, not the candle. Cash is a position.

## Quick Start

```bash
pip install -r requirements.txt
python spy_nvda_trend_analysis.py
python -m pytest tests/ -v
```
