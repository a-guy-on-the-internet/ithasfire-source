import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { formatAuthErrorMessage, isWebAuthnCancel } from "@th/errors";

import {
  GeometricBackground,
  SquarePrimaryButton,
  Text,
  useColors,
} from "@th/ui-native";
import {
  addPasskey,
  isPasskeySupported,
} from "../features/auth/passkey-client";
import { scannerPasskeyName } from "../features/auth/passkey-name";
import { showErrorToast } from "../lib/toast";

/**
 * Post-sign-in nudge to enroll a passkey for operators who got in via
 * password / magic-link / OAuth. Shows once per device (gated by
 * `preferences.passkeyPromptDismissed`); choosing "Skip" or completing
 * enrollment both flip the flag so we don't re-prompt every login.
 *
 * Lives between sign-in and the home screen — the operator must
 * either enrol or skip before they reach the scanner UI.
 */
export interface PasskeyEnrollPromptProps {
  /**
   * The operator's display NAME (not their email). The credential label is
   * derived from it here via `scannerPasskeyName` so this screen and the
   * settings screen share one derivation — previously each built its own and
   * they drifted. Omit it when the account has no name; the shared helper
   * falls back to a bare device label.
   */
  userName?: string | null;
  /**
   * Branches the prompt copy so brand-new accounts get
   * "secure this account" framing, while returning operators who
   * signed in via password/OAuth/magic-link see the "skip the password
   * next time" framing. Defaults to `"post-signin"`.
   */
  variant?: "post-signin" | "post-signup";
  onComplete: () => void;
  onSkip: () => void;
}

export const PasskeyEnrollPromptScreen = ({
  userName,
  variant = "post-signin",
  onComplete,
  onSkip,
}: PasskeyEnrollPromptProps) => {
  const colors = useColors();
  const [enrolling, setEnrolling] = useState(false);
  const isPostSignup = variant === "post-signup";

  const handleAdd = async () => {
    if (!isPasskeySupported()) {
      showErrorToast(
        "Passkeys not supported",
        "Your device doesn't support passkeys yet.",
      );
      onSkip();
      return;
    }
    setEnrolling(true);
    try {
      // No `existingNames` here, unlike the settings screen: this is the
      // first-run, lowest-friction path (the operator is between sign-in and
      // the scanner UI), the list is almost always empty at this point, and a
      // pre-enrollment round-trip would delay the biometric prompt. Deliberate
      // asymmetry — see the note in `passkey-name.ts`.
      const result = await addPasskey(scannerPasskeyName(userName));
      if (result.error) {
        // User-cancellation is benign; let them try again or skip without
        // surfacing an alarming toast.
        if (
          result.error.code === "user_cancelled" ||
          isWebAuthnCancel(result.error)
        ) {
          return;
        }
        showErrorToast(
          "Couldn't add passkey",
          result.error.message ||
            "Try again on a device that supports passkeys.",
        );
        return;
      }
      onComplete();
    } catch (err) {
      showErrorToast(
        "Couldn't add passkey",
        formatAuthErrorMessage(err) ||
          "Try again on a device that supports passkeys.",
      );
    } finally {
      setEnrolling(false);
    }
  };

  return (
    <View
      style={[styles.root, { backgroundColor: colors.background }]}
      testID="passkey-enroll-prompt"
    >
      <GeometricBackground />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.card, { borderColor: colors.borderColor }]}>
          <Text
            variant="h4"
            weight="bold"
            style={styles.title}
            color={colors.color}
          >
            {isPostSignup ? "SECURE THIS ACCOUNT" : "ADD A PASSKEY"}
          </Text>
          <Text variant="bodySmall" color={colors.color}>
            {isPostSignup
              ? "Add a passkey so the next sign-in is one tap — Face ID, Touch ID, or your screen lock. You can still use your password anytime."
              : "Skip the password next time. Use Face ID, Touch ID, or your device's screen lock to sign in."}
          </Text>
          <Text variant="bodySmall" color={colors.colorMuted}>
            You can manage passkeys later from settings.
          </Text>

          {/*
            Was a hand-rolled CTA duplicating the primary-button treatment
            (including its own ink-on-orange comment). Now the shared primitive,
            so the Stub CTA ladder — which rests one rung down at #B93312
            because white on #E2481D is 4.06:1 — applies here for free.
          */}
          <SquarePrimaryButton
            label={enrolling ? "ADDING…" : "ADD A PASSKEY"}
            onPress={() => void handleAdd()}
            disabled={enrolling}
            testID="passkey-enroll-add"
          />

          <Pressable
            accessibilityRole="button"
            onPress={onSkip}
            disabled={enrolling}
            style={[styles.skip, { borderTopColor: colors.borderColorSoft }]}
            testID="passkey-enroll-skip"
          >
            <Text
              variant="bodySmall"
              weight="bold"
              style={styles.skipText}
              color={colors.colorMuted}
            >
              SKIP FOR NOW
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
};

/** Geometry only — colours applied inline from `useColors()`. */
const styles = StyleSheet.create({
  root: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    paddingVertical: 48,
    paddingHorizontal: 16,
    gap: 24,
  },
  card: {
    maxWidth: 480,
    width: "100%",
    alignSelf: "center",
    borderWidth: 2,
    backgroundColor: "transparent",
    padding: 24,
    gap: 16,
  },
  title: {
    fontSize: 22,
    letterSpacing: -0.5,
    textTransform: "uppercase",
  },
  skip: {
    paddingVertical: 12,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderTopWidth: 2,
  },
  skipText: {
    fontSize: 11,
    letterSpacing: 1.5,
  },
});
