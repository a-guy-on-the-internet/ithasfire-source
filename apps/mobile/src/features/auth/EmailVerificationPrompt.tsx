import { useEffect, useRef } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { ShieldCheck } from "lucide-react-native";

import {
  SquareCard,
  SquarePrimaryButton,
  SquareSecondaryButton,
  useColors,
  useStyles,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import { authClient } from "./better-auth-client";
import { OTP_LENGTH } from "./email-verification-flow";
import { useEmailVerification } from "./use-email-verification";

/**
 * "Verify your email to see your tickets": what a ticket screen shows in place
 * of its content when the server refused a gated read with
 * `email_verification_required` (B2, owner ruling 2026-10-16; detect it with
 * `isEmailVerificationRequired`). A retry cannot fix that refusal, so this
 * replaces the screen's "Try again" state.
 *
 * Keep it mounted across refetches with `useEmailVerificationLatch`: a
 * foreground refetch would otherwise unmount the code entry. After a verify
 * every tRPC query is invalidated; the latch lets go once the gated query
 * succeeds and the tickets render. Screens host it in
 * `EmailVerificationScroll` (keyboard + pull to refresh).
 */

export type EmailVerificationContext = "tickets" | "order" | "ticket";

const COPY: Record<
  EmailVerificationContext,
  { title: string; body: (email: string) => string; done: string }
> = {
  tickets: {
    title: "Verify your email to see your tickets",
    body: (email) =>
      `Tickets bought with ${email} show here once you verify. The ones in your inbox still work at the door.`,
    done: "Email verified. Loading your tickets…",
  },
  order: {
    title: "Verify your email to see this order",
    body: (email) =>
      `Its tickets are in the inbox for ${email} and still work at the door.`,
    done: "Email verified. Loading this order…",
  },
  ticket: {
    title: "Verify your email to see this ticket",
    body: (email) =>
      `It is in the inbox for ${email} and still works at the door.`,
    done: "Email verified. Loading this ticket…",
  },
};

export const EmailVerificationPrompt = ({
  context,
  testID = "email-verification-prompt",
}: {
  context: EmailVerificationContext;
  testID?: string;
}) => {
  const colors = useColors();
  const shared = useStyles();
  const styles = useThemedSheet(makeSheet);
  const user = authClient.useSession().data?.user;
  const email = user?.email ?? null;
  const { state, secondsLeft, sendCode, setCode, submit } =
    useEmailVerification(email, user?.emailVerified === true);
  const copy = COPY[context];

  // iOS: `accessibilityLiveRegion` is Android-only, and a mounting
  // `role="alert"` view is not read out, so VoiceOver hears the error and the
  // verified line through the announce API (EventPasswordSheet's pattern).
  // `errorSeq` re-announces the same message after a second wrong code.
  useEffect(() => {
    if (!state.error || Platform.OS !== "ios") return;
    AccessibilityInfo.announceForAccessibilityWithOptions(state.error, {
      queue: true,
    });
  }, [state.error, state.errorSeq]);
  useEffect(() => {
    if (state.phase !== "verified" || Platform.OS !== "ios") return;
    AccessibilityInfo.announceForAccessibilityWithOptions(copy.done, {
      queue: true,
    });
  }, [state.phase, copy.done]);

  const inputRef = useRef<TextInput>(null);
  // Focus the field when the code step opens, and again after a wrong code
  // clears it.
  useEffect(() => {
    if (state.phase === "code" && !state.submitting && state.code === "") {
      inputRef.current?.focus();
    }
  }, [state.phase, state.submitting, state.code]);

  const busy = state.sending || state.submitting;

  return (
    <SquareCard testID={testID}>
      <View style={styles.titleRow}>
        <ShieldCheck size={18} color={colors.accent} />
        <Text style={styles.title} accessibilityRole="header">
          {copy.title}
        </Text>
      </View>
      <Text style={styles.body}>{copy.body(email ?? "your email")}</Text>

      {state.phase === "idle" ? (
        <SquarePrimaryButton
          label={state.sending ? "Sending…" : "Email me a code"}
          onPress={() => void sendCode()}
          disabled={!email || state.sending}
          testID={`${testID}-send`}
        />
      ) : null}

      {state.phase === "code" ? (
        <View style={styles.codeGroup}>
          <Text style={styles.label}>
            {OTP_LENGTH}-digit code
          </Text>
          <TextInput
            ref={inputRef}
            value={state.code}
            onChangeText={setCode}
            keyboardType="number-pad"
            inputMode="numeric"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            editable={!state.submitting}
            accessibilityLabel={`${OTP_LENGTH}-digit code`}
            style={[shared.input, styles.codeInput]}
            testID={`${testID}-code`}
          />
          <SquarePrimaryButton
            label={state.submitting ? "Checking…" : "Verify"}
            onPress={() => void submit(state.code)}
            disabled={busy || state.code.length !== OTP_LENGTH}
            testID={`${testID}-verify`}
          />
          <SquareSecondaryButton
            label={
              state.sending
                ? "Sending…"
                : secondsLeft > 0
                  ? `Resend in ${secondsLeft}s`
                  : "Resend code"
            }
            onPress={() => void sendCode()}
            disabled={busy || secondsLeft > 0}
            testID={`${testID}-resend`}
          />
        </View>
      ) : null}

      {state.phase === "verified" ? (
        <View
          style={styles.doneRow}
          accessibilityLiveRegion="polite"
          testID={`${testID}-verified`}
        >
          <ActivityIndicator color={colors.color} />
          <Text style={styles.body}>{copy.done}</Text>
        </View>
      ) : null}

      {state.error ? (
        <Text
          style={styles.error}
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          testID={`${testID}-error`}
        >
          {state.error}
        </Text>
      ) : null}
    </SquareCard>
  );
};

/** Colour-bearing sheet → factory + `useThemedSheet`. */
const makeSheet = (c: NativePalette) =>
  StyleSheet.create({
    titleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
    title: {
      flex: 1,
      color: c.color,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 16,
      fontWeight: "700",
      letterSpacing: 0.5,
      textTransform: "uppercase",
    },
    body: {
      flexShrink: 1,
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 14,
      lineHeight: 20,
    },
    codeGroup: { gap: 10 },
    label: {
      color: c.color,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 12,
      letterSpacing: 1,
      textTransform: "uppercase",
    },
    codeInput: {
      fontFamily: "Montserrat-SemiBold",
      fontSize: 22,
      letterSpacing: 8,
    },
    doneRow: { flexDirection: "row", alignItems: "center", gap: 10 },
    error: {
      color: c.dangerSoft,
      fontFamily: "Montserrat",
      fontSize: 14,
      lineHeight: 19,
    },
  });
