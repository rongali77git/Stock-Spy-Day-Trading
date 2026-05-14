import os
import sqlite3
import uuid
from datetime import datetime, time
from typing import Optional
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from openai import OpenAI
from pydantic import BaseModel

app = FastAPI(title="SPY Trading Analysis API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

ET = ZoneInfo("America/New_York")

ai_client = OpenAI(
    base_url=os.environ.get("AI_INTEGRATIONS_OPENAI_BASE_URL"),
    api_key=os.environ.get("AI_INTEGRATIONS_OPENAI_API_KEY", "placeholder"),
)


class InsightRequest(BaseModel):
    ticker: str
    currentPrice: float
    ema9: float
    vwap: float
    gate2Stack: str
    physicalKissSeen: bool
    rubberBandOk: bool
    killSwitchActive: bool
    marketOpen: bool
    tradeSignal: str
    orbEstablished: bool = False
    orbHigh: Optional[float] = None
    orbLow: Optional[float] = None
    orbBreakout: str = "NONE"
    highConviction: bool = False
    noEntryZoneName: Optional[str] = None


class JournalEntryCreate(BaseModel):
    ticker: str
    direction: str  # CALLS | PUTS | CALL_SPREAD | PUT_SPREAD
    entryPrice: float
    contracts: int = 1
    notes: Optional[str] = None


class JournalEntryUpdate(BaseModel):
    exitPrice: Optional[float] = None
    notes: Optional[str] = None


# --- SQLite setup ---
DB_PATH = os.path.join(os.path.dirname(__file__), "journal.db")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS journal_entries (
            id TEXT PRIMARY KEY,
            ticker TEXT NOT NULL,
            direction TEXT NOT NULL,
            entry_price REAL NOT NULL,
            exit_price REAL,
            contracts INTEGER NOT NULL DEFAULT 1,
            notes TEXT,
            created_at TEXT NOT NULL,
            closed_at TEXT
        )
    """)
    conn.commit()
    conn.close()


init_db()


def calc_ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()


def calc_vwap(df: pd.DataFrame) -> pd.Series:
    typical_price = (df["High"] + df["Low"] + df["Close"]) / 3
    cum_tp_vol = (typical_price * df["Volume"]).cumsum()
    cum_vol = df["Volume"].cumsum()
    return cum_tp_vol / cum_vol


@app.get("/api/analysis")
async def get_analysis(
    ticker: str = Query(default="SPY"),
    source: str = Query(default="yahoo"),
):
    now_et = datetime.now(ET)
    fetched_at = datetime.utcnow().isoformat() + "Z"

    try:
        tk = yf.Ticker(ticker.upper())
        df = tk.history(period="1d", interval="5m")
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": f"Data fetch failed: {e}"})

    if df is None or df.empty:
        return JSONResponse(status_code=404, content={"error": "No data returned for ticker."})

    df = df.copy()
    df.index = pd.to_datetime(df.index)

    # Ensure index is timezone-aware in ET so we can filter to today's session only
    if df.index.tzinfo is None:
        df.index = df.index.tz_localize("UTC").tz_convert(ET)
    else:
        df.index = df.index.tz_convert(ET)

    today_et = now_et.date()
    session_start = pd.Timestamp(today_et).tz_localize(ET).replace(hour=9, minute=30)

    # Keep only today's bars from market open onward — this ensures VWAP
    # resets cleanly each session and pre-market / prior-day bars are excluded
    df_today = df[(df.index.date == today_et) & (df.index >= session_start)]

    # Fall back to full df if market is closed / no regular-hours bars yet
    if df_today.empty:
        df_today = df

    ema9_series = calc_ema(df_today["Close"], 9)
    vwap_series = calc_vwap(df_today)

    current_price = float(df_today["Close"].iloc[-1])
    ema9 = float(ema9_series.iloc[-1])
    vwap = float(vwap_series.iloc[-1])
    last_bar_time = df_today.index[-1].isoformat()

    # gate2Stack
    if current_price > ema9 and ema9 > vwap:
        gate2_stack = "BULLISH"
    elif vwap > ema9 and ema9 > current_price:
        gate2_stack = "BEARISH"
    else:
        gate2_stack = "NEUTRAL"

    # physicalKissSeen: any session candle whose range came within $0.10 of the 9 EMA
    physical_kiss_seen = bool(
        ((df_today["Low"] <= ema9_series + 0.10) & (df_today["High"] >= ema9_series - 0.10)).any()
    )

    # rubberBandOk: price is within $0.25 of EMA9
    rubber_band_ok = bool(abs(current_price - ema9) < 0.25)

    # killSwitchActive: last candle closed on wrong side of 9 EMA vs gate direction
    if gate2_stack == "BULLISH":
        kill_switch_active = current_price < ema9
    elif gate2_stack == "BEARISH":
        kill_switch_active = current_price > ema9
    else:
        kill_switch_active = False

    # Opening Range Breakout (ORB) — first 15 minutes: 9:30–9:45 AM ET
    orb_cutoff = pd.Timestamp(today_et).tz_localize(ET).replace(hour=9, minute=45)
    orb_bars = df_today[df_today.index < orb_cutoff]
    orb_established = (now_et.time() >= time(9, 45)) and (not orb_bars.empty)

    if orb_established:
        orb_high = round(float(orb_bars["High"].max()), 4)
        orb_low = round(float(orb_bars["Low"].min()), 4)
        if current_price > orb_high:
            orb_breakout = "UP"
        elif current_price < orb_low:
            orb_breakout = "DOWN"
        else:
            orb_breakout = "NONE"
    else:
        orb_high = None
        orb_low = None
        orb_breakout = "NONE"

    # marketOpen: 9:30 AM – 4:00 PM ET, weekdays only
    t = now_et.time()
    in_macro_window = (now_et.weekday() < 5) and (time(9, 55) <= t <= time(10, 5))
    market_open = (now_et.weekday() < 5) and (time(9, 30) <= t <= time(16, 0))

    # No-entry time zones (all ET)
    NO_ENTRY_ZONES = [
        {
            "name": "Opening Trap",
            "start": time(9, 30),
            "end": time(9, 45),
            "message": "Opening trap window — algos are faking direction. Wait for structure to form.",
        },
        {
            "name": "10 AM Macro Candle",
            "start": time(9, 55),
            "end": time(10, 5),
            "message": "10 AM macro candle — economic data releases move the market. Wait for the dust to settle.",
        },
        {
            "name": "Lunch Chop Zone",
            "start": time(12, 0),
            "end": time(13, 0),
            "message": "Lunch chop zone — low volume, no conviction. Stand aside.",
        },
        {
            "name": "End of Day",
            "start": time(15, 45),
            "end": time(16, 0),
            "message": "End of day — theta crush in final 15 minutes. Close open positions, no new entries.",
        },
    ]

    active_zone = None
    if market_open:
        for zone in NO_ENTRY_ZONES:
            if zone["start"] <= t <= zone["end"]:
                active_zone = zone
                break

    no_entry_zone = {
        "active": active_zone is not None,
        "name": active_zone["name"] if active_zone else None,
        "message": active_zone["message"] if active_zone else None,
    }

    # ORB confirmation requirement (only applies when ORB is established and no time gate is active)
    orb_confirms_bullish = orb_established and orb_breakout == "UP"
    orb_confirms_bearish = orb_established and orb_breakout == "DOWN"
    # Before 9:45, Opening Trap zone already blocks — ORB not yet a factor
    orb_required = orb_established and active_zone is None

    # tradeSignal determination
    bullish_conditions = (
        gate2_stack == "BULLISH"
        and physical_kiss_seen
        and rubber_band_ok
        and not kill_switch_active
        and market_open
        and active_zone is None
        and (not orb_required or orb_confirms_bullish)
    )
    bearish_conditions = (
        gate2_stack == "BEARISH"
        and physical_kiss_seen
        and rubber_band_ok
        and not kill_switch_active
        and market_open
        and active_zone is None
        and (not orb_required or orb_confirms_bearish)
    )

    # High conviction when ORB and LE Model agree
    high_conviction = (bullish_conditions and orb_confirms_bullish) or (bearish_conditions and orb_confirms_bearish)

    if bullish_conditions:
        trade_signal = "CALLS"
        conviction = " ★ High conviction — ORB + LE Model aligned." if high_conviction else ""
        signal_reason = (
            f"{ticker} is bullish: price ({current_price:.2f}) > EMA9 ({ema9:.2f}) > VWAP ({vwap:.2f}), "
            f"rubber band tight, kiss confirmed.{conviction}"
        )
    elif bearish_conditions:
        trade_signal = "PUTS"
        conviction = " ★ High conviction — ORB + LE Model aligned." if high_conviction else ""
        signal_reason = (
            f"{ticker} is bearish: VWAP ({vwap:.2f}) > EMA9 ({ema9:.2f}) > price ({current_price:.2f}), "
            f"rubber band tight, kiss confirmed.{conviction}"
        )
    else:
        trade_signal = "WAIT"
        if active_zone:
            signal_reason = active_zone["message"]
        else:
            reasons = []
            if gate2_stack == "NEUTRAL":
                reasons.append("stack is neutral (no clear EMA9/VWAP alignment)")
            if not physical_kiss_seen:
                reasons.append("no physical kiss of EMA9 seen today")
            if not rubber_band_ok:
                reasons.append(f"price is stretched from EMA9 by ${abs(current_price - ema9):.2f}")
            if kill_switch_active:
                reasons.append("kill switch active (wrong side of EMA9)")
            if not market_open:
                reasons.append("market is closed")
            # ORB-specific blocking reasons
            if orb_required and orb_breakout == "NONE" and orb_high is not None and orb_low is not None:
                reasons.append(f"price inside opening range (ORB: ${orb_low:.2f}–${orb_high:.2f}), wait for breakout")
            elif orb_required and orb_breakout == "UP" and gate2_stack == "BEARISH":
                reasons.append(f"ORB broke UP but stack is BEARISH — systems conflict")
            elif orb_required and orb_breakout == "DOWN" and gate2_stack == "BULLISH":
                reasons.append(f"ORB broke DOWN but stack is BULLISH — systems conflict")
            signal_reason = "Waiting: " + "; ".join(reasons) + "." if reasons else "Conditions not fully met."

    return {
        "ticker": ticker.upper(),
        "currentPrice": round(current_price, 4),
        "ema9": round(ema9, 4),
        "vwap": round(vwap, 4),
        "gate2Stack": gate2_stack,
        "physicalKissSeen": physical_kiss_seen,
        "rubberBandOk": rubber_band_ok,
        "killSwitchActive": kill_switch_active,
        "inMacroWindow": in_macro_window,
        "marketOpen": market_open,
        "noEntryZone": no_entry_zone,
        "orbEstablished": orb_established,
        "orbHigh": orb_high,
        "orbLow": orb_low,
        "orbBreakout": orb_breakout,
        "highConviction": high_conviction,
        "lastBarTime": last_bar_time,
        "tradeSignal": trade_signal,
        "signalReason": signal_reason,
        "fetchedAt": fetched_at,
        "dataSource": "Yahoo Finance",
    }


@app.post("/api/analysis/insight")
async def get_insight(body: InsightRequest):
    conditions_passed = []
    conditions_failed = []

    if body.gate2Stack != "NEUTRAL":
        conditions_passed.append(f"LE stack {body.gate2Stack}")
    else:
        conditions_failed.append("LE stack neutral (no clear EMA9/VWAP alignment)")

    if body.physicalKissSeen:
        conditions_passed.append("physical kiss confirmed (price touched EMA9)")
    else:
        conditions_failed.append("no physical kiss seen yet")

    if body.rubberBandOk:
        conditions_passed.append("rubber band tight (price close to EMA9)")
    else:
        stretch = abs(body.currentPrice - body.ema9)
        conditions_failed.append(f"price stretched ${stretch:.2f} from EMA9 (rubber band extended)")

    if not body.killSwitchActive:
        conditions_passed.append("kill switch clear")
    else:
        conditions_failed.append("kill switch active (recent big loss — no new trades)")

    if body.marketOpen:
        conditions_passed.append("market open")
    else:
        conditions_failed.append("market closed")

    if body.noEntryZoneName:
        conditions_failed.append(f"in no-entry zone: {body.noEntryZoneName}")

    # ORB context
    orb_lines = []
    if body.orbEstablished:
        orb_range = f"${body.orbHigh:.2f}–${body.orbLow:.2f} (range ${(body.orbHigh - body.orbLow):.2f})" if body.orbHigh and body.orbLow else "established"
        breakout_map = {"UP": "broke above ORB high — bullish bias", "DOWN": "broke below ORB low — bearish bias", "NONE": "still inside ORB range — no confirmed breakout"}
        orb_lines.append(f"ORB {orb_range}: {breakout_map.get(body.orbBreakout, body.orbBreakout)}")
        if body.highConviction:
            orb_lines.append("HIGH CONVICTION: ORB direction matches LE stack — double confirmation")
        elif body.orbBreakout != "NONE" and body.gate2Stack != "NEUTRAL":
            dir_match = (body.orbBreakout == "UP" and body.gate2Stack == "BULLISH") or (body.orbBreakout == "DOWN" and body.gate2Stack == "BEARISH")
            if not dir_match:
                orb_lines.append("WARNING: ORB direction conflicts with LE stack — mixed signals, avoid")
    else:
        orb_lines.append("ORB not yet established (before 9:45 AM or no data)")

    prompt = f"""You are a concise intraday trading analyst specialising in SPY/index options. Evaluate this real-time setup and give a direct, actionable assessment.

Ticker: {body.ticker} | Signal: {body.tradeSignal}
Price: ${body.currentPrice:.2f} | EMA9: ${body.ema9:.2f} | VWAP: ${body.vwap:.2f}

ORB Context:
{chr(10).join(f"  • {l}" for l in orb_lines)}

LE Model Conditions:
  ✓ Passed: {", ".join(conditions_passed) if conditions_passed else "none"}
  ✗ Failed: {", ".join(conditions_failed) if conditions_failed else "none"}

In 2-3 sentences: Is this setup actionable right now? What is the key edge or key risk? If market is closed or pre-market, focus on what to watch for at open. Be direct — no filler, no generic disclaimers."""

    try:
        response = ai_client.chat.completions.create(
            model="gpt-5-mini",
            max_completion_tokens=8192,
            messages=[{"role": "user", "content": prompt}],
        )
        insight = response.choices[0].message.content or "No insight available."
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": f"AI unavailable: {e}"})

    return {"insight": insight}


def row_to_entry(row: sqlite3.Row) -> dict:
    pnl = None
    if row["exit_price"] is not None:
        pnl = round((row["exit_price"] - row["entry_price"]) * row["contracts"] * 100, 2)
    return {
        "id": row["id"],
        "ticker": row["ticker"],
        "direction": row["direction"],
        "entryPrice": row["entry_price"],
        "exitPrice": row["exit_price"],
        "contracts": row["contracts"],
        "notes": row["notes"],
        "pnl": pnl,
        "createdAt": row["created_at"],
        "closedAt": row["closed_at"],
    }


@app.get("/api/journal")
async def list_journal():
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM journal_entries ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    return {"entries": [row_to_entry(r) for r in rows]}


@app.post("/api/journal")
async def create_journal_entry(body: JournalEntryCreate):
    entry_id = str(uuid.uuid4())
    created_at = datetime.utcnow().isoformat() + "Z"
    conn = get_db()
    conn.execute(
        """INSERT INTO journal_entries
           (id, ticker, direction, entry_price, contracts, notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (entry_id, body.ticker.upper(), body.direction, body.entryPrice,
         body.contracts, body.notes, created_at),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM journal_entries WHERE id = ?", (entry_id,)).fetchone()
    conn.close()
    return row_to_entry(row)


@app.patch("/api/journal/{entry_id}")
async def update_journal_entry(entry_id: str, body: JournalEntryUpdate):
    conn = get_db()
    row = conn.execute("SELECT * FROM journal_entries WHERE id = ?", (entry_id,)).fetchone()
    if not row:
        conn.close()
        return JSONResponse(status_code=404, content={"error": "Entry not found."})
    closed_at = datetime.utcnow().isoformat() + "Z" if body.exitPrice is not None else row["closed_at"]
    conn.execute(
        """UPDATE journal_entries
           SET exit_price = COALESCE(?, exit_price),
               notes = COALESCE(?, notes),
               closed_at = ?
           WHERE id = ?""",
        (body.exitPrice, body.notes, closed_at, entry_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM journal_entries WHERE id = ?", (entry_id,)).fetchone()
    conn.close()
    return row_to_entry(row)


@app.delete("/api/journal/{entry_id}")
async def delete_journal_entry(entry_id: str):
    conn = get_db()
    conn.execute("DELETE FROM journal_entries WHERE id = ?", (entry_id,))
    conn.commit()
    conn.close()
    return {"deleted": entry_id}


@app.get("/api/spy/sources")
async def get_sources():
    return {
        "sources": [
            {
                "id": "yahoo",
                "name": "Yahoo Finance",
                "available": True,
                "delay": "~2 min lag",
                "note": "",
            }
        ]
    }


@app.get("/api/healthz")
async def healthz():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
