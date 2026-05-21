import asyncio
import os
import sqlite3
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, time
from typing import Optional
from zoneinfo import ZoneInfo

import httpx
import pandas as pd
import yfinance as yf
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from openai import OpenAI
from pydantic import BaseModel

ET = ZoneInfo("America/New_York")
_last_alert_signal: str = "WAIT"


async def send_telegram(token: str, chat_id: str, text: str) -> None:
    async with httpx.AsyncClient() as client:
        await client.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": text, "parse_mode": "Markdown"},
            timeout=10.0,
        )


async def maybe_alert(data: dict) -> None:
    global _last_alert_signal
    token   = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        return
    signal = data["tradeSignal"]
    if signal == "WAIT" or not data["marketOpen"]:
        _last_alert_signal = "WAIT"
        return
    is_new   = signal != _last_alert_signal
    is_ultra = bool(data.get("ultraConviction"))
    if not is_new and not is_ultra:
        return
    _last_alert_signal = signal
    emoji = "\U0001f7e2" if signal == "CALLS" else "\U0001f534"
    if is_ultra:              header = f"\U0001f525\U0001f525 *ULTRA CONVICTION — {signal}*"
    elif data["highConviction"]: header = f"⭐ *HIGH CONVICTION — {signal}*"
    else:                     header = f"{emoji} *{signal} SIGNAL — {data['ticker']}*"
    p180     = f"\n\U0001f4d0 *180:* {data['pattern180']['description']}" if data["pattern180"]["detected"] else ""
    no_entry = f"\n⛔ *No-entry zone:* {data['noEntryZone']['name']}" if data["noEntryZone"]["active"] else ""
    msg = (f"{header}\n"
           f"\U0001f4b5 SPY `${data['currentPrice']}`\n"
           f"\U0001f4ca EMA9: `${data['ema9']}` | VWAP: `${data['vwap']}`\n"
           f"\U0001f3d7 Stack: *{data['gate2Stack']}*{p180}{no_entry}\n"
           f"\U0001f4dd {data['signalReason']}")
    await send_telegram(token, chat_id, msg)


async def alert_loop() -> None:
    await asyncio.sleep(15)
    while True:
        try:
            data = await analyze_ticker("SPY")
            await maybe_alert(data)
        except Exception:
            pass
        await asyncio.sleep(300)


@asynccontextmanager
async def lifespan(app: FastAPI):
    asyncio.create_task(alert_loop())
    yield


