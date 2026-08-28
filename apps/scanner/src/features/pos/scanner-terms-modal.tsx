/**
 * Blocking POS-entry terms acknowledgement surface
 * (spec docs/specs/2026-05-14/completed/pos-attestation.spec.md — "Scanner UI").
 *
 * Rendered by the sell tab INSTEAD of the POS UI whenever the operator
 * lacks a current-version scanner-terms ack (see `needsScannerTermsAck`).
 * Not dismissible — the only way forward is the single confirm button,
 * which calls `humans.acknowledgeScannerTerms` and then invalidates
 * `scanner.getSessionContext` so the refreshed operator ack state
 * unmounts this screen and reveals the sell UI.
 *
 * Copy comes from `SCANNER_TERMS_TEXT[SCANNER_TERMS_VERSION]` in
 * `@th/types` — the same constants the server-side gate validates
 * against, so the modal and the enforcement share one source of truth.
 */
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { SCANNER_TERMS_TEXT, SCANNER_TERMS_VERSION } from "@th/types";
import { Text } from "@th/ui";

import { showErrorToastFromError } from "../../lib/toast";
import { trpc } from "../../trpc";
import {
  ScreenSurface,
  SquarePrimaryButton,
  useColors,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

export const ScannerTermsModal = () => {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const terms = SCANNER_TERMS_TEXT[SCANNER_TERMS_VERSION];

  const trpcUtils = trpc.useUtils();
  const acknowledge = trpc.humans.acknowledgeScannerTerms.useMutation();
  // Covers the mutation AND the session-context refetch — the button stays
  // inert until the refreshed ack state unmounts this screen, so a slow
  // refetch can't produce a double submit.
  const [submitting, setSubmitting] = useState(false);

  const handleAcknowledge = async () => {
    setSubmitting(true);
    try {
      await acknowledge.mutateAsync({ version: SCANNER_TERMS_VERSION });
      // `invalidate` resolves once active observers refetch; the sell tab
      // re-renders with the fresh operator ack state and unmounts us.
      await trpcUtils.scanner.getSessionContext.invalidate();
    } catch (err) {
      showErrorToastFromError(err);
      setSubmitting(false);
    }
  };

  // Defensive: a version bump without a matching SCANNER_TERMS_TEXT entry
  // (guarded by scanner-terms-ack.test.ts) would leave nothing to render.
  // Stay blocking — never silently unlock the POS UI.
  if (!terms) {
    return (
      <ScreenSurface testID="scanner-terms-modal">
        <View style={styles.card}>
          <Text variant="h4" weight="bold" style={styles.title}>
            Terms unavailable
          </Text>
          <Text variant="bodySmall" style={styles.body}>
            We couldn't load the seller terms for this version of the app.
            Update the app and try again.
          </Text>
        </View>
      </ScreenSurface>
    );
  }

  return (
    <ScreenSurface testID="scanner-terms-modal">
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.card}>
          <Text
            variant="h4"
            weight="bold"
            style={styles.title}
            accessibilityRole="header"
          >
            {terms.title}
          </Text>

          <View style={styles.bullets} accessibilityRole="list">
            {terms.bullets.map((bullet) => (
              <View key={bullet} style={styles.bulletRow}>
                <Text variant="bodySmall" weight="bold" style={styles.marker}>
                  —
                </Text>
                <Text variant="bodySmall" style={styles.body}>
                  {bullet}
                </Text>
              </View>
            ))}
          </View>

          <SquarePrimaryButton
            label={submitting ? "Saving…" : terms.confirmLabel}
            onPress={() => void handleAcknowledge()}
            disabled={submitting}
            accessibilityLabel={terms.confirmLabel}
            accessibilityHint="Acknowledges the seller terms and opens the sell screen."
            testID="scanner-terms-acknowledge"
          />
        </View>
      </ScrollView>
    </ScreenSurface>
  );
};

const makeSheet = (colors: NativePalette) =>
  StyleSheet.create({
    scrollContent: {
      flexGrow: 1,
      justifyContent: "center",
      paddingVertical: 24,
    },
    card: {
      maxWidth: 480,
      width: "100%",
      alignSelf: "center",
      borderWidth: 2,
      borderColor: colors.borderColor,
      backgroundColor: colors.surfaceRaised,
      padding: 24,
      gap: 16,
    },
    title: {
      color: colors.color,
      fontSize: 22,
      letterSpacing: -0.5,
      textTransform: "uppercase",
    },
    bullets: { gap: 12 },
    bulletRow: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
    marker: { color: colors.accent },
    body: { color: colors.color, flex: 1 },
  });
