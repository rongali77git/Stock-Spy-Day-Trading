# SPY Day Trading — LE Model

## What This Project Does
Analyzes SPY 5-minute bars using the LE Model framework and produces a CALLS / PUTS / WAIT signal.
The owner trades **SPY options only**. No other tickers.

## Key File
- `spy_analysis.py` — the only file to run

## To Run the Analysis
```bash
pip install -r requirements.txt
python spy_analysis.py
```
No input needed. Fetches live SPY data automatically.

## LE Model Rules Built Into the Code
1. **Gate 2** — Bullish: Price > 9 EMA > VWAP. Bearish: VWAP > 9 EMA > Price.
2. **Physical Kiss** — Price must pull back and touch the 9 EMA before entry.
3. **Rubber Band** — Do not enter if price is ≥ $0.25 from the 9 EMA.
4. **10 AM Macro Candle** — 9:55–10:05 AM ET is a danger zone. No new entries.
5. **Kill Switch** — 5-min candle closes wrong side of 9 EMA → exit immediately.
6. **Engineer's Discipline** — WAIT is a valid signal. Cash is a position.

## Signal Output
- `CALLS` — All gates green, bullish stack confirmed
- `PUTS` — All gates green, bearish stack confirmed
- `WAIT` — One or more gates locked. Do nothing.

## Tests
```bash
python -m pytest tests/ -v
```