app = FastAPI(title="SPY Trading Analysis API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

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
    direction: str
    entryPrice: float
    contracts: int = 1
    notes: Optional[str] = None


class JournalEntryUpdate(BaseModel):
    exitPrice: Optional[float] = None
    notes: Optional[str] = None


DB_PATH = os.path.join(os.path.dirname(__file__), "journal.db")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS journal_entries (
            id TEXT PRIMARY KEY, ticker TEXT NOT NULL, direction TEXT NOT NULL,
            entry_price REAL NOT NULL, exit_price REAL, contracts INTEGER NOT NULL DEFAULT 1,
            notes TEXT, created_at TEXT NOT NULL, closed_at TEXT
        )
    """)
    conn.commit()
    conn.close()

init_db()


def calc_ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()

def calc_vwap(df: pd.DataFrame) -> pd.Series:
    tp = (df["High"] + df["Low"] + df["Close"]) / 3
    return (tp * df["Volume"]).cumsum() / df["Volume"].cumsum()


def detect_180(df, ema9_series, vwap_series):
    empty = {"detected": False, "direction": None, "patternType": None, "anchor": None, "description": None}
    if len(df) < 2: return empty
    prev, curr = df.iloc[-2], df.iloc[-1]
    po, pc, ph, pl = float(prev["Open"]), float(prev["Close"]), float(prev["High"]), float(prev["Low"])
    co, cc = float(curr["Open"]), float(curr["Close"])
    pe9, ce9, cv = float(ema9_series.iloc[-2]), float(ema9_series.iloc[-1]), float(vwap_series.iloc[-1])
    body = abs(pc - po)
    fat  = cc * 0.001
    bull = body >= fat and pc < po and cc > co and cc > ph
    bear = body >= fat and pc > po and cc < co and cc < pl
    if not bull and not bear: return empty
    direction = "BULL" if bull else "BEAR"
    near_t, stretch_t = cc * 0.0015, cc * 0.002
    near_e = abs(cc - ce9) <= near_t
    near_v = abs(cc - cv)  <= near_t
    stretched = abs(pc - pe9) > stretch_t
    if near_e:      pt, anchor = "BREAKAWAY", "9 EMA"
    elif near_v:    pt, anchor = "BREAKAWAY", "VWAP"
    elif stretched: pt, anchor = "SNAPBACK",  None
    else:           pt, anchor = "STANDARD",  None
    dw = "Bull" if bull else "Bear"
    sa = abs(pc - pe9)
    if pt == "BREAKAWAY": desc = f"{dw} 180 breakaway at {anchor} — closed beyond prior bar’s wick at key level. High-probability reversal."
    elif pt == "SNAPBACK": desc = f"{dw} 180 snapback — price stretched ${sa:.2f} ({sa/cc*100:.2f}%) from 9 EMA, reverting hard."
    else: desc = f"{dw} 180 engulfing — prior wick surpassed, momentum shifted."
    return {"detected": True, "direction": direction, "patternType": pt, "anchor": anchor, "description": desc}


async def analyze_ticker(ticker: str) -> dict:
    now_et = datetime.now(ET)
    tk = yf.Ticker(ticker.upper())
    df = await asyncio.to_thread(tk.history, period="1d", interval="5m")
    if df is None or df.empty: raise ValueError(f"No data for {ticker}")
    df = df.copy()
    df.index = pd.to_datetime(df.index)
    if df.index.tzinfo is None: df.index = df.index.tz_localize("UTC").tz_convert(ET)
    else: df.index = df.index.tz_convert(ET)
    today = now_et.date()
    ss = pd.Timestamp(today).tz_localize(ET).replace(hour=9, minute=30)
    dt = df[(df.index.date == today) & (df.index >= ss)]
    if dt.empty: dt = df
    e9 = calc_ema(dt["Close"], 9)
    vw = calc_vwap(dt)
    cp = float(dt["Close"].iloc[-1])
    ema9 = float(e9.iloc[-1])
    vwap = float(vw.iloc[-1])
    lbt  = dt.index[-1].isoformat()
    if cp > ema9 and ema9 > vwap:   gs = "BULLISH"
    elif vwap > ema9 and ema9 > cp: gs = "BEARISH"
    else:                           gs = "NEUTRAL"
    kiss = bool(((dt["Low"] <= e9+0.10) & (dt["High"] >= e9-0.10)).any())
    rbok = bool(abs(cp - ema9) < 0.25)
    if gs=="BULLISH": ks = cp < ema9
    elif gs=="BEARISH": ks = cp > ema9
    else: ks = False
    orbc = pd.Timestamp(today).tz_localize(ET).replace(hour=9, minute=45)
    ob   = dt[dt.index < orbc]
    orb_est = (now_et.time() >= time(9,45)) and (not ob.empty)
    if orb_est:
        oh = round(float(ob["High"].max()),4); ol = round(float(ob["Low"].min()),4)
        if cp > oh: obk = "UP"
        elif cp < ol: obk = "DOWN"
        else: obk = "NONE"
    else: oh=ol=None; obk="NONE"
    t = now_et.time()
    imw = (now_et.weekday()<5) and (time(9,55)<=t<=time(10,5))
    mo  = (now_et.weekday()<5) and (time(9,30)<=t<=time(16,0))
    ZONES=[
        {"name":"Opening Trap","start":time(9,30),"end":time(9,45),"message":"Opening trap window — algos are faking direction. Wait for structure to form."},
        {"name":"10 AM Macro Candle","start":time(9,55),"end":time(10,5),"message":"10 AM macro candle — economic data releases move the market. Wait for the dust to settle."},
        {"name":"Lunch Chop Zone","start":time(12,0),"end":time(13,0),"message":"Lunch chop zone — low volume, no conviction. Stand aside."},
        {"name":"End of Day","start":time(15,45),"end":time(16,0),"message":"End of day — theta crush in final 15 minutes. Close open positions, no new entries."},
    ]
    az=None
    if mo:
        for z in ZONES:
            if z["start"]<=t<=z["end"]: az=z; break
    nez={"active":az is not None,"name":az["name"] if az else None,"message":az["message"] if az else None}
    ocb=orb_est and obk=="UP"; ocbr=orb_est and obk=="DOWN"; oreq=orb_est and az is None
    p180=detect_180(dt,e9,vw)
    p_bull=p180["detected"] and p180["direction"]=="BULL"
    p_bear=p180["detected"] and p180["direction"]=="BEAR"
    snap=p180["detected"] and p180["patternType"]=="SNAPBACK"
    rbpb=rbok or (snap and p_bull); rbpbr=rbok or (snap and p_bear)
    bullc=(gs=="BULLISH" and kiss and rbpb and not ks and mo and az is None and (not oreq or ocb))
    bearc=(gs=="BEARISH" and kiss and rbpbr and not ks and mo and az is None and (not oreq or ocbr))
    hc=(bullc and ocb) or (bearc and ocbr)
    uc=(hc and bullc and p_bull) or (hc and bearc and p_bear)
    if bullc:
        sig="CALLS"
        ct=" ★★ Ultra conviction — ORB+LE Model+Bull 180." if uc else " ★ High conviction — ORB+LE Model." if hc else ""
        sr=f"{ticker} bullish: price({cp:.2f})>EMA9({ema9:.2f})>VWAP({vwap:.2f}), kiss confirmed.{ct}"
        if snap and p_bull: sr+=f" Rubber band bypassed—Snapback 180. {p180['description']}"
        elif p_bull: sr+=f" {p180['description']}"
        elif p_bear: sr+=" ⚠ Conflicting Bear 180—caution."
    elif bearc:
        sig="PUTS"
        ct=" ★★ Ultra conviction — ORB+LE Model+Bear 180." if uc else " ★ High conviction — ORB+LE Model." if hc else ""
        sr=f"{ticker} bearish: VWAP({vwap:.2f})>EMA9({ema9:.2f})>price({cp:.2f}), kiss confirmed.{ct}"
        if snap and p_bear: sr+=f" Rubber band bypassed—Snapback 180. {p180['description']}"
        elif p_bear: sr+=f" {p180['description']}"
        elif p_bull: sr+=" ⚠ Conflicting Bull 180—caution."
    else:
        sig="WAIT"
        if az: sr=az["message"]
        else:
            rs=[]
            if gs=="NEUTRAL": rs.append("stack neutral")
            if not kiss: rs.append("no physical kiss today")
            if not rbok and not snap: rs.append(f"stretched ${abs(cp-ema9):.2f} from EMA9")
            if ks: rs.append("kill switch active")
            if not mo: rs.append("market closed")
            if oreq and obk=="NONE" and oh and ol: rs.append(f"inside ORB ${ol:.2f}–${oh:.2f}")
            elif oreq and obk=="UP" and gs=="BEARISH": rs.append("ORB UP but stack BEARISH—conflict")
            elif oreq and obk=="DOWN" and gs=="BULLISH": rs.append("ORB DOWN but stack BULLISH—conflict")
            sr="Waiting: "+"; ".join(rs)+"." if rs else "Conditions not fully met."
            if p180["detected"]: sr+=f" Note: {p180['description']}"
    return {"ticker":ticker.upper(),"currentPrice":round(cp,4),"ema9":round(ema9,4),"vwap":round(vwap,4),
            "gate2Stack":gs,"physicalKissSeen":kiss,"rubberBandOk":rbok,"killSwitchActive":ks,
            "inMacroWindow":imw,"marketOpen":mo,"noEntryZone":nez,"orbEstablished":orb_est,
            "orbHigh":oh,"orbLow":ol,"orbBreakout":obk,"highConviction":hc,"ultraConviction":uc,
            "pattern180":p180,"lastBarTime":lbt,"tradeSignal":sig,"signalReason":sr,
            "fetchedAt":datetime.utcnow().isoformat()+"Z","dataSource":"Yahoo Finance"}


@app.get("/api/analysis")
async def get_analysis(ticker: str = Query(default="SPY"), source: str = Query(default="yahoo")):
    try: return await analyze_ticker(ticker)
    except Exception as e: return JSONResponse(status_code=502, content={"error": str(e)})


@app.post("/api/analysis/insight")
async def get_insight(body: InsightRequest):
    cp, ep = [], []
    if body.gate2Stack!="NEUTRAL": cp.append(f"LE stack {body.gate2Stack}")
    else: ep.append("stack neutral")
    if body.physicalKissSeen: cp.append("kiss confirmed")
    else: ep.append("no kiss")
    if body.rubberBandOk: cp.append("rubber band tight")
    else: ep.append(f"stretched ${abs(body.currentPrice-body.ema9):.2f}")
    if not body.killSwitchActive: cp.append("kill switch clear")
    else: ep.append("kill switch active")
    if body.marketOpen: cp.append("market open")
    else: ep.append("market closed")
    if body.noEntryZoneName: ep.append(f"no-entry: {body.noEntryZoneName}")
    ol=[]
    if body.orbEstablished:
        r=f"${body.orbHigh:.2f}–${body.orbLow:.2f}" if body.orbHigh and body.orbLow else "est"
        bm={"UP":"above ORB high","DOWN":"below ORB low","NONE":"inside ORB"}
        ol.append(f"ORB {r}: {bm.get(body.orbBreakout,body.orbBreakout)}")
        if body.highConviction: ol.append("HIGH CONVICTION: ORB+stack agree")
        elif body.orbBreakout!="NONE" and body.gate2Stack!="NEUTRAL":
            dm=(body.orbBreakout=="UP" and body.gate2Stack=="BULLISH") or (body.orbBreakout=="DOWN" and body.gate2Stack=="BEARISH")
            if not dm: ol.append("WARNING: ORB conflicts stack")
    else: ol.append("ORB not established")
    prompt=f"""SPY intraday analyst. {body.ticker} | {body.tradeSignal} | ${body.currentPrice:.2f} EMA9=${body.ema9:.2f} VWAP=${body.vwap:.2f}\nORB: {"; ".join(ol)}\n✓ {", ".join(cp) or "none"} | ✗ {", ".join(ep) or "none"}\n2-3 sentences: actionable? key edge/risk? direct, no filler."""
    try:
        r=ai_client.chat.completions.create(model="gpt-5-mini",max_completion_tokens=8192,messages=[{"role":"user","content":prompt}])
        return {"insight": r.choices[0].message.content or "No insight."}
    except Exception as e: return JSONResponse(status_code=502,content={"error":f"AI unavailable: {e}"})


def row_to_entry(row):
    pnl=round((row["exit_price"]-row["entry_price"])*row["contracts"]*100,2) if row["exit_price"] else None
    return {"id":row["id"],"ticker":row["ticker"],"direction":row["direction"],"entryPrice":row["entry_price"],
            "exitPrice":row["exit_price"],"contracts":row["contracts"],"notes":row["notes"],
            "pnl":pnl,"createdAt":row["created_at"],"closedAt":row["closed_at"]}

@app.get("/api/journal")
async def list_journal():
    conn=get_db(); rows=conn.execute("SELECT * FROM journal_entries ORDER BY created_at DESC").fetchall(); conn.close()
    return {"entries":[row_to_entry(r) for r in rows]}

@app.post("/api/journal")
async def create_journal_entry(body: JournalEntryCreate):
    eid=str(uuid.uuid4()); ca=datetime.utcnow().isoformat()+"Z"; conn=get_db()
    conn.execute("INSERT INTO journal_entries (id,ticker,direction,entry_price,contracts,notes,created_at) VALUES (?,?,?,?,?,?,?)",
                 (eid,body.ticker.upper(),body.direction,body.entryPrice,body.contracts,body.notes,ca))
    conn.commit(); row=conn.execute("SELECT * FROM journal_entries WHERE id=?",(eid,)).fetchone(); conn.close()
    return row_to_entry(row)

@app.patch("/api/journal/{entry_id}")
async def update_journal_entry(entry_id: str, body: JournalEntryUpdate):
    conn=get_db(); row=conn.execute("SELECT * FROM journal_entries WHERE id=?",(entry_id,)).fetchone()
    if not row: conn.close(); return JSONResponse(status_code=404,content={"error":"Not found."})
    ca=datetime.utcnow().isoformat()+"Z" if body.exitPrice else row["closed_at"]
    conn.execute("UPDATE journal_entries SET exit_price=COALESCE(?,exit_price),notes=COALESCE(?,notes),closed_at=? WHERE id=?",
                 (body.exitPrice,body.notes,ca,entry_id))
    conn.commit(); row=conn.execute("SELECT * FROM journal_entries WHERE id=?",(entry_id,)).fetchone(); conn.close()
    return row_to_entry(row)

@app.delete("/api/journal/{entry_id}")
async def delete_journal_entry(entry_id: str):
    conn=get_db(); conn.execute("DELETE FROM journal_entries WHERE id=?",(entry_id,)); conn.commit(); conn.close()
    return {"deleted":entry_id}

@app.get("/api/spy/sources")
async def get_sources(): return {"sources":[{"id":"yahoo","name":"Yahoo Finance","available":True,"delay":"~2 min lag","note":""}]}

@app.get("/api/healthz")
async def healthz(): return {"status":"ok"}

if __name__=="__main__":
    import uvicorn
    uvicorn.run("main:app",host="0.0.0.0",port=int(os.environ.get("PORT",8000)),reload=True)
