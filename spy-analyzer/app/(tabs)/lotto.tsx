import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
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
import { useDataSource } from "@/hooks/useDataSource";

const LOTTO_TICKERS = [
  "SNOW", "NVDA", "TSLA", "MSTR", "COIN",
  "AMD",  "PLTR", "META", "HOOD", "ARM",
  "IONQ", "CRWD", "SHOP", "SMCI", "RKLB", "SOFI",
];

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

interface LottoCandidate {
  report: TickerReport;
  confidence: "HIGH" | "MEDIUM";
  suggestedStrike: string;
  suggestedExpiry: string;
  lottoReason: string;
}

function getEtHourMin(): { h: number; m: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  return {
    h: parseInt(parts.find(p => p.type === "hour")?.value ?? "0"),
    m: parseInt(parts.find(p => p.type === "minute")?.value ?? "0"),
  };
}

function isInBuyWindow(): boolean {
  const { h, m } = getEtHourMin();
  const t = h * 60 + m;
  return t >= 15 * 60 && t <= 15 * 60 + 45;
}

function isInSellWindow(): boolean {
  const { h, m } = getEtHourMin();
  const t = h * 60 + m;
  return t >= 9 * 60 + 30 && t <= 10 * 60 + 15;
}

function getNextTradingDay(): string {
  const now = new Date();
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(now);
  const daysToAdd = weekday === "Fri" ? 3 : weekday === "Sat" ? 2 : 1;
  const next = new Date(now.getTime() + daysToAdd * 86400000);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "numeric",
    day: "numeric",
  }).format(next);
}

function getStrikeStep(price: number): number {
  if (price < 20) return 0.5;
  if (price < 50) return 1;
  if (price < 200) return 2.5;
  return 5;
}

function suggestStrike(price: number, direction: "CALLS" | "PUTS"): string {
  const step = getStrikeStep(price);
  const base = Math.round(price / step) * step;
  const strike = direction === "CALLS" ? base + step : base - step;
  const suffix = direction === "CALLS" ? "C" : "P";
  const formatted = strike % 1 === 0 ? strike.toFixed(0) : strike.toFixed(1);
  return `$${formatted}${suffix}`;
}

function computeConfidence(r: TickerReport): "HIGH" | "MEDIUM" | "LOW" {
  if (r.tradeSignal === "WAIT") return "LOW";
  let score = 0;
  if (r.gate2Stack !== "NEUTRAL") score++;
  if (r.physicalKissSeen) score++;
  if (r.rubberBandOk) score++;
  if (!r.killSwitchActive) score++;
  if (score >= 3) return "HIGH";
  if (score >= 2) return "MEDIUM";
  return "LOW";
}

function buildLottoReason(r: TickerReport, confidence: "HIGH" | "MEDIUM"): string {
  const dir = r.tradeSignal === "CALLS" ? "bullish" : "bearish";
  const parts: string[] = [];
  if (r.gate2Stack !== "NEUTRAL") parts.push(r.gate2Stack.toLowerCase() + " stack");
  if (r.physicalKissSeen) parts.push("EMA kiss");
  if (r.rubberBandOk) parts.push("tight to EMA");
  if (!r.killSwitchActive) parts.push("KS clear");
  return `${confidence} conf · ${dir} · ${parts.join(" · ")}`;
}

function useLottoScan(source: string) {
  const [candidates, setCandidates] = useState<LottoCandidate[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastScanned, setLastScanned] = useState<Date | null>(null);

  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      const domain = process.env.EXPO_PUBLIC_DOMAIN;
      const base = domain ? `https://${domain}` : "";
      const nextExpiry = getNextTradingDay();

      const settled = await Promise.allSettled(
        LOTTO_TICKERS.map(t =>
          fetch(`${base}/api/analysis?ticker=${t}&source=${source}`)
            .then(r => (r.ok ? r.json() : Promise.reject()))
            .catch(() => null)
        )
      );

      const hits: LottoCandidate[] = [];
      for (const r of settled) {
        if (r.status !== "fulfilled" || !r.value) continue;
        const report: TickerReport = r.value;
        const confidence = computeConfidence(report);
        if (confidence === "LOW") continue;
        hits.push({
          report,
          confidence,
          suggestedStrike: suggestStrike(report.currentPrice, report.tradeSignal as "CALLS" | "PUTS"),
          suggestedExpiry: nextExpiry,
          lottoReason: buildLottoReason(report, confidence),
        });
      }

      const confOrder: Record<string, number> = { HIGH: 0, MEDIUM: 1 };
      hits.sort((a, b) => confOrder[a.confidence] - confOrder[b.confidence]);
      setCandidates(hits);
      setLastScanned(new Date());
    } catch (e: any) {
      setError(e?.message ?? "Scan failed");
    } finally {
      setScanning(false);
    }
  }, [source]);

  useEffect(() => {
    scan();
    const id = setInterval(scan, 10 * 60 * 1000);
    return () => clearInterval(id);
  }, [scan]);

  return { candidates, scanning, error, rescan: scan, lastScanned };
}

