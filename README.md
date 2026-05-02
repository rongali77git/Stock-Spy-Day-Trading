# Stock SPY Day Trading

Day-trading analysis suite for **SPY** built on the LE Model framework.

## Files

| File | Description |
|------|-------------|
| `spy_analysis.py` | SPY LE Model analyzer |
| `tests/test_spy_analysis.py` | Unit tests |

## LE Model Rules

1. **Gate 2** — Bullish: Price > 9 EMA > VWAP. Bearish: VWAP > 9 EMA > Price.
2. **Physical Kiss** — Wait for price to pull back and touch the 9 EMA.
3. **Rubber Band** — Never chase when price is ≥ $0.25 from the 9 EMA.
4. **10 AM Macro Candle** — Treat the 10 AM bar as a potential reversal zone.
5. **Kill Switch** — If a 5-min candle closes on the wrong side of the 9 EMA, exit immediately.
6. **Engineer's Discipline** — Cash is a position. Trade the math, not the candle.

## Quick Start

```bash
pip install -r requirements.txt
python spy_analysis.py
python -m pytest tests/ -v
```
