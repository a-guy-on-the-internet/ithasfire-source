import { useCallback, useEffect, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AlertTriangle, ShieldCheck, X } from "lucide-react-native";

import {
  SquarePrimaryButton,
  useColors,
  useStyles,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import { PASSWORD_COPY } from "./event-password-challenge";
import { useEventPasswordSubmit } from "./use-event-password-submit";

/**
 * Bottom-sheet password prompt for password-gated events (FR-011).
 *
 * Calls `events.validatePassword` through `useEventPasswordSubmit`; the
 * server persists the unlock for signed-in viewers, so on success the hook
 * invalidates the gate state (plus the detail queries it gates) and the
 * screen re-renders unlocked. Wrong passwords keep the sheet open with an
 * inline error. When the server asks for a Turnstile check, the hook runs it
 * in the system browser and resubmits once. The password is never logged or
 * persisted client-side.
 */
export const EventPasswordSheet = ({
  eventId,
  visible,
  onClose,
}: {
  eventId: string;
  visible: boolean;
  onClose: () => void;
}) => {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const shared = useStyles();
  const styles = useThemedSheet(makeSheet);
  const [password, setPassword] = useState("");
  const [focused, setFocused] = useState(false);

  const handleUnlocked = useCallback(() => {
    setPassword("");
    onClose();
  }, [onClose]);

  const { submit, isBusy, notice, clearNotice } = useEventPasswordSubmit({
    eventId,
    onUnlocked: handleUnlocked,
  });

  // iOS: `accessibilityRole="alert"` doesn't announce a view as it mounts,
  // and the notice usually mounts as the browser sheet closes, when VoiceOver
  // is re-focusing the app. `queue: true` waits for that speech instead of
  // being cut off by it. Keyed on the object, so the same message after a
  // retry is announced again. Android uses the banner's
  // `accessibilityLiveRegion` instead (its announce API is deprecated at
  // API 36), so neither platform reads it twice.
  useEffect(() => {
    if (!notice || Platform.OS !== "ios") return;
    AccessibilityInfo.announceForAccessibilityWithOptions(notice.text, {
      queue: true,
    });
  }, [notice]);

  const canSubmit = password.trim().length > 0 && !isBusy;

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    void submit(password.trim());
  }, [canSubmit, password, submit]);

  const handleClose = useCallback(() => {
    if (isBusy) return;
    setPassword("");
    clearNotice();
    onClose();
  }, [clearNotice, isBusy, onClose]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleClose}
    >
      <Pressable
        style={styles.overlay}
        onPress={handleClose}
        accessibilityLabel="Dismiss password prompt"
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.avoider}
          pointerEvents="box-none"
        >
          {/* Swallow taps so tapping inside the sheet doesn't close it. */}
          {/* Modal renders outside SafeAreaView — pad past the home indicator. */}
          <Pressable
            style={[
              styles.sheet,
              { paddingBottom: Math.max(32, insets.bottom + 16) },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Event password</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={12}
                onPress={handleClose}
                style={styles.closeButton}
              >
                <X size={18} color={colors.color} />
              </Pressable>
            </View>

            <Text style={styles.sheetCopy}>
              This event is private. Enter the password from the organizer to
              see details and get tickets.
            </Text>

            {/* Always mounted so a notice is a content change INSIDE an existing
                Android live region; TalkBack often skips a node that mounts
                with the region already set. Empty, it is taken out of flow so
                the sheet's `gap` doesn't add space for it. `collapsable={false}`
                keeps Fabric from flattening the empty view away. */}
            <View
              accessibilityLiveRegion="polite"
              collapsable={false}
              style={notice ? null : styles.liveRegionEmpty}
            >
              {notice ? (
                <View
                  style={
                    notice.tone === "info" ? styles.infoBanner : styles.errorBanner
                  }
                  // Danger only: the info notice is guidance, not an alert.
                  accessibilityRole={
                    notice.tone === "danger" ? "alert" : undefined
                  }
                  testID="event-password-notice"
                >
                  {notice.tone === "info" ? (
                    <ShieldCheck color={colors.color} size={18} />
                  ) : (
                    <AlertTriangle color={colors.dangerSoft} size={18} />
                  )}
                  <Text
                    style={
                      notice.tone === "info" ? styles.infoText : styles.errorText
                    }
                  >
                    {notice.text}
                  </Text>
                </View>
              ) : null}
            </View>

            <TextInput
              value={password}
              onChangeText={(value) => {
                setPassword(value);
                clearNotice();
              }}
              placeholder="Event password"
              placeholderTextColor={colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              secureTextEntry
              returnKeyType="go"
              enterKeyHint="go"
              editable={!isBusy}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onSubmitEditing={handleSubmit}
              accessibilityLabel="Event password"
              style={[shared.input, focused ? shared.inputFocused : null]}
              testID="event-password-input"
            />

            <View style={styles.ctaWrapper}>
              <SquarePrimaryButton
                label={isBusy ? "Checking..." : PASSWORD_COPY.unlockCta}
                onPress={handleSubmit}
                disabled={!canSubmit}
                accessibilityHint="Submits the event password to unlock details and tickets."
                testID="event-password-submit"
              />
              {isBusy ? (
                <View style={styles.spinnerOverlay} pointerEvents="none">
                  {/* Sits ON the primary button's `ctaFill`. */}
                  <ActivityIndicator color={colors.onCta} />
                </View>
              ) : null}
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
};

/** Colour-bearing sheet → factory + `useThemedSheet`. */
const makeSheet = (c: NativePalette) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: c.modalScrim,
      justifyContent: "flex-end",
    },
    avoider: { justifyContent: "flex-end" },
    sheet: {
      backgroundColor: c.background,
      borderTopWidth: 2,
      borderTopColor: c.borderColor,
      padding: 20,
      gap: 14,
    },
    sheetHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    sheetTitle: {
      color: c.color,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 14,
      fontWeight: "700",
      letterSpacing: 1,
      textTransform: "uppercase",
    },
    closeButton: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: c.borderColor,
      backgroundColor: c.surfaceMuted,
    },
    sheetCopy: {
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 14,
      lineHeight: 20,
    },
    // Outlined-tone banner: tone on the border + label, fill stays a surface.
    errorBanner: {
      minHeight: 44,
      borderWidth: 2,
      borderColor: c.danger,
      backgroundColor: c.surface,
      padding: 12,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    errorText: {
      flex: 1,
      color: c.dangerSoft,
      fontFamily: "Montserrat",
      fontSize: 14,
      lineHeight: 19,
    },
    // Out of flow while empty: an in-flow 0-height child still gets the
    // sheet's 14px `gap` on each side; an absolute one gets none.
    liveRegionEmpty: { position: "absolute" },
    // Guidance, not a failure (the security-check step): structural ink on
    // the border + label, same geometry as the error banner.
    infoBanner: {
      minHeight: 44,
      borderWidth: 2,
      borderColor: c.borderColorStrong,
      backgroundColor: c.surface,
      padding: 12,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    infoText: {
      flex: 1,
      color: c.color,
      fontFamily: "Montserrat",
      fontSize: 14,
      lineHeight: 19,
    },
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
