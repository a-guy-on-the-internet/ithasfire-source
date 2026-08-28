import { useCallback, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  SquareSecondaryButton,
  useColors,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import { useAuthSession } from "@/features/auth/use-auth-session";
import { usePushRegistration } from "@/features/notifications/use-push-registration";
import {
  ScreenHeading,
  ScreenSurface,
  SectionNum,
  SquareDangerButton,
} from "@/ui/primitives";

/**
 * Notifications opt-in row. Push permission is requested HERE (explicit user
 * tap) rather than at cold start — the lifecycle hook only registers tokens
 * when permission was already granted.
 *
 * States:
 *   - loading      → subdued placeholder
 *   - undetermined → "Enable notifications" (triggers the OS prompt)
 *   - denied       → status + "Open system settings" (never re-nag)
 *   - granted      → status only; registration happens automatically
 */
const NotificationsRow = () => {
  const { permission, requestPermission, openSystemSettings } =
    usePushRegistration();
  const styles = useThemedSheet(makeSheet);
  const [requesting, setRequesting] = useState(false);

  const handleEnable = useCallback(async () => {
    setRequesting(true);
    try {
      await requestPermission();
    } finally {
      setRequesting(false);
    }
  }, [requestPermission]);

  const statusLabel =
    permission === null
      ? "Checking…"
      : permission.status === "granted"
        ? "Enabled"
        : permission.status === "denied"
          ? "Off"
          : "Not set up";

  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>Notifications</Text>
      <Text style={styles.rowValue}>{statusLabel}</Text>
      {permission?.status === "undetermined" ? (
        <View style={styles.rowAction}>
          <SquareSecondaryButton
            label={requesting ? "Asking…" : "Enable notifications"}
            onPress={() => void handleEnable()}
            disabled={requesting}
            testID="settings-enable-notifications"
            accessibilityHint="Shows the system notification permission prompt"
          />
        </View>
      ) : null}
      {permission?.status === "denied" ? (
        <View style={styles.rowAction}>
          <Text style={styles.rowHint}>
            Turn on notifications for this app in your device settings to get
            event updates.
          </Text>
          <SquareSecondaryButton
            label="Open system settings"
            onPress={openSystemSettings}
            testID="settings-open-system-settings"
            accessibilityHint="Opens this app's notification settings"
          />
        </View>
      ) : null}
    </View>
  );
};

export const SettingsScreen = () => {
  const { signOut, user } = useAuthSession();
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const [pending, setPending] = useState(false);

  const handleSignOut = useCallback(async () => {
    setPending(true);
    try {
      await signOut();
    } finally {
      setPending(false);
    }
  }, [signOut]);

  return (
    <ScreenSurface testID="settings-screen">
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.header}>
          <SectionNum index="05" label="Settings" />
          <ScreenHeading>Settings</ScreenHeading>
        </View>
        <View style={styles.body}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Account</Text>
            <Text style={styles.rowValue}>{user?.email ?? "Unknown"}</Text>
          </View>

          <NotificationsRow />

          <View style={styles.actionGroup}>
            <View style={styles.ctaWrapper}>
              <SquareDangerButton
                label={pending ? "Signing out…" : "Sign out"}
                onPress={() => void handleSignOut()}
                disabled={pending}
                testID="settings-sign-out"
              />
              {pending ? (
                <View style={styles.spinnerOverlay} pointerEvents="none">
                  {/* Overlays the OUTLINED danger button, whose fill is the
                      canvas — `dangerSoft` is the AA-as-content rung there. */}
                  <ActivityIndicator color={colors.dangerSoft} />
                </View>
              ) : null}
            </View>
          </View>
        </View>
      </SafeAreaView>
    </ScreenSurface>
  );
};

/** Colour-bearing sheet → factory + `useThemedSheet`. */
const makeSheet = (c: NativePalette) =>
  StyleSheet.create({
    safe: { flex: 1 },
    header: {
      paddingHorizontal: 20,
      paddingTop: 8,
      paddingBottom: 16,
      gap: 4,
    },
    body: { paddingHorizontal: 20, gap: 24 },
    row: {
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.borderColorSoft,
      gap: 4,
    },
    rowLabel: {
      fontFamily: "Montserrat-Medium",
      fontSize: 11,
      color: c.colorMuted,
      letterSpacing: 1.2,
      textTransform: "uppercase",
    },
    rowValue: {
      fontFamily: "Montserrat",
      fontSize: 16,
      color: c.color,
    },
    rowAction: { marginTop: 12, gap: 12 },
    rowHint: {
      fontFamily: "Montserrat",
      fontSize: 13,
      lineHeight: 18,
      color: c.colorMuted,
    },
    actionGroup: { marginTop: 24 },
    ctaWrapper: { position: "relative" },
    spinnerOverlay: {
      position: "absolute",
      top: 0,
      bottom: 0,
      right: 16,
      alignItems: "center",
      justifyContent: "center",
    },
  });