function LogLottoModal({
  visible,
  onClose,
  candidate,
}: {
  visible: boolean;
  onClose: () => void;
  candidate: LottoCandidate | null;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { addTrade } = useJournal();
  const [premium, setPremium] = useState("");
  const [contracts, setContracts] = useState("1");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const isWeb = Platform.OS === "web";

  if (!candidate) return null;
  const { report } = candidate;
  const signalColor = report.tradeSignal === "CALLS" ? colors.calls : colors.puts;

  const handleSave = async () => {
    const premiumVal = parseFloat(premium);
    const contractsVal = parseInt(contracts, 10);
    if (isNaN(premiumVal) || premiumVal <= 0) {
      Alert.alert("Invalid premium", "Enter the option premium (e.g. 0.45)");
      return;
    }
    if (isNaN(contractsVal) || contractsVal <= 0) {
      Alert.alert("Invalid contracts", "Enter a valid number of contracts");
      return;
    }
    setSaving(true);
    await addTrade({
      ticker: report.ticker,
      signal: report.tradeSignal as "CALLS" | "PUTS",
      entryPremium: premiumVal,
      contracts: contractsVal,
      spyPrice: report.currentPrice,
      notes: `LOTTO ${candidate.suggestedStrike} exp ${candidate.suggestedExpiry}${
        notes.trim() ? " · " + notes.trim() : ""
      }`,
    });
    setSaving(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setPremium("");
    setContracts("1");
    setNotes("");
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent presentationStyle="pageSheet">
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <View style={ls.modalOverlay}>
          <View
            style={[
              ls.modalSheet,
              { backgroundColor: colors.card, paddingBottom: isWeb ? 34 : insets.bottom + 16 },
            ]}
          >
            <View style={[ls.modalHandle, { backgroundColor: colors.border }]} />
            <View style={ls.modalHeader}>
              <Text style={[ls.modalTitle, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>
                Log Lotto Trade
              </Text>
              <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
                <Feather name="x" size={22} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>

            <View style={[ls.lottoPill, { backgroundColor: signalColor + "18", borderColor: signalColor }]}>
              <View>
                <Text style={[ls.lottoPillTicker, { color: signalColor, fontFamily: "Inter_700Bold" }]}>
                  {report.ticker} {candidate.suggestedStrike}
                </Text>
                <Text style={[ls.lottoPillSub, { color: signalColor, fontFamily: "Inter_400Regular" }]}>
                  Exp {candidate.suggestedExpiry} · Sell Tomorrow AM
                </Text>
              </View>
              <Text style={[ls.lottoPillPrice, { color: signalColor, fontFamily: "Inter_700Bold" }]}>
                ${report.currentPrice.toFixed(2)}
              </Text>
            </View>

            <View style={ls.fieldGroup}>
              <Text style={[ls.fieldLabel, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
                Option Premium (per contract)
              </Text>
              <TextInput
                style={[
                  ls.input,
                  { backgroundColor: colors.muted, color: colors.foreground, borderColor: colors.border, fontFamily: "Inter_400Regular" },
                ]}
                placeholder="e.g. 0.45"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="decimal-pad"
                value={premium}
                onChangeText={setPremium}
                autoFocus
              />
            </View>

            <View style={ls.fieldGroup}>
              <Text style={[ls.fieldLabel, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
                Contracts
              </Text>
              <TextInput
                style={[
                  ls.input,
                  { backgroundColor: colors.muted, color: colors.foreground, borderColor: colors.border, fontFamily: "Inter_400Regular" },
                ]}
                placeholder="1"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="number-pad"
                value={contracts}
                onChangeText={setContracts}
              />
            </View>

            <View style={ls.fieldGroup}>
              <Text style={[ls.fieldLabel, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
                Notes (optional)
              </Text>
              <TextInput
                style={[
                  ls.input,
                  ls.inputMulti,
                  { backgroundColor: colors.muted, color: colors.foreground, borderColor: colors.border, fontFamily: "Inter_400Regular" },
                ]}
                placeholder="Catalyst, setup reason…"
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
              style={[ls.saveBtn, { backgroundColor: signalColor }]}
              activeOpacity={0.85}
            >
              {saving ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={[ls.saveBtnText, { fontFamily: "Inter_700Bold" }]}>
                  Log Lotto {report.tradeSignal}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function CandidateCard({
  candidate,
  onLog,
  colors,
  inBuyWindow,
}: {
  candidate: LottoCandidate;
  onLog: () => void;
  colors: any;
  inBuyWindow: boolean;
}) {
  const { report, confidence, suggestedStrike, suggestedExpiry, lottoReason } = candidate;
  const dirColor = report.tradeSignal === "CALLS" ? colors.calls : colors.puts;
  const confColor = confidence === "HIGH" ? colors.calls : colors.wait;

  return (
    <View style={[ls.candidateCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={ls.candidateTop}>
        <View>
          <Text style={[ls.candidateTicker, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>
            {report.ticker}
          </Text>
          <Text style={[ls.candidatePrice, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
            ${report.currentPrice.toFixed(2)}
          </Text>
        </View>
        <View style={ls.badges}>
          <View style={[ls.dirBadge, { backgroundColor: dirColor + "22", borderColor: dirColor }]}>
            <Text style={[ls.dirBadgeText, { color: dirColor, fontFamily: "Inter_700Bold" }]}>
              {report.tradeSignal}
            </Text>
          </View>
          <View style={[ls.confBadge, { backgroundColor: confColor + "18" }]}>
            <Text style={[ls.confBadgeText, { color: confColor, fontFamily: "Inter_600SemiBold" }]}>
              {confidence}
            </Text>
          </View>
        </View>
      </View>

      <View style={[ls.strikeRow, { backgroundColor: colors.muted }]}>
        <View style={ls.strikeCell}>
          <Text style={[ls.strikeLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>Strike</Text>
          <Text style={[ls.strikeVal, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>{suggestedStrike}</Text>
        </View>
        <View style={[ls.strikeDivider, { backgroundColor: colors.border }]} />
        <View style={ls.strikeCell}>
          <Text style={[ls.strikeLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>Expiry</Text>
          <Text style={[ls.strikeVal, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>{suggestedExpiry}</Text>
        </View>
        <View style={[ls.strikeDivider, { backgroundColor: colors.border }]} />
        <View style={ls.strikeCell}>
          <Text style={[ls.strikeLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>EMA9</Text>
          <Text style={[ls.strikeVal, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>${report.ema9.toFixed(2)}</Text>
        </View>
        <View style={[ls.strikeDivider, { backgroundColor: colors.border }]} />
        <View style={ls.strikeCell}>
          <Text style={[ls.strikeLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>Exit</Text>
          <Text style={[ls.strikeVal, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>AM Open</Text>
        </View>
      </View>

      <Text style={[ls.candidateReason, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
        {lottoReason}
      </Text>

      <TouchableOpacity
        onPress={onLog}
        style={[ls.logBtn, { backgroundColor: dirColor }]}
        activeOpacity={0.85}
      >
        <Feather name="zap" size={14} color="#fff" />
        <Text style={[ls.logBtnText, { fontFamily: "Inter_600SemiBold" }]}>
          {inBuyWindow ? "Log Lotto Trade" : "Pre-Log Trade"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

export default function LottoScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { source } = useDataSource();
  const { candidates, scanning, error, rescan, lastScanned } = useLottoScan(source);
  const [selectedCandidate, setSelectedCandidate] = useState<LottoCandidate | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [now, setNow] = useState(Date.now());

  const isWeb = Platform.OS === "web";
  const topPad = isWeb ? 67 : insets.top;
  const bottomPad = isWeb ? 34 : insets.bottom;

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const inBuyWindow = isInBuyWindow();
  const inSellWindow = isInSellWindow();
  const nextExpiry = getNextTradingDay();

  const today = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(now));

  const handleLog = useCallback((c: LottoCandidate) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSelectedCandidate(c);
    setShowModal(true);
  }, []);

  const handleRescan = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await rescan();
  }, [rescan]);

  const scannedAt = lastScanned
    ? lastScanned.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <View style={[ls.root, { backgroundColor: colors.background }]}>
      <View
        style={[
          ls.header,
          { paddingTop: topPad + 12, backgroundColor: colors.surface, borderBottomColor: colors.border },
        ]}
      >
        <View>
          <Text style={[ls.headerTitle, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>
            Lotto Options
          </Text>
          <Text style={[ls.headerSub, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
            Buy Today · Sell Tomorrow AM
          </Text>
        </View>
        <TouchableOpacity
          onPress={handleRescan}
          disabled={scanning}
          style={[ls.iconBtn, { backgroundColor: colors.muted }]}
          activeOpacity={0.7}
        >
          {scanning ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Feather name="refresh-cw" size={18} color={colors.primary} />
          )}
        </TouchableOpacity>
      </View>

      <ScrollView
        style={ls.scroll}
        contentContainerStyle={[ls.scrollContent, { paddingBottom: bottomPad + 100 }]}
        showsVerticalScrollIndicator={false}
      >
        {inBuyWindow ? (
          <View style={[ls.windowBanner, { backgroundColor: colors.calls + "18", borderColor: colors.calls }]}>
            <Feather name="clock" size={16} color={colors.calls} />
            <View style={{ flex: 1 }}>
              <Text style={[ls.windowTitle, { color: colors.calls, fontFamily: "Inter_700Bold" }]}>
                Buy Window Active — 3:00–3:45 PM ET
              </Text>
              <Text style={[ls.windowSub, { color: colors.calls, fontFamily: "Inter_400Regular" }]}>
                Enter lotto positions now. Target {nextExpiry} expiry.
              </Text>
            </View>
          </View>
        ) : inSellWindow ? (
          <View style={[ls.windowBanner, { backgroundColor: colors.puts + "18", borderColor: colors.puts }]}>
            <Feather name="trending-up" size={16} color={colors.puts} />
            <View style={{ flex: 1 }}>
              <Text style={[ls.windowTitle, { color: colors.puts, fontFamily: "Inter_700Bold" }]}>
                Sell Window Active — 9:30–10:15 AM ET
              </Text>
              <Text style={[ls.windowSub, { color: colors.puts, fontFamily: "Inter_400Regular" }]}>
                Exit overnight lotto positions. Take profits or cut losses.
              </Text>
            </View>
          </View>
        ) : (
          <View style={[ls.strategyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={ls.strategyRow}>
              <View style={[ls.strategyStep, { backgroundColor: colors.calls + "18", borderColor: colors.calls }]}>
                <Feather name="shopping-cart" size={15} color={colors.calls} />
                <Text style={[ls.strategyStepLabel, { color: colors.calls, fontFamily: "Inter_700Bold" }]}>BUY</Text>
                <Text style={[ls.strategyStepTime, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                  3:00–3:45 PM ET
                </Text>
              </View>
              <Feather name="arrow-right" size={16} color={colors.mutedForeground} />
              <View style={[ls.strategyStep, { backgroundColor: colors.puts + "18", borderColor: colors.puts }]}>
                <Feather name="dollar-sign" size={15} color={colors.puts} />
                <Text style={[ls.strategyStepLabel, { color: colors.puts, fontFamily: "Inter_700Bold" }]}>SELL</Text>
                <Text style={[ls.strategyStepTime, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                  Next AM Open
                </Text>
              </View>
            </View>
            <Text style={[ls.strategyNote, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
              Cheap OTM options held overnight for next-day gap or momentum. Target 50–200% return. Size small — full losses happen.
            </Text>
          </View>
        )}

        {error ? (
          <View style={[ls.errorCard, { backgroundColor: colors.card, borderColor: colors.puts }]}>
            <Feather name="alert-circle" size={28} color={colors.puts} />
            <Text style={[ls.errorTitle, { color: colors.puts, fontFamily: "Inter_600SemiBold" }]}>Scan failed</Text>
            <Text style={[ls.errorMsg, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>{error}</Text>
            <TouchableOpacity
              onPress={handleRescan}
              style={[ls.retryBtn, { backgroundColor: colors.puts }]}
              activeOpacity={0.8}
            >
              <Text style={[ls.retryText, { color: "#fff", fontFamily: "Inter_600SemiBold" }]}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : scanning && candidates.length === 0 ? (
          <View style={ls.loadingContainer}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={[ls.loadingText, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
              Scanning {LOTTO_TICKERS.length} tickers for lotto setups…
            </Text>
          </View>
        ) : (
          <>
            <View style={ls.sectionHeader}>
              <Text style={[ls.sectionLabel, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
                LOTTO CANDIDATES · {today}
              </Text>
              {scannedAt && (
                <Text style={[ls.scannedAt, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                  scanned {scannedAt}
                </Text>
              )}
            </View>

            {candidates.length === 0 ? (
              <View style={[ls.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Feather name="search" size={32} color={colors.mutedForeground} />
                <Text style={[ls.emptyTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
                  No lotto setups found
                </Text>
                <Text style={[ls.emptyDesc, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                  No high or medium confidence signals across {LOTTO_TICKERS.length} tickers. Try again closer to market close.
                </Text>
              </View>
            ) : (
              candidates.map(c => (
                <CandidateCard
                  key={c.report.ticker}
                  candidate={c}
                  onLog={() => handleLog(c)}
                  colors={colors}
                  inBuyWindow={inBuyWindow}
                />
              ))
            )}
          </>
        )}
      </ScrollView>

      <LogLottoModal
        visible={showModal}
        onClose={() => setShowModal(false)}
        candidate={selectedCandidate}
      />
    </View>
  );
}

const ls = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 26, letterSpacing: -0.5 },
  headerSub: { fontSize: 13, marginTop: 1 },
  iconBtn: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 20, gap: 12 },

  windowBanner: { flexDirection: "row", alignItems: "flex-start", gap: 10, borderRadius: 14, borderWidth: 1.5, padding: 14 },
  windowTitle: { fontSize: 14 },
  windowSub: { fontSize: 12, lineHeight: 17, marginTop: 2 },

  strategyCard: { borderRadius: 14, borderWidth: 1, padding: 16, gap: 14 },
  strategyRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  strategyStep: { flex: 1, alignItems: "center", gap: 4, borderRadius: 12, borderWidth: 1.5, padding: 12 },
  strategyStepLabel: { fontSize: 16 },
  strategyStepTime: { fontSize: 11, textAlign: "center" },
  strategyNote: { fontSize: 12, lineHeight: 18 },

  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 4,
    marginBottom: -4,
  },
  sectionLabel: { fontSize: 11, letterSpacing: 1.5 },
  scannedAt: { fontSize: 11 },

  loadingContainer: { alignItems: "center", justifyContent: "center", paddingTop: 60, gap: 14 },
  loadingText: { fontSize: 14 },

  errorCard: { borderRadius: 14, borderWidth: 1, padding: 24, alignItems: "center", gap: 10, marginTop: 20 },
  errorTitle: { fontSize: 17 },
  errorMsg: { fontSize: 13, textAlign: "center", lineHeight: 19 },
  retryBtn: { marginTop: 4, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 10 },
  retryText: { fontSize: 14 },

  emptyCard: { borderRadius: 14, borderWidth: 1, padding: 28, alignItems: "center", gap: 10, marginTop: 10 },
  emptyTitle: { fontSize: 17 },
  emptyDesc: { fontSize: 13, textAlign: "center", lineHeight: 19 },

  candidateCard: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 12 },
  candidateTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  candidateTicker: { fontSize: 22, letterSpacing: -0.3 },
  candidatePrice: { fontSize: 14, marginTop: 2 },
  badges: { flexDirection: "row", gap: 6, alignItems: "center" },
  dirBadge: { borderRadius: 10, borderWidth: 2, paddingHorizontal: 14, paddingVertical: 6 },
  dirBadgeText: { fontSize: 14, letterSpacing: 0.5 },
  confBadge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  confBadgeText: { fontSize: 11, letterSpacing: 0.5 },

  strikeRow: { flexDirection: "row", borderRadius: 10, overflow: "hidden" },
  strikeCell: { flex: 1, alignItems: "center", paddingVertical: 10, gap: 3 },
  strikeLabel: { fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 },
  strikeVal: { fontSize: 13 },
  strikeDivider: { width: 1 },

  candidateReason: { fontSize: 12, lineHeight: 17 },

  logBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 12,
    paddingVertical: 12,
  },
  logBtnText: { color: "#fff", fontSize: 14 },

  modalOverlay: { flex: 1, justifyContent: "flex-end" },
  modalSheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingTop: 12, gap: 16 },
  modalHandle: { width: 40, height: 4, borderRadius: 2, alignSelf: "center", marginBottom: 8 },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  modalTitle: { fontSize: 20 },
  lottoPill: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 2,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  lottoPillTicker: { fontSize: 18 },
  lottoPillSub: { fontSize: 12, marginTop: 2 },
  lottoPillPrice: { fontSize: 22 },
  fieldGroup: { gap: 6 },
  fieldLabel: { fontSize: 13 },
  input: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  inputMulti: { height: 80, textAlignVertical: "top" },
  saveBtn: { borderRadius: 14, paddingVertical: 16, alignItems: "center", marginTop: 4 },
  saveBtnText: { color: "#fff", fontSize: 16 },
});
