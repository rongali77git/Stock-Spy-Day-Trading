export interface Trade {
  id: string;
  ticker: string;
  signal: "CALLS" | "PUTS";
  entryPremium: number;
  exitPremium?: number;
  contracts: number;
  spyPrice: number;
  date: string;
  notes?: string;
  status: "OPEN" | "CLOSED";
}

export function calcPnL(trade: Trade): number | null {
  if (trade.exitPremium == null) return null;
  return (trade.exitPremium - trade.entryPremium) * trade.contracts * 100;
}

export function isWin(trade: Trade): boolean {
  const pnl = calcPnL(trade);
  return pnl != null && pnl > 0;
}
