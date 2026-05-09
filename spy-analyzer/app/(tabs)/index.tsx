import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  useColorScheme,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { useJournal } from "@/context/JournalContext";
import { useMarketAlert, sendStopAlert } from "@/hooks/useMarketAlert";
import { useDataSource } from "@/hooks/useDataSource";
import { useTicker } from "@/hooks/useTicker";
import { SourcePickerModal } from "@/components/SourcePickerModal";
import { TickerPickerModal } from "@/components/TickerPickerModal";

function getNextMarketOpenMs(): number {
  const now = new Date();
  const etFmt = (d: Date, opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", ...opts }).formatToParts(d);

  const parts = etFmt(now, { weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "0";
  const weekday = get("weekday");
  const etSeconds = parseInt(get("hour")) * 3600 + parseInt(get("minute")) * 60 + parseInt(get("second"));
  const openSeconds = 9 * 3600 + 30 * 60;
  const secsUntilTodayOpen = openSeconds - etSeconds;
  const isWeekday = weekday !== "Sat" && weekday !== "Sun";

  if (isWeekday && secsUntilTodayOpen > 0) {
    return now.getTime() + secsUntilTodayOpen * 1000;
  }

  let daysToAdd = 1;
  while (daysToAdd <= 3) {
    const candidate = new Date(now.getTime() + daysToAdd * 24 * 3600 * 1000);
    const cw = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(candidate);
    if (cw !== "Sat" && cw !== "Sun") {
      return now.getTime() + (secsUntilTodayOpen + daysToAdd * 24 * 3600) * 1000;
    }
    daysToAdd++;
  }
  return now.getTime() + 3 * 24 * 3600 * 1000;
}

function useMarketCountdown(): string {
  const [countdown, setCountdown] = useState("");

  useEffect(() => {
    const tick = () => {
      const diffMs = getNextMarketOpenMs() - Date.now();
      if (diffMs <= 0) { setCountdown("00:00:00"); return; }
      const totalSec = Math.floor(diffMs / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      setCountdown(
        `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return countdown;
}

interface TickerReport {
  ticker: string;
  currentPrice: number;
  ema9: number;
  vwap: number;
  gate2Stack: "BULLISH" | "BEARISH" | "NEUTRAL";
  physicalKissSeen: boolean;
  rubberBandOk: boolean;
  killSwitchActive: boolean;
  inMacroWindow: boolean;
  marketOpen: boolean;
  lastBarTime: string;
  tradeSignal: "CALLS" | "PUTS" | "WAIT";
  signalReason: string;
  fetchedAt: string;
  dataSource?: string;
}

function useTickerAnalysis(ticker: string, source: string) {
  const [data, setData] = useState<TickerReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const domain = process.env.EXPO_PUBLIC_DOMAIN;
      const base = domain ? `https://${domain}` : "";
      const resp = await fetch(`${base}/api/analysis?ticker=${encodeURIComponent(ticker)}&source=${source}`);
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error((body as any)?.error ?? `HTTP ${resp.status}`);
      }
      const json: TickerReport = await resp.json();
      setData(json);
      setLastUpdated(new Date());
    } catch (e: any) {
      setError(e?.message ?? `Failed to fetch ${ticker} data`);
    } finally {
      setLoading(false);
    }
  }, [ticker, source]);

  useEffect(() => {
    setData(null);
    fetchData();
    const interval = setInterval(fetchData, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData, lastUpdated };
}

function LogTradeModal({
  visible,
  onClose,
  signal,
  ticker,
  tickerPrice,
}: {
  visible: boolean;
  onClose: () => void;
  signal: "CALLS" | "PUTS";
  ticker: string;
  tickerPrice: number;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { addTrade } = useJournal();
  const [entry, setEntry] = useState("");
  const [contracts, setContracts] = useState("1");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const isWeb = Platform.OS === "web";

  const handleSave = async () => {
    const entryVal = parseFloat(entry);
    const contractsVal = parseInt(contracts, 10);
    if (isNaN(entryVal) || entryVal <= 0) {
      Alert.alert("Invalid entry", "Enter a valid entry premium (e.g. 2.50)");
      return;
    }
    if (isNaN(contractsVal) || contractsVal <= 0) {
      Alert.alert("Invalid contracts", "Enter a valid number of contracts");
      return;
    }
    setSaving(true);
    await addTrade({
      ticker,
      signal,
      entryPremium: entryVal,
      contracts: contractsVal,
      spyPrice: tickerPrice,
      notes: notes.trim() || undefined,
    });
    setSaving(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setEntry("");
    setContracts("1");
    setNotes("");
    onClose();
  };

  const signalColor = signal === "CALLS" ? colors.calls : colors.puts;

  return (
    <Modal visible={visible} animationType="slide" transparent presentationStyle="pageSheet">
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={[styles.modalOverlay]}>
          <View
            style={[
              styles.modalSheet,
              {
                backgroundColor: colors.card,
                paddingBottom: isWeb ? 34 : insets.bottom + 16,
              },
            ]}
          >
            <View style={[styles.modalHandle, { backgroundColor: colors.border }]} />
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>
                Log Trade
              </Text>
              <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
                <Feather name="x" size={22} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>

            <View style={[styles.signalPill, { backgroundColor: signalColor + "22", borderColor: signalColor }]}>
              <Text style={[styles.signalPillText, { color: signalColor, fontFamily: "Inter_700Bold" }]}>
                {signal}
              </Text>
              <Text style={[styles.spyPriceText, { color: signalColor, fontFamily: "Inter_400Regular" }]}>
                {ticker} @ ${tickerPrice.toFixed(2)}
              </Text>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
                Entry Premium (per contract)
              </Text>
              <TextInput
                style={[
                  styles.input,
                  { backgroundColor: colors.muted, color: colors.foreground, borderColor: colors.border, fontFamily: "Inter_400Regular" },
                ]}
                placeholder="e.g. 2.50"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="decimal-pad"
                value={entry}
                onChangeText={setEntry}
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
                Contracts
              </Text>
              <TextInput
                style={[
                  styles.input,
                  { backgroundColor: colors.muted, color: colors.foreground, borderColor: colors.border, fontFamily: "Inter_400Regular" },
                ]}
                placeholder="1"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="number-pad"
                value={contracts}
                onChangeText={setContracts}
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
                Notes (optional)
              </Text>
              <TextInput
                style={[
                  styles.input,
                  styles.inputMulti,
                  { backgroundColor: colors.muted, color: colors.foreground, borderColor: colors.border, fontFamily: "Inter_400Regular" },
                ]}
                placeholder="Setup notes, reason for entry…"
                placeholderTextColor={colors.mutedForeground}
                multiline
                numberOfLines={3}
                value={notes}
                onChangeText={setNotes}
              />
            </View>

            <TouchableOpacity
              onPress={handleSave}
              disabled={saving}
              style={[styles.saveBtn, { backgroundColor: signalColor }]}
              activeOpacity={0.85}
            >
              {saving ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={[styles.saveBtnText, { fontFamily: "Inter_700Bold" }]}>Log {signal}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export default function AnalyzerScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { source } = useDataSource();
  const { ticker, setTicker } = useTicker();
  const { data, loading, error, refetch, lastUpdated } = useTickerAnalysis(ticker, source);
  const countdown = useMarketCountdown();
  const { enabled: alertEnabled, toggle: toggleAlert } = useMarketAlert();
  const { trades } = useJournal();
  const [showLog, setShowLog] = useState(false);
  const [showSourcePicker, setShowSourcePicker] = useState(false);
  const [showTickerPicker, setShowTickerPicker] = useState(false);
  const [now, setNow] = useState(Date.now());
  const notifiedStops = useRef<Set<string>>(new Set());

  useEffect(() => {
    notifiedStops.current.clear();
  }, [ticker]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const openTrades = trades.filter(t => t.status === "OPEN" && t.ticker === ticker);
  const isDataStale =
    !!data?.marketOpen &&
    now - new Date(data.lastBarTime).getTime() > 10 * 60 * 1000;
  const stopTrades = data
    ? openTrades.filter(t =>
        (t.signal === "CALLS" && data.currentPrice < data.ema9) ||
        (t.signal === "PUTS" && data.currentPrice > data.ema9)
      )
    : [];

  useEffect(() => {
    if (!data || !data.marketOpen || stopTrades.length === 0) return;
    for (const t of stopTrades) {
      if (!notifiedStops.current.has(t.id)) {
        notifiedStops.current.add(t.id);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        sendStopAlert(ticker, t.signal);
      }
    }
  }, [data, stopTrades, ticker]);

  const isWeb = Platform.OS === "web";
  const topPad = isWeb ? 67 : insets.top;
  const bottomPad = isWeb ? 34 : insets.bottom;

  const handleRefresh = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await refetch();
  }, [refetch]);

  const handleLogTrade = useCallback(() => {
    if (!data || data.tradeSignal === "WAIT") return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setShowLog(true);
  }, [data]);

  const formattedTime = lastUpdated
    ? lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 12, backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity
          onPress={() => setShowTickerPicker(true)}
          activeOpacity={0.7}
          style={styles.headerLeft}
        >
          <Text style={[styles.headerTitle, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>{ticker}</Text>
          <Feather name="chevron-down" size={18} color={colors.mutedForeground} style={{ marginBottom: 2 }} />
          <Text style={[styles.headerSubtitle, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>LE Model</Text>
        </TouchableOpacity>
        <View style={styles.headerActions}>
          <TouchableOpacity
            onPress={toggleAlert}
            style={[styles.iconBtn, { backgroundColor: alertEnabled ? colors.calls + "22" : colors.muted }]}
            activeOpacity={0.7}
          >
            <Feather name={alertEnabled ? "bell" : "bell-off"} size={18} color={alertEnabled ? colors.calls : colors.mutedForeground} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setShowSourcePicker(true)}
            style={[styles.iconBtn, { backgroundColor: colors.muted }]}
            activeOpacity={0.7}
          >
            <Feather name="settings" size={18} color={colors.mutedForeground} />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleRefresh} style={[styles.iconBtn, { backgroundColor: colors.muted }]} disabled={loading} activeOpacity={0.7}>
            {loading ? <ActivityIndicator size="small" color={colors.primary} /> : <Feather name="refresh-cw" size={18} color={colors.primary} />}
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: bottomPad + 100 }]}
        showsVerticalScrollIndicator={false}
      >
        {error ? (
          <View style={[styles.errorCard, { backgroundColor: colors.card, borderColor: colors.puts }]}>
            <Feather name="alert-circle" size={32} color={colors.puts} />
            <Text style={[styles.errorTitle, { color: colors.puts, fontFamily: "Inter_600SemiBold" }]}>Failed to load</Text>
            <Text style={[styles.errorMsg, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>{error}</Text>
            <TouchableOpacity onPress={handleRefresh} style={[styles.retryBtn, { backgroundColor: colors.puts }]} activeOpacity={0.8}>
              <Text style={[styles.retryText, { color: "#fff", fontFamily: "Inter_600SemiBold" }]}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : loading && !data ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={[styles.loadingText, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>Fetching {ticker} data…</Text>
          </View>
        ) : data ? (
          <>
            {stopTrades.length > 0 && data.marketOpen && (
              <View style={[styles.exitBanner, { backgroundColor: colors.puts + "18", borderColor: colors.puts }]}>
                <View style={styles.exitBannerRow}>
                  <Feather name="alert-octagon" size={20} color={colors.puts} />
                  <Text style={[styles.exitBannerTitle, { color: colors.puts, fontFamily: "Inter_700Bold" }]}>
                    EXIT SIGNAL — Stop Hit
                  </Text>
                </View>
                {stopTrades.map(t => (
                  <View key={t.id} style={styles.exitBannerDetail}>
                    <Text style={[styles.exitBannerBody, { color: colors.puts, fontFamily: "Inter_600SemiBold" }]}>
                      {t.signal} trade @ ${t.entryPremium.toFixed(2)}
                    </Text>
                    <Text style={[styles.exitBannerSub, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                      {ticker} ${data.currentPrice.toFixed(2)} crossed {t.signal === "CALLS" ? "below" : "above"} 9 EMA ${data.ema9.toFixed(2)} · Close your position
                    </Text>
                  </View>
                ))}
              </View>
            )}
            {!data.marketOpen && (
              <View style={[styles.marketClosedBanner, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                <Feather name="moon" size={15} color={colors.mutedForeground} />
                <View style={{ flex: 1 }}>
                  <View style={styles.marketClosedRow}>
                    <Text style={[styles.marketClosedTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
                      Market Closed
                    </Text>
                    <Text style={[styles.countdownBadge, { color: colors.calls, fontFamily: "Inter_700Bold", backgroundColor: colors.calls + "18" }]}>
                      {countdown}
                    </Text>
                  </View>
                  <Text style={[styles.marketClosedSub, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                    Opens in · Last close {new Date(data.lastBarTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" })} ET · {new Date(data.lastBarTime).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "America/New_York" })}
                  </Text>
                </View>
              </View>
            )}
            {isDataStale && (
              <View style={[styles.staleBanner, { backgroundColor: colors.wait + "18", borderColor: colors.wait }]}>
                <Feather name="wifi-off" size={15} color={colors.wait} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.staleBannerTitle, { color: colors.wait, fontFamily: "Inter_600SemiBold" }]}>
                    Data may be stale
                  </Text>
                  <Text style={[styles.staleBannerSub, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                    Last bar at {new Date(data.lastBarTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" })} ET — over 10 min ago
                  </Text>
                </View>
                <TouchableOpacity onPress={handleRefresh} activeOpacity={0.7}>
                  <Text style={[styles.staleRetry, { color: colors.wait, fontFamily: "Inter_600SemiBold" }]}>Retry</Text>
                </TouchableOpacity>
              </View>
            )}
            {data.inMacroWindow && (
              <View style={[styles.macroBanner, { backgroundColor: colors.wait + "22", borderColor: colors.wait }]}>
                <Feather name="alert-triangle" size={16} color={colors.wait} />
                <Text style={[styles.macroText, { color: colors.wait, fontFamily: "Inter_600SemiBold" }]}>
                  Macro Candle Window — 9:55–10:05 AM ET
                </Text>
                <Text style={[styles.macroSub, { color: colors.wait, fontFamily: "Inter_400Regular" }]}>
                  Avoid new entries. Wait for the window to close.
                </Text>
              </View>
            )}
            <View style={[styles.signalCard, { backgroundColor: colors.card, borderColor: colors.border, opacity: data.marketOpen ? 1 : 0.6 }]}>
              <View style={styles.signalHeader}>
                <View>
                  <Text style={[styles.priceHero, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>${data.currentPrice.toFixed(2)}</Text>
                  <Text style={[styles.priceLabel2, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                    {ticker} · 5m bars{data.marketOpen ? "" : " · last close"} · {data.dataSource ?? "Yahoo Finance"}
                  </Text>
                </View>
                <SignalBadge signal={data.tradeSignal} colors={colors} />
              </View>
              <View style={[styles.reasonBox, { backgroundColor: colors.muted }]}>
                <Text style={[styles.reasonText, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>{data.signalReason}</Text>
              </View>
              {data.tradeSignal !== "WAIT" && data.marketOpen && (
                <TouchableOpacity
                  onPress={handleLogTrade}
                  style={[styles.logBtn, { backgroundColor: data.tradeSignal === "CALLS" ? colors.calls : colors.puts }]}
                  activeOpacity={0.85}
                >
                  <Feather name="plus" size={16} color="#fff" />
                  <Text style={[styles.logBtnText, { fontFamily: "Inter_600SemiBold" }]}>Log This Trade</Text>
                </TouchableOpacity>
              )}
            </View>

            {openTrades.length > 0 && data.marketOpen && (
              <>
                <Text style={[styles.sectionLabel, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>OPEN POSITIONS</Text>
                {openTrades.map(t => {
                  const priceDelta = data.currentPrice - t.spyPrice;
                  const directionalDelta = t.signal === "CALLS" ? priceDelta : -priceDelta;
                  const estPnL = directionalDelta * 0.5 * t.contracts * 100;
                  const isUp = directionalDelta >= 0;
                  const pnlColor = isUp ? colors.calls : colors.puts;
                  return (
                    <View key={t.id} style={[styles.pnlCard, { backgroundColor: colors.card, borderColor: isUp ? colors.calls + "55" : colors.puts + "55" }]}>
                      <View style={styles.pnlCardTop}>
                        <View style={[styles.pnlSignalBadge, { backgroundColor: t.signal === "CALLS" ? colors.calls + "22" : colors.puts + "22" }]}>
                          <Text style={[styles.pnlSignalText, { color: t.signal === "CALLS" ? colors.calls : colors.puts, fontFamily: "Inter_700Bold" }]}>
                            {t.signal}
                          </Text>
                        </View>
                        <Text style={[styles.pnlEntry, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                          {t.contracts} contract{t.contracts !== 1 ? "s" : ""} @ ${t.entryPremium.toFixed(2)}
                        </Text>
                        <View style={{ flex: 1 }} />
                        <Text style={[styles.pnlEstimate, { color: pnlColor, fontFamily: "Inter_700Bold" }]}>
                          {isUp ? "+" : ""}${estPnL.toFixed(0)}
                        </Text>
                      </View>
                      <View style={styles.pnlCardBottom}>
                        <View style={styles.pnlPriceRow}>
                          <Text style={[styles.pnlPriceLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>{ticker} entry</Text>
                          <Text style={[styles.pnlPriceVal, { color: colors.foreground, fontFamily: "Inter_500Medium" }]}>${t.spyPrice.toFixed(2)}</Text>
                        </View>
                        <Feather name="arrow-right" size={13} color={colors.mutedForeground} />
                        <View style={styles.pnlPriceRow}>
                          <Text style={[styles.pnlPriceLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>now</Text>
                          <Text style={[styles.pnlPriceVal, { color: colors.foreground, fontFamily: "Inter_500Medium" }]}>${data.currentPrice.toFixed(2)}</Text>
                        </View>
                        <View style={[styles.pnlDeltaBadge, { backgroundColor: pnlColor + "18" }]}>
                          <Text style={[styles.pnlDeltaText, { color: pnlColor, fontFamily: "Inter_600SemiBold" }]}>
                            {isUp ? "▲" : "▼"} ${Math.abs(priceDelta).toFixed(2)}
                          </Text>
                        </View>
                        <View style={{ flex: 1 }} />
                        <Text style={[styles.pnlEstLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>est. (0.5Δ)</Text>
                      </View>
                    </View>
                  );
                })}
              </>
            )}

            <Text style={[styles.sectionLabel, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>INDICATORS</Text>
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <StackRow stack={data.gate2Stack} colors={colors} />
              <PriceRow label="9 EMA" value={data.ema9} colors={colors} />
              <PriceRow label="VWAP" value={data.vwap} colors={colors} />
              <IndicatorRow label="Physical Kiss" ok={data.physicalKissSeen} valueText={data.physicalKissSeen ? "Observed" : "Not yet"} colors={colors} />
              <IndicatorRow label="Rubber Band" ok={data.rubberBandOk} valueText={data.rubberBandOk ? "Within range" : "Stretched"} colors={colors} />
              <IndicatorRow label="Kill Switch" ok={!data.killSwitchActive} valueText={data.killSwitchActive ? "ACTIVE" : "Clear"} colors={colors} />
              <IndicatorRow label="Macro Window" ok={!data.inMacroWindow} valueText={data.inMacroWindow ? "9:55–10:05 ET" : "Clear"} colors={colors} />
            </View>

            <Text style={[styles.sectionLabel, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>RULES</Text>
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <RuleRow num="1" title="Locate Weapon" desc={`Identify ${ticker} on the watchlist`} done={true} colors={colors} />
              <RuleRow num="2" title="Stack Confirmation" desc="Price > 9 EMA > VWAP (BULLISH) or VWAP > 9 EMA > Price (BEARISH)" done={data.gate2Stack !== "NEUTRAL"} colors={colors} />
              <RuleRow num="3" title="Physical Kiss" desc="Price has re-tested the 9 EMA today" done={data.physicalKissSeen} colors={colors} />
              <RuleRow num="4" title="Rubber Band" desc="Price within $0.25 of 9 EMA" done={data.rubberBandOk} colors={colors} />
              <RuleRow num="5" title="Kill Switch Clear" desc="Last candle on correct side of 9 EMA" done={!data.killSwitchActive} colors={colors} />
              <RuleRow num="6" title="Signal Generated" desc="All conditions satisfied for entry" done={data.tradeSignal !== "WAIT"} colors={colors} last />
            </View>

            {formattedTime && (
              <Text style={[styles.timestamp, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                Updated {formattedTime} · auto-refreshes every 5m
              </Text>
            )}
          </>
        ) : null}
      </ScrollView>

      {data && data.tradeSignal !== "WAIT" && (
        <LogTradeModal
          visible={showLog}
          onClose={() => setShowLog(false)}
          signal={data.tradeSignal}
          ticker={ticker}
          tickerPrice={data.currentPrice}
        />
      )}

      <SourcePickerModal
        visible={showSourcePicker}
        onClose={() => setShowSourcePicker(false)}
      />

      <TickerPickerModal
        visible={showTickerPicker}
        currentTicker={ticker}
        onSelect={setTicker}
        onClose={() => setShowTickerPicker(false)}
      />
    </View>
  );
}

function SignalBadge({ signal, colors }: { signal: "CALLS" | "PUTS" | "WAIT"; colors: any }) {
  const color = signal === "CALLS" ? colors.calls : signal === "PUTS" ? colors.puts : colors.wait;
  return (
    <View style={[styles.signalBadge, { backgroundColor: color + "22", borderColor: color }]}>
      <Text style={[styles.signalText, { color, fontFamily: "Inter_700Bold" }]}>{signal}</Text>
    </View>
  );
}

function StackRow({ stack, colors }: { stack: "BULLISH" | "BEARISH" | "NEUTRAL"; colors: any }) {
  const color = stack === "BULLISH" ? colors.calls : stack === "BEARISH" ? colors.puts : colors.wait;
  return (
    <View style={[styles.priceRow, { borderBottomColor: colors.border }]}>
      <Text style={[styles.rowLabel, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>Gate 2 Stack</Text>
      <View style={[styles.stackBadge, { backgroundColor: color + "22" }]}>
        <Text style={[styles.stackText, { color, fontFamily: "Inter_600SemiBold" }]}>{stack}</Text>
      </View>
    </View>
  );
}

function PriceRow({ label, value, colors }: { label: string; value: number; colors: any }) {
  return (
    <View style={[styles.priceRow, { borderBottomColor: colors.border }]}>
      <Text style={[styles.rowLabel, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>${value.toFixed(2)}</Text>
    </View>
  );
}

function IndicatorRow({ label, ok, valueText, colors }: { label: string; ok: boolean; valueText: string; colors: any }) {
  const dotColor = ok ? colors.calls : colors.puts;
  return (
    <View style={[styles.priceRow, { borderBottomColor: colors.border }]}>
      <Text style={[styles.rowLabel, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>{label}</Text>
      <View style={styles.indicatorRight}>
        <Text style={[styles.rowValue, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>{valueText}</Text>
        <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
      </View>
    </View>
  );
}

function RuleRow({ num, title, desc, done, colors, last }: { num: string; title: string; desc: string; done: boolean; colors: any; last?: boolean }) {
  return (
    <View style={[styles.ruleRow, !last && { borderBottomWidth: 1, borderBottomColor: colors.border }]}>
      <View style={[styles.ruleNum, { backgroundColor: done ? colors.primary + "22" : colors.muted }]}>
        <Text style={[styles.ruleNumText, { color: done ? colors.primary : colors.mutedForeground, fontFamily: "Inter_700Bold" }]}>{num}</Text>
      </View>
      <View style={styles.ruleContent}>
        <Text style={[styles.ruleTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>{title}</Text>
        <Text style={[styles.ruleDesc, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>{desc}</Text>
      </View>
      <Feather name={done ? "check-circle" : "circle"} size={18} color={done ? colors.calls : colors.mutedForeground} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", paddingHorizontal: 20, paddingBottom: 14, borderBottomWidth: 1 },
  headerLeft: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerTitle: { fontSize: 26, letterSpacing: -0.5 },
  headerSubtitle: { fontSize: 14 },
  iconBtn: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 20, gap: 12 },
  signalCard: { borderRadius: 16, borderWidth: 1, padding: 20, gap: 14 },
  signalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  priceHero: { fontSize: 40, letterSpacing: -1 },
  priceLabel2: { fontSize: 13, marginTop: 2 },
  signalBadge: { borderRadius: 12, borderWidth: 2, paddingHorizontal: 16, paddingVertical: 8 },
  signalText: { fontSize: 18, letterSpacing: 1 },
  reasonBox: { borderRadius: 10, padding: 12 },
  reasonText: { fontSize: 13, lineHeight: 19 },
  logBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: 12, paddingVertical: 12 },
  logBtnText: { color: "#fff", fontSize: 15 },
  sectionLabel: { fontSize: 11, letterSpacing: 1.5, marginTop: 4, marginLeft: 4 },
  card: { borderRadius: 16, borderWidth: 1, overflow: "hidden" },
  priceRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1 },
  rowLabel: { fontSize: 14 },
  rowValue: { fontSize: 14 },
  indicatorRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  stackBadge: { borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  stackText: { fontSize: 12, letterSpacing: 0.5 },
  ruleRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
  ruleNum: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  ruleNumText: { fontSize: 13 },
  ruleContent: { flex: 1, gap: 2 },
  ruleTitle: { fontSize: 14 },
  ruleDesc: { fontSize: 12, lineHeight: 16 },
  loadingContainer: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 80, gap: 16 },
  loadingText: { fontSize: 15 },
  errorCard: { borderRadius: 16, borderWidth: 1, padding: 24, alignItems: "center", gap: 10, marginTop: 40 },
  errorTitle: { fontSize: 18 },
  errorMsg: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  retryBtn: { marginTop: 8, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 10 },
  retryText: { fontSize: 15 },
  timestamp: { fontSize: 12, textAlign: "center", marginTop: 4 },
  pnlCard: { borderRadius: 14, borderWidth: 1.5, padding: 14, gap: 10 },
  pnlCardTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  pnlCardBottom: { flexDirection: "row", alignItems: "center", gap: 8 },
  pnlSignalBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  pnlSignalText: { fontSize: 12, letterSpacing: 0.5 },
  pnlEntry: { fontSize: 13 },
  pnlEstimate: { fontSize: 20 },
  pnlPriceRow: { gap: 2 },
  pnlPriceLabel: { fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 },
  pnlPriceVal: { fontSize: 13 },
  pnlDeltaBadge: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6 },
  pnlDeltaText: { fontSize: 12 },
  pnlEstLabel: { fontSize: 11 },
  exitBanner: { borderRadius: 14, borderWidth: 2, padding: 16, gap: 10 },
  exitBannerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  exitBannerTitle: { fontSize: 15, letterSpacing: 0.2 },
  exitBannerDetail: { gap: 3, paddingLeft: 28 },
  exitBannerBody: { fontSize: 14 },
  exitBannerSub: { fontSize: 12, lineHeight: 17 },
  marketClosedBanner: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 12, borderWidth: 1, padding: 14 },
  marketClosedRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  marketClosedTitle: { fontSize: 14 },
  marketClosedSub: { fontSize: 12, lineHeight: 17, marginTop: 3 },
  countdownBadge: { fontSize: 13, letterSpacing: 1, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  staleBanner: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 12, borderWidth: 1.5, padding: 14 },
  staleBannerTitle: { fontSize: 13 },
  staleBannerSub: { fontSize: 12, lineHeight: 17, marginTop: 1 },
  staleRetry: { fontSize: 13, paddingHorizontal: 4 },
  macroBanner: { borderRadius: 12, borderWidth: 1.5, padding: 14, gap: 4 },
  macroText: { fontSize: 14 },
  macroSub: { fontSize: 12, lineHeight: 17 },
  modalOverlay: { flex: 1, justifyContent: "flex-end" },
  modalSheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingTop: 12, gap: 16 },
  modalHandle: { width: 40, height: 4, borderRadius: 2, alignSelf: "center", marginBottom: 8 },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  modalTitle: { fontSize: 20 },
  signalPill: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderRadius: 12, borderWidth: 2, paddingHorizontal: 16, paddingVertical: 10 },
  signalPillText: { fontSize: 20, letterSpacing: 1 },
  spyPriceText: { fontSize: 14 },
  fieldGroup: { gap: 6 },
  fieldLabel: { fontSize: 13 },
  input: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  inputMulti: { height: 80, textAlignVertical: "top" },
  saveBtn: { borderRadius: 14, paddingVertical: 16, alignItems: "center", justifyContent: "center", marginTop: 4 },
  saveBtnText: { color: "#fff", fontSize: 16 },
});
