import { useState, useEffect, useCallback } from "react";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";

const STORAGE_KEY = "marketAlertEnabled";
const NOTIFICATION_TAG = "market-open-alert";
const ALERT_MINUTE_OFFSET = 5;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

function getWeekdayAlertDates(daysAhead = 14): Date[] {
  const dates: Date[] = [];
  const now = new Date();

  const etNowParsed = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const etOffset = now.getTime() - etNowParsed.getTime();

  for (let i = 0; i <= daysAhead; i++) {
    const candidate = new Date(now.getTime() + i * 24 * 3600 * 1000);
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
    }).format(candidate);
    if (weekday === "Sat" || weekday === "Sun") continue;

    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(candidate);
    const m: Record<string, string> = {};
    for (const p of parts) m[p.type] = p.value;

    const alertHour = 9;
    const alertMin = 30 - ALERT_MINUTE_OFFSET;
    const etLocalStr = `${m.year}-${m.month}-${m.day}T${String(alertHour).padStart(2, "0")}:${String(alertMin).padStart(2, "0")}:00`;
    const etLocal = new Date(etLocalStr);
    const utcDate = new Date(etLocal.getTime() + etOffset);

    if (utcDate.getTime() > Date.now() + 60_000) {
      dates.push(utcDate);
    }
  }
  return dates;
}

async function scheduleAlerts() {
  if (Platform.OS === "web") return;
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== "granted") return;

  await Notifications.cancelAllScheduledNotificationsAsync();

  const dates = getWeekdayAlertDates();
  for (const date of dates) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "Market Opens in 5 Minutes",
        body: "Check your LE Model signals before the 9:30 AM ET open.",
        data: { tag: NOTIFICATION_TAG },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date },
    });
  }
}

async function cancelAlerts() {
  if (Platform.OS === "web") return;
  await Notifications.cancelAllScheduledNotificationsAsync();
}

export async function sendStopAlert(ticker: string, direction: "CALLS" | "PUTS") {
  if (Platform.OS === "web") return;
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") return;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `${ticker} ${direction} — EXIT NOW`,
      body: `Price closed through the 9 EMA. Close your ${ticker} ${direction} position.`,
      data: { tag: "stop-alert" },
    },
    trigger: null,
  });
}

export function useMarketAlert() {
  const [enabled, setEnabled] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((v) => {
      if (v === "true") setEnabled(true);
    });
  }, []);

  const toggle = useCallback(async () => {
    if (Platform.OS !== "web") {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== "granted") {
        setPermissionDenied(true);
        return;
      }
    }
    setPermissionDenied(false);
    const next = !enabled;
    setEnabled(next);
    await AsyncStorage.setItem(STORAGE_KEY, String(next));
    if (next) {
      await scheduleAlerts();
    } else {
      await cancelAlerts();
    }
  }, [enabled]);

  return { enabled, toggle, permissionDenied };
}
