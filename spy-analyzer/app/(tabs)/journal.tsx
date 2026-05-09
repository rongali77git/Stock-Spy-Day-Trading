import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Alert,
  Modal,
  TextInput,
  KeyboardAvoidingView,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { useJournal } from "@/context/JournalContext";
import { calcPnL, type Trade } from "@/constants/types";

function CloseTradeModal({
  trade,
  onClose,
}: {
  trade: Trade | null;
  onClose: () => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { closeTrade } = useJournal();
  const [exit, setExit] = useState("");
  const [saving, setSaving] = useState(false);
  const isWeb = Platform.OS === "web";

  if (!trade) return null;

  const signalColor = trade.signal === "CALLS" ? colors.calls : colors.puts;

  const handleClose = async () => {
    const exitVal = parseFloat(exit);
    if (isNaN(exitVal) || exitVal < 0) {
      Alert.alert("Invalid exit", "Enter a valid exit premium (e.g. 3.75)");
      return;
    }
    setSaving(true);
    await closeTrade(trade.id, exitVal);
    setSaving(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setExit("");
    onClose();
  };

  const estPnL = exit !== "" ? (parseFloat(exit) - trade.entryPremium) * trade.contracts * 100 : null;
  const pnlColor = estPnL == null ? colors.mutedForeground : estPnL >= 0 ? colors.calls : colors.puts;

  return (
    <Modal visible animationType="slide" transparent presentationStyle="pageSheet">
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { backgroundColor: colors.card, paddingBottom: isWeb ? 34 : insets.bottom + 16 }]}>
            <View style={[styles.modalHandle, { backgroundColor: colors.border }]} />
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>Close Trade</Text>
              <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
                <Feather name="x" size={22} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>

            <View style={[styles.tradeSummary, { backgroundColor: colors.muted, borderRadius: 12 }]}>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={[styles.summaryLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>Ticker</Text>
                <Text style={[styles.summaryValue, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>{trade.ticker}</Text>
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={[styles.summaryLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>Signal</Text>
                <Text style={[styles.summaryValue, { color: signalColor, fontFamily: "Inter_700Bold" }]}>{trade.signal}</Text>
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={[styles.summaryLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>Entry Premium</Text>
                <Text style={[styles.summaryValue, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>${trade.entryPremium.toFixed(2)}</Text>
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={[styles.summaryLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>Contracts</Text>
                <Text style={[styles.summaryValue, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>{trade.contracts}</Text>
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>Exit Premium (per contract)</Text>
              <TextInput
                style={[styles.input, { backgroundColor: colors.muted, color: colors.foreground, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
                placeholder="e.g. 3.75"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="decimal-pad"
                value={exit}
                onChangeText={setExit}
                autoFocus
              />
            </View>

            {estPnL != null && (
              <View style={[styles.estPnL, { backgroundColor: pnlColor + "18" }]}>
                <Text style={[styles.estPnLLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>Est. P&L</Text>
                <Text style={[styles.estPnLValue, { color: pnlColor, fontFamily: "Inter_700Bold" }]}>
                  {estPnL >= 0 ? "+" : ""}${estPnL.toFixed(2)}
                </Text>
              </View>
            )}

            <TouchableOpacity
              onPress={handleClose}
              disabled={saving}
              style={[styles.saveBtn, { backgroundColor: signalColor }]}
              activeOpacity={0.85}
            >
              {saving ? <ActivityIndicator color="#fff" /> : (
                <Text style={[styles.saveBtnText, { fontFamily: "Inter_700Bold" }]}>Close Trade</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function StatsBar({ colors }: { colors: any }) {
  const { stats } = useJournal();
  const pnlColor = stats.totalPnL >= 0 ? colors.calls : colors.puts;
  return (
    <View style={[styles.statsBar, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
      <StatItem label="Trades" value={`${stats.closedTrades}`} color={colors.foreground} colors={colors} />
      <View style={[styles.statsDivider, { backgroundColor: colors.border }]} />
      <StatItem label="Win Rate" value={stats.closedTrades > 0 ? `${Math.round(stats.winRate * 100)}%` : "—"} color={stats.winRate >= 0.5 ? colors.calls : colors.puts} colors={colors} />
      <View style={[styles.statsDivider, { backgroundColor: colors.border }]} />
      <StatItem
        label="Total P&L"
        value={stats.closedTrades > 0 ? `${stats.totalPnL >= 0 ? "+" : ""}$${Math.abs(stats.totalPnL).toFixed(0)}` : "—"}
        color={pnlColor}
        colors={colors}
      />
    </View>
  );
}

function StatItem({ label, value, color, colors }: { label: string; value: string; color: string; colors: any }) {
  return (
    <View style={styles.statItem}>
      <Text style={[styles.statValue, { color, fontFamily: "Inter_700Bold" }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>{label}</Text>
    </View>
  );
}

function TradeCard({ trade, onClosePress, onDeletePress, colors }: { trade: Trade; onClosePress: () => void; onDeletePress: () => void; colors: any }) {
  const pnl = calcPnL(trade);
  const signalColor = trade.signal === "CALLS" ? colors.calls : colors.puts;
  const pnlColor = pnl == null ? colors.mutedForeground : pnl >= 0 ? colors.calls : colors.puts;
  const date = new Date(trade.date);
  const dateStr = date.toLocaleDateString([], { month: "short", day: "numeric" });
  const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <View style={[styles.tradeCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.tradeCardTop}>
        <View style={styles.tradeCardLeft}>
          <View style={[styles.tickerTag, { backgroundColor: colors.muted, borderColor: colors.border }]}>
            <Text style={[styles.tickerTagText, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>{trade.ticker}</Text>
          </View>
          <View style={[styles.signalTag, { backgroundColor: signalColor + "22" }]}>
            <Text style={[styles.signalTagText, { color: signalColor, fontFamily: "Inter_700Bold" }]}>{trade.signal}</Text>
          </View>
          <View style={[styles.statusTag, { backgroundColor: trade.status === "OPEN" ? colors.wait + "22" : colors.muted }]}>
            <Text style={[styles.statusTagText, { color: trade.status === "OPEN" ? colors.wait : colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
              {trade.status}
            </Text>
          </View>
        </View>
        {pnl != null ? (
          <Text style={[styles.pnlValue, { color: pnlColor, fontFamily: "Inter_700Bold" }]}>
            {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
          </Text>
        ) : (
          <Text style={[styles.pnlOpen, { color: colors.wait, fontFamily: "Inter_600SemiBold" }]}>Open</Text>
        )}
      </View>

      <View style={styles.tradeDetails}>
        <Text style={[styles.detailText, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
          {trade.ticker} ${trade.spyPrice.toFixed(2)} · Entry ${trade.entryPremium.toFixed(2)} · {trade.contracts}x contract{trade.contracts > 1 ? "s" : ""}
          {trade.exitPremium != null ? ` · Exit ${trade.exitPremium.toFixed(2)}` : ""}
        </Text>
        <Text style={[styles.detailText, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
          {dateStr} at {timeStr}
        </Text>
        {trade.notes ? (
          <Text style={[styles.noteText, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]} numberOfLines={2}>
            {trade.notes}
          </Text>
        ) : null}
      </View>

      <View style={[styles.tradeCardActions, { borderTopColor: colors.border }]}>
        {trade.status === "OPEN" && (
          <TouchableOpacity onPress={onClosePress} style={[styles.actionBtn, { backgroundColor: signalColor + "18" }]} activeOpacity={0.7}>
            <Feather name="check" size={14} color={signalColor} />
            <Text style={[styles.actionBtnText, { color: signalColor, fontFamily: "Inter_600SemiBold" }]}>Close</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={onDeletePress} style={[styles.actionBtn, { backgroundColor: colors.destructive + "18" }]} activeOpacity={0.7}>
          <Feather name="trash-2" size={14} color={colors.destructive} />
          <Text style={[styles.actionBtnText, { color: colors.destructive, fontFamily: "Inter_600SemiBold" }]}>Delete</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function JournalScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { trades, loading, deleteTrade } = useJournal();
  const [closing, setClosing] = useState<Trade | null>(null);

  const isWeb = Platform.OS === "web";
  const topPad = isWeb ? 67 : insets.top;
  const bottomPad = isWeb ? 34 : insets.bottom;

  const handleDelete = useCallback(
    (trade: Trade) => {
      Alert.alert("Delete Trade", "Remove this trade from your journal?", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            await deleteTrade(trade.id);
          },
        },
      ]);
    },
    [deleteTrade]
  );

  const renderItem = useCallback(
    ({ item }: { item: Trade }) => (
      <TradeCard
        trade={item}
        onClosePress={() => setClosing(item)}
        onDeletePress={() => handleDelete(item)}
        colors={colors}
      />
    ),
    [colors, handleDelete]
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 12, backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <Text style={[styles.headerTitle, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>Journal</Text>
      </View>

      <StatsBar colors={colors} />

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={trades}
          keyExtractor={t => t.id}
          renderItem={renderItem}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: bottomPad + 100 },
            trades.length === 0 && styles.emptyContainer,
          ]}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Feather name="book-open" size={40} color={colors.mutedForeground} />
              <Text style={[styles.emptyTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>No trades yet</Text>
              <Text style={[styles.emptyDesc, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                When the analyzer signals CALLS or PUTS, tap “Log This Trade” to record your entry.
              </Text>
            </View>
          }
        />
      )}

      <CloseTradeModal trade={closing} onClose={() => setClosing(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { paddingHorizontal: 20, paddingBottom: 14, borderBottomWidth: 1 },
  headerTitle: { fontSize: 26, letterSpacing: -0.5 },
  statsBar: { flexDirection: "row", alignItems: "center", paddingVertical: 16, paddingHorizontal: 20, borderBottomWidth: 1 },
  statItem: { flex: 1, alignItems: "center", gap: 2 },
  statValue: { fontSize: 20 },
  statLabel: { fontSize: 12 },
  statsDivider: { width: 1, height: 32, marginHorizontal: 8 },
  listContent: { paddingHorizontal: 16, paddingTop: 16, gap: 12 },
  emptyContainer: { flex: 1, justifyContent: "center" },
  emptyState: { alignItems: "center", gap: 10, paddingTop: 40, paddingHorizontal: 40 },
  emptyTitle: { fontSize: 18 },
  emptyDesc: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  loadingContainer: { flex: 1, alignItems: "center", justifyContent: "center" },
  tradeCard: { borderRadius: 16, borderWidth: 1, overflow: "hidden" },
  tradeCardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, paddingBottom: 10 },
  tradeCardLeft: { flexDirection: "row", gap: 6, flexWrap: "wrap", flex: 1, marginRight: 8 },
  tickerTag: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4 },
  tickerTagText: { fontSize: 12, letterSpacing: 0.5 },
  signalTag: { borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  signalTagText: { fontSize: 13, letterSpacing: 0.5 },
  statusTag: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  statusTagText: { fontSize: 12 },
  pnlValue: { fontSize: 20 },
  pnlOpen: { fontSize: 15 },
  tradeDetails: { paddingHorizontal: 16, paddingBottom: 12, gap: 4 },
  detailText: { fontSize: 13, lineHeight: 18 },
  noteText: { fontSize: 13, lineHeight: 18, marginTop: 2, fontStyle: "italic" },
  tradeCardActions: { flexDirection: "row", borderTopWidth: 1, padding: 12, gap: 8 },
  actionBtn: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  actionBtnText: { fontSize: 13 },
  modalOverlay: { flex: 1, justifyContent: "flex-end" },
  modalSheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingTop: 12, gap: 16 },
  modalHandle: { width: 40, height: 4, borderRadius: 2, alignSelf: "center", marginBottom: 8 },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  modalTitle: { fontSize: 20 },
  tradeSummary: { padding: 14, gap: 8 },
  summaryLabel: { fontSize: 14 },
  summaryValue: { fontSize: 14 },
  fieldGroup: { gap: 6 },
  fieldLabel: { fontSize: 13 },
  input: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  estPnL: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12 },
  estPnLLabel: { fontSize: 14 },
  estPnLValue: { fontSize: 22 },
  saveBtn: { borderRadius: 14, paddingVertical: 16, alignItems: "center", justifyContent: "center", marginTop: 4 },
  saveBtnText: { color: "#fff", fontSize: 16 },
});
