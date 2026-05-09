import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { calcPnL, isWin, type Trade } from "@/constants/types";

const STORAGE_KEY = "@spy_journal_trades";

interface JournalStats {
  totalTrades: number;
  closedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnL: number;
}

interface JournalContextValue {
  trades: Trade[];
  stats: JournalStats;
  addTrade: (trade: Omit<Trade, "id" | "date" | "status">) => Promise<void>;
  closeTrade: (id: string, exitPremium: number) => Promise<void>;
  deleteTrade: (id: string) => Promise<void>;
  loading: boolean;
}

const JournalContext = createContext<JournalContextValue | null>(null);

function computeStats(trades: Trade[]): JournalStats {
  const closed = trades.filter(t => t.status === "CLOSED");
  const open = trades.filter(t => t.status === "OPEN");
  const wins = closed.filter(isWin).length;
  const losses = closed.length - wins;
  const totalPnL = closed.reduce((acc, t) => acc + (calcPnL(t) ?? 0), 0);
  return {
    totalTrades: trades.length,
    closedTrades: closed.length,
    openTrades: open.length,
    wins,
    losses,
    winRate: closed.length > 0 ? wins / closed.length : 0,
    totalPnL,
  };
}

function migrateTrades(raw: any[]): Trade[] {
  return raw.map(t => ({
    ticker: "SPY",
    ...t,
  }));
}

export function JournalProvider({ children }: { children: React.ReactNode }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then(raw => {
      if (raw) {
        try {
          setTrades(migrateTrades(JSON.parse(raw)));
        } catch {}
      }
      setLoading(false);
    });
  }, []);

  const persist = useCallback(async (next: Trade[]) => {
    setTrades(next);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, []);

  const addTrade = useCallback(
    async (trade: Omit<Trade, "id" | "date" | "status">) => {
      const newTrade: Trade = {
        ...trade,
        id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
        date: new Date().toISOString(),
        status: "OPEN",
      };
      await persist([newTrade, ...trades]);
    },
    [trades, persist]
  );

  const closeTrade = useCallback(
    async (id: string, exitPremium: number) => {
      const next = trades.map(t =>
        t.id === id ? { ...t, exitPremium, status: "CLOSED" as const } : t
      );
      await persist(next);
    },
    [trades, persist]
  );

  const deleteTrade = useCallback(
    async (id: string) => {
      await persist(trades.filter(t => t.id !== id));
    },
    [trades, persist]
  );

  return (
    <JournalContext.Provider
      value={{ trades, stats: computeStats(trades), addTrade, closeTrade, deleteTrade, loading }}
    >
      {children}
    </JournalContext.Provider>
  );
}

export function useJournal(): JournalContextValue {
  const ctx = useContext(JournalContext);
  if (!ctx) throw new Error("useJournal must be used inside JournalProvider");
  return ctx;
}
