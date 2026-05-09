import React, { useState, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  StyleSheet,
  TextInput,
  Platform,
  KeyboardAvoidingView,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { POPULAR_TICKERS } from "@/hooks/useTicker";

export function TickerPickerModal({
  visible,
  currentTicker,
  onSelect,
  onClose,
}: {
  visible: boolean;
  currentTicker: string;
  onSelect: (ticker: string) => void;
  onClose: () => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [custom, setCustom] = useState("");
  const inputRef = useRef<TextInput>(null);
  const bottomPad = Platform.OS === "web" ? 24 : insets.bottom + 8;

  const handleSelect = (t: string) => {
    const clean = t.toUpperCase().trim();
    if (!clean) return;
    onSelect(clean);
    setCustom("");
    onClose();
  };

  const handleCustomSubmit = () => {
    if (custom.trim()) handleSelect(custom);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.kav}>
        <View style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: bottomPad }]}>
          <View style={[styles.handle, { backgroundColor: colors.border }]} />
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>
              Select Ticker
            </Text>
            <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
              <Feather name="x" size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          <Text style={[styles.sectionLabel, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
            POPULAR
          </Text>
          <View style={styles.grid}>
            {POPULAR_TICKERS.map(t => {
              const active = t === currentTicker;
              return (
                <TouchableOpacity
                  key={t}
                  onPress={() => handleSelect(t)}
                  activeOpacity={0.7}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: active ? colors.primary + "20" : colors.muted,
                      borderColor: active ? colors.primary : colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      {
                        color: active ? colors.primary : colors.foreground,
                        fontFamily: active ? "Inter_700Bold" : "Inter_500Medium",
                      },
                    ]}
                  >
                    {t}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text
            style={[
              styles.sectionLabel,
              { color: colors.mutedForeground, fontFamily: "Inter_500Medium", marginTop: 20 },
            ]}
          >
            CUSTOM TICKER
          </Text>
          <View style={styles.inputRow}>
            <TextInput
              ref={inputRef}
              style={[
                styles.input,
                {
                  backgroundColor: colors.muted,
                  color: colors.foreground,
                  borderColor: colors.border,
                  fontFamily: "Inter_600SemiBold",
                },
              ]}
              placeholder="e.g. CRWD, HOOD, RKLB"
              placeholderTextColor={colors.mutedForeground}
              value={custom}
              onChangeText={v => setCustom(v.toUpperCase())}
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={handleCustomSubmit}
              maxLength={6}
            />
            <TouchableOpacity
              onPress={handleCustomSubmit}
              disabled={!custom.trim()}
              style={[
                styles.goBtn,
                { backgroundColor: custom.trim() ? colors.primary : colors.muted },
              ]}
              activeOpacity={0.8}
            >
              <Text
                style={[
                  styles.goBtnText,
                  {
                    color: custom.trim() ? colors.primaryForeground : colors.mutedForeground,
                    fontFamily: "Inter_700Bold",
                  },
                ]}
              >
                Go
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  kav: { justifyContent: "flex-end" },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingTop: 12, gap: 0 },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: "center", marginBottom: 16 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  title: { fontSize: 18 },
  sectionLabel: { fontSize: 11, letterSpacing: 1.5, marginBottom: 10 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { borderRadius: 10, borderWidth: 1.5, paddingHorizontal: 14, paddingVertical: 9 },
  chipText: { fontSize: 14, letterSpacing: 0.3 },
  inputRow: { flexDirection: "row", gap: 10, alignItems: "center" },
  input: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    letterSpacing: 0.5,
  },
  goBtn: { borderRadius: 10, paddingHorizontal: 20, paddingVertical: 12 },
  goBtnText: { fontSize: 15 },
});
