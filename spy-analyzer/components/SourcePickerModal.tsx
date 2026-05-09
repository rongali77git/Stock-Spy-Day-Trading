import React from "react";
import {
  View, Text, TouchableOpacity, Modal, StyleSheet, ActivityIndicator, Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useDataSource, type DataSourceId, type DataSourceInfo } from "@/hooks/useDataSource";

const SOURCE_ICONS: Record<string, "cloud" | "zap" | "trending-up"> = {
  yahoo: "cloud",
  polygon: "trending-up",
  alpaca: "zap",
};

const SOURCE_DELAYS: Record<string, string> = {
  yahoo: "~2 min lag",
  polygon: "15 min (free) / live (paid)",
  alpaca: "Real-time IEX",
};

function SourceRow({
  info,
  selected,
  onSelect,
  colors,
}: {
  info: DataSourceInfo;
  selected: boolean;
  onSelect: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  const icon = SOURCE_ICONS[info.id] ?? "cloud";
  const disabled = !info.available;

  return (
    <TouchableOpacity
      onPress={onSelect}
      disabled={disabled}
      activeOpacity={0.7}
      style={[
        styles.row,
        {
          backgroundColor: selected ? colors.primary + "12" : colors.muted,
          borderColor: selected ? colors.primary : colors.border,
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      <View style={[styles.rowIcon, { backgroundColor: selected ? colors.primary + "20" : colors.border }]}>
        <Feather name={icon} size={17} color={selected ? colors.primary : colors.mutedForeground} />
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={[styles.rowName, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
            {info.name}
          </Text>
          {info.available ? (
            <View style={[styles.pill, { backgroundColor: colors.calls + "18" }]}>
              <Text style={[styles.pillText, { color: colors.calls, fontFamily: "Inter_600SemiBold" }]}>
                Ready
              </Text>
            </View>
          ) : (
            <View style={[styles.pill, { backgroundColor: colors.border }]}>
              <Text style={[styles.pillText, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
                Setup needed
              </Text>
            </View>
          )}
        </View>
        <Text style={[styles.rowDelay, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
          {SOURCE_DELAYS[info.id] ?? info.delay}
        </Text>
        {!info.available && (
          <Text style={[styles.rowNote, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
            {info.note}
          </Text>
        )}
      </View>
      {selected && (
        <Feather name="check-circle" size={20} color={colors.primary} style={{ marginLeft: 4 }} />
      )}
    </TouchableOpacity>
  );
}

export function SourcePickerModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { source, sources, setSource, loadingSources } = useDataSource();
  const bottomPad = Platform.OS === "web" ? 24 : insets.bottom + 8;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: bottomPad }]}>
        <View style={[styles.handle, { backgroundColor: colors.border }]} />
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>
            Data Source
          </Text>
          <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
            <Feather name="x" size={20} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>

        <Text style={[styles.subtitle, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
          Choose where 5-minute bars are fetched from. Polygon and Alpaca require API keys set as server environment variables.
        </Text>

        {loadingSources ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
        ) : (
          <View style={styles.list}>
            {sources.map(s => (
              <SourceRow
                key={s.id}
                info={s}
                selected={source === s.id}
                colors={colors}
                onSelect={async () => {
                  if (s.available) {
                    await setSource(s.id as DataSourceId);
                    onClose();
                  }
                }}
              />
            ))}
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingTop: 12, gap: 0 },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: "center", marginBottom: 16 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  title: { fontSize: 18 },
  subtitle: { fontSize: 13, lineHeight: 19, marginBottom: 20 },
  list: { gap: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 14, borderWidth: 1.5, padding: 14 },
  rowIcon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  rowBody: { flex: 1, gap: 3 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowName: { fontSize: 15 },
  rowDelay: { fontSize: 12 },
  rowNote: { fontSize: 11, lineHeight: 16, marginTop: 2 },
  pill: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6 },
  pillText: { fontSize: 11 },
});
