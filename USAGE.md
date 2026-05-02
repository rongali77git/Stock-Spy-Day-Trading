# How to Use SPY Day Trading Analyzer

## Setup (One Time Only)

```bash
pip install -r requirements.txt
```

---

## Running the Analyzer

```bash
python spy_analysis.py
```

No input required. It automatically:
- Downloads the latest SPY 5-minute bars from Yahoo Finance (free, no account needed)
- Calculates 9 EMA and session VWAP
- Applies all LE Model rules
- Prints your signal

---

## Sample Output

```
=======================================================
 SPY ANALYSIS — LE MODEL
=======================================================
  Price : $720.00
  9 EMA : $720.11
  VWAP  : $720.39
  Stack : BEARISH
  Kiss  : NO
  Band  : OK
  Kill  : CLEAR

  Signal : *** WAIT ***
  Reason : No physical kiss today — price has not re-tested the 9 EMA. Entry is premature.
=======================================================
```

---

## Reading the Output

| Field | Meaning |
|-------|---------|
| **Price** | Latest SPY 5-min close |
| **9 EMA** | Current 9-period exponential moving average |
| **VWAP** | Session volume-weighted average price (resets each day) |
| **Stack** | Gate 2 result: BULLISH / BEARISH / NEUTRAL |
| **Kiss** | YES if price has touched the 9 EMA at least once today |
| **Band** | OK if price is within $0.25 of the 9 EMA. STRETCHED if not |
| **Kill** | ACTIVE means eject any open position immediately |
| **Signal** | Your action: CALLS / PUTS / WAIT |

---

## Signal Decision Guide

### WAIT
Do nothing. Sit on cash. One of these gates is locked:

| Reason in output | What it means | What to do |
|------------------|---------------|------------|
| Gate 2 not confirmed | EMA and VWAP haven’t cleanly crossed yet | Wait for the crossover |
| Kill switch active | Last candle closed on wrong side of 9 EMA | Exit open position immediately |
| Rubber band stretched | Price is too far from 9 EMA | Wait for pullback to EMA |
| No physical kiss | Stack confirmed but price hasn’t re-tested the 9 EMA | Wait for the kiss |

### PUTS
All gates are green and SPY is bearish-stacked.
- Buy SPY puts after price kisses the 9 EMA from below
- **Stop:** Exit immediately if a 5-min candle closes ABOVE the 9 EMA

### CALLS
All gates are green and SPY is bullish-stacked.
- Buy SPY calls after price kisses the 9 EMA from above
- **Stop:** Exit immediately if a 5-min candle closes BELOW the 9 EMA

---

## Daily Trading Routine

### Pre-Market (9:15–9:25 AM ET)
```bash
python spy_analysis.py
```
Check the overnight stack. Know your bias before the open.

### Market Open (9:30–10:00 AM ET)
- Re-run every 5 minutes
- **Do not trade the first 30 minutes blindly** — wait for structure to form

### 10 AM Macro Candle (9:55–10:05 AM ET)
- The analyzer flags this window automatically
- Do NOT enter a new position going into 10 AM
- Let the 10 AM volume candle establish the true direction, then re-run

### Active Trading (10:05 AM onward)
```bash
# Re-run every 5 minutes manually, or run a loop:
watch -n 300 python spy_analysis.py
```
- Only act when Signal = CALLS or PUTS
- Every WAIT is a successful execution of the system

### Before Exiting Any Trade
```bash
python spy_analysis.py
```
If Kill = ACTIVE — exit at market price immediately. No negotiating.

---

## Quick Reference Card

```
Stack = NEUTRAL  →  Gate 2 locked. Do nothing.
Stack = BEARISH  →  Looking for PUTS setup
Stack = BULLISH  →  Looking for CALLS setup

Kill = ACTIVE    →  Exit open position NOW. Market order.
Band = STRETCHED →  Do not chase. Wait for pullback.
Kiss = NO        →  Do not enter. Wait for price to touch 9 EMA.

Signal = PUTS    →  All green. Buy puts on the kiss.
Signal = CALLS   →  All green. Buy calls on the kiss.
Signal = WAIT    →  Cash is a position. Mission accomplished.
```

---

## Running Tests

```bash
python -m pytest tests/ -v
```

All tests run without internet. Validates every LE Model rule independently.
