import { useCallback, useState } from "react";
import {
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
import { TRPCClientError } from "@trpc/client";
import { AlertTriangle, X } from "lucide-react-native";

import {
  SquarePrimaryButton,
  useColors,
  useStyles,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import { trpc } from "@/lib/trpc";

const getPasswordErrorMessage = (err: unknown): string => {
  if (err instanceof TRPCClientError) {
    const code = (err.data as { code?: string } | undefined)?.code;
    if (code === "TOO_MANY_REQUESTS") {
      return "Too many attempts. Wait a minute and try again.";
    }
    if (code === "BAD_REQUEST") {
      return "That password didn't work. Check it and try again.";
    }
  }
  return "Couldn't verify the password. Try again.";
};

/**
 * Bottom-sheet password prompt for password-gated events (FR-011).
 *
 * Calls `events.validatePassword`; the server persists the unlock for
 * signed-in viewers, so on success we invalidate the gate state (plus the
 * detail queries it gates) and the screen re-renders unlocked. Wrong
 * passwords keep the sheet open with an inline error. The password is never
 * logged or persisted client-side.
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
  const utils = trpc.useUtils();
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const shared = useStyles();
  const styles = useThemedSheet(makeSheet);
  const [password, setPassword] = useState("");
  const [focused, setFocused] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mutation = trpc.events.validatePassword.useMutation({
    // Never auto-retry: a wrong password would be re-submitted and burn the
    // 5/min/event rate-limit budget.
    retry: false,
    onSuccess: async (data) => {
      if (!data.unlocked) {
        setErrorMessage("That password didn't work. Check it and try again.");
        return;
      }
      setPassword("");
      setErrorMessage(null);
      // Gate state flips passwordRequired → false, which re-enables the
      // gated detail queries (SEO, body, ticket types, waiver).
      await Promise.all([
        utils.events.getGateState.invalidate({ eventId }),
        utils.events.getEventSeo.invalidate(),
        utils.events.getPublicEventBody.invalidate(),
        utils.events.listEventTicketTypes.invalidate({ eventId }),
        utils.waivers.getEventWaiver.invalidate({ eventId }),
      ]);
      onClose();
    },
    onError: (err) => {
      setErrorMessage(getPasswordErrorMessage(err));
    },
  });

  const canSubmit = password.trim().length > 0 && !mutation.isPending;

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    setErrorMessage(null);
    mutation.mutate({ eventId, password: password.trim() });
  }, [canSubmit, eventId, mutation, password]);

  const handleClose = useCallback(() => {
    if (mutation.isPending) return;
    setPassword("");
    setErrorMessage(null);
    onClose();
  }, [mutation.isPending, onClose]);

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

            {errorMessage ? (
              <View style={styles.errorBanner} accessibilityRole="alert">
                <AlertTriangle color={colors.dangerSoft} size={18} />
                <Text style={styles.errorText}>{errorMessage}</Text>
              </View>
            ) : null}

            <TextInput
              value={password}
              onChangeText={(value) => {
                setPassword(value);
                setErrorMessage(null);
              }}
              placeholder="Event password"
              placeholderTextColor={colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              secureTextEntry
              returnKeyType="go"
              enterKeyHint="go"
              editable={!mutation.isPending}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onSubmitEditing={handleSubmit}
              accessibilityLabel="Event password"
              style={[shared.input, focused ? shared.inputFocused : null]}
              testID="event-password-input"
            />

            <View style={styles.ctaWrapper}>
              <SquarePrimaryButton
                label={mutation.isPending ? "Checking..." : "Unlock event"}
                onPress={handleSubmit}
                disabled={!canSubmit}
                accessibilityHint="Submits the event password to unlock details and tickets."
                testID="event-password-submit"
              />
              {mutation.isPending ? (
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
