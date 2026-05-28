import { useState, useEffect, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "selectedTicker";
const DEFAULT_TICKER = "SPY";

export const POPULAR_TICKERS = [
  "SPY",  "QQQ",  "AAPL", "TSLA", "NVDA",
  "MSFT", "AMZN", "META", "AMD",  "GOOGL",
  "COIN", "PLTR", "SOFI", "MSTR", "IWM",
  "SNOW", "ARM",  "HOOD", "CRWD", "IONQ",
];

export function useTicker() {
  const [ticker, setTickerState] = useState<string>(DEFAULT_TICKER);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then(v => {
      if (v) setTickerState(v.toUpperCase());
    });
  }, []);

  const setTicker = useCallback(async (t: string) => {
    const upper = t.toUpperCase().trim();
    if (!upper) return;
    setTickerState(upper);
    await AsyncStorage.setItem(STORAGE_KEY, upper);
  }, []);

  return { ticker, setTicker };
}
