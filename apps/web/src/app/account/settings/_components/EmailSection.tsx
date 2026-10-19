"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { YStack, XStack } from "tamagui";
import { AlertTriangle, Mail, ShieldCheck } from "lucide-react";
import {
  Text,
  Button,
  LabeledTextInput,
  Spinner,
  FormErrorBanner,
  useNotify,
  useTranslations,
} from "@th/ui";
import { authClient } from "@/lib/auth/auth-client";
import { requestEmailChangeCode } from "@/lib/auth/request-email-change-code";
import { isVerifyCurrentEmailFirst } from "@/lib/email-verification-required";
import { RESEND_WINDOW_MS } from "@/components/auth/useEmailVerificationPrompt";
import { useFormErrors } from "@/hooks/useFormErrors";
import {
  SectionCard,
  FieldRow,
} from "./settings-primitives";

type EmailOtpChangeResult = {
  error?: { message?: string } | null;
  data?: unknown;
};

type EmailOtpChangeClient = {
  changeEmail: (input: {
    newEmail: string;
    otp: string;
  }) => Promise<EmailOtpChangeResult>;
  sendVerificationOtp: (input: {
    email: string;
    type: "email-verification";
  }) => Promise<EmailOtpChangeResult>;
  verifyEmail: (input: {
    email: string;
    otp: string;
  }) => Promise<EmailOtpChangeResult>;
};

type AuthClientWithOptionalSessionRefresh = {
  getSession?: (input: {
    query: { disableCookieCache: boolean };
  }) => Promise<unknown>;
};

const emailOtpClient = (
  authClient as unknown as { emailOtp: EmailOtpChangeClient }
).emailOtp;

const refreshSessionAfterEmailChange = async () => {
  const getSession = (
    authClient as unknown as AuthClientWithOptionalSessionRefresh
  ).getSession;

  if (!getSession) return;

  try {
    await getSession({ query: { disableCookieCache: true } });
  } catch {
    // Non-fatal: the email was verified and the session will refresh naturally.
  }
};

export function EmailSection({
  user,
  hasCredential,
}: {
  user: {
    email?: string | null;
    emailDeliveryStatus?: string | null;
    emailVerified?: boolean | null;
  };
  hasCredential: boolean | null;
}) {
  const t = useTranslations();
  const { toast } = useNotify();
  const {
    formError,
    setError,
    clearAll: clearFormErrors,
  } = useFormErrors();
  // The "verify your current email first" answer (B2): our own copy, kept out
  // of `setError` because the shared normaliser rewrites any message that
  // contains "verify your email" into sign-in copy.
  const [verifyFirstNotice, setVerifyFirstNotice] = useState<string | null>(
    null,
  );
  const clearAll = useCallback(() => {
    clearFormErrors();
    setVerifyFirstNotice(null);
  }, [clearFormErrors]);
  const [newEmail, setNewEmail] = useState("");
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [changed, setChanged] = useState(false);

  // Separate state for the "verify your current email" flow so it never
  // collides with the email-change flow above.
  const [verifySent, setVerifySent] = useState(false);
  const [verifyOtp, setVerifyOtp] = useState("");
  const [sendingCode, setSendingCode] = useState(false);
  const [confirmingCode, setConfirmingCode] = useState(false);
  // When the last code to the CURRENT address went out. A second refused
  // change inside the window must not mail a code over the one in hand.
  const currentCodeSentAtRef = useRef<number | null>(null);

  // The code field is the next thing to do once it opens.
  useEffect(() => {
    if (!verifySent) return;
    const id = requestAnimationFrame(() =>
      document.getElementById("verifyEmailOtp")?.focus(),
    );
    return () => cancelAnimationFrame(id);
  }, [verifySent]);

  const isOAuthOnly = hasCredential === false;
  const currentEmail = user.email ?? null;
  const needsVerification = Boolean(currentEmail) && !user.emailVerified;
  const canConfirmCode = verifyOtp.trim().length === 6 && !confirmingCode;
  const deliveryStatus =
    user.emailDeliveryStatus === "BOUNCED" ||
    user.emailDeliveryStatus === "COMPLAINED"
      ? user.emailDeliveryStatus
      : null;
  const deliveryStatusLabel = deliveryStatus
    ? String(
        t(
          deliveryStatus === "COMPLAINED"
            ? "account.sEmailComplaintBadge"
            : "account.sEmailUndeliverableBadge",
        ),
      )
    : null;

  const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail.trim());
  const isSame =
    newEmail.trim().toLowerCase() === (user.email ?? "").toLowerCase();
  const canUseEmailOtpChange = !isOAuthOnly || deliveryStatus !== null;
  const canSubmit = isValid && !isSame && !saving && canUseEmailOtpChange;
  const canVerify = otp.trim().length === 6 && !verifying;

  // An account holding orders, tickets or seats must verify the address it
  // has before it can move to another (the server refuses with
  // `verify_current_email_first`). Send that code now and open its entry, so
  // the one way forward is already on screen.
  const answerVerifyCurrentFirst = useCallback(async () => {
    const lastSentAt = currentCodeSentAtRef.current;
    const codeInHand =
      verifySent ||
      (lastSentAt !== null && Date.now() - lastSentAt < RESEND_WINDOW_MS);
    let sent = codeInHand;
    if (!codeInHand && currentEmail) {
      try {
        const result = await emailOtpClient.sendVerificationOtp({
          email: currentEmail,
          type: "email-verification",
        });
        sent = !result?.error;
      } catch {
        sent = false;
      }
      if (sent) {
        currentCodeSentAtRef.current = Date.now();
        setVerifyOtp("");
      }
    }
    // A code already in hand keeps whatever was typed into its field. If the
    // field is already open the effect on `verifySent` will not re-run, so
    // move focus to it here.
    if (sent) setVerifySent(true);
    if (codeInHand && verifySent) {
      requestAnimationFrame(() =>
        document.getElementById("verifyEmailOtp")?.focus(),
      );
    }
    setVerifyFirstNotice(
      sent
        ? String(t("emailGate.changeBlockedSent", { email: currentEmail ?? "" }))
        : String(t("emailGate.changeBlocked")),
    );
  }, [currentEmail, t, verifySent]);

  const handleRequestChange = useCallback(async () => {
    if (!canSubmit) return;
    const normalizedEmail = newEmail.trim().toLowerCase();
    clearAll();
    setSaving(true);
    try {
      await requestEmailChangeCode(normalizedEmail);
      setPendingEmail(normalizedEmail);
      setOtp("");
      setChanged(false);
      toast.success({
        id: "email-verify-sent",
        title: String(t("account.sEmailSentTitle")),
        message: String(t("account.sEmailSentMsg")),
      });
    } catch (error) {
      if (isVerifyCurrentEmailFirst(error)) {
        await answerVerifyCurrentFirst();
      } else {
        setError(error);
      }
    } finally {
      setSaving(false);
    }
  }, [
    canSubmit,
    newEmail,
    t,
    toast,
    clearAll,
    setError,
    answerVerifyCurrentFirst,
  ]);

  const handleVerifyChange = useCallback(async () => {
    if (!pendingEmail || !canVerify) return;

    const trimmedOtp = otp.trim();
    clearAll();
    setVerifying(true);
    try {
      const result = await emailOtpClient.changeEmail({
        newEmail: pendingEmail,
        otp: trimmedOtp,
      });
      if (result?.error) throw result.error;

      await refreshSessionAfterEmailChange();
      setNewEmail("");
      setPendingEmail(null);
      setOtp("");
      setChanged(true);
      toast.success({
        id: "email-change-complete",
        title: String(t("account.sEmailChangedTitle")),
        message: String(t("account.sEmailChangedMsg")),
      });
    } catch (error) {
      if (isVerifyCurrentEmailFirst(error)) {
        setPendingEmail(null);
        setOtp("");
        await answerVerifyCurrentFirst();
      } else {
        setError(error);
      }
    } finally {
      setVerifying(false);
    }
  }, [
    canVerify,
    pendingEmail,
    otp,
    t,
    toast,
    clearAll,
    setError,
    answerVerifyCurrentFirst,
  ]);

  const resetPendingChange = useCallback(() => {
    clearAll();
    setPendingEmail(null);
    setOtp("");
    setNewEmail("");
    setChanged(false);
  }, [clearAll]);

  const handleSendVerification = useCallback(async () => {
    if (!currentEmail || sendingCode) return;
    clearAll();
    setSendingCode(true);
    try {
      const result = await emailOtpClient.sendVerificationOtp({
        email: currentEmail,
        type: "email-verification",
      });
      if (result?.error) throw result.error;

      currentCodeSentAtRef.current = Date.now();
      setVerifySent(true);
      setVerifyOtp("");
      toast.success({
        id: "email-verify-current-sent",
        title: String(t("account.sEmailSentTitle")),
        message: String(t("account.sEmailSentMsg")),
      });
    } catch (error) {
      setError(error);
    } finally {
      setSendingCode(false);
    }
  }, [currentEmail, sendingCode, t, toast, clearAll, setError]);

  const handleConfirmVerification = useCallback(async () => {
    if (!currentEmail || !canConfirmCode) return;

    const trimmedOtp = verifyOtp.trim();
    clearAll();
    setConfirmingCode(true);
    try {
      const result = await emailOtpClient.verifyEmail({
        email: currentEmail,
        otp: trimmedOtp,
      });
      if (result?.error) throw result.error;

      await refreshSessionAfterEmailChange();
      setVerifySent(false);
      setVerifyOtp("");
      toast.success({
        id: "email-verify-current-complete",
        title: String(t("auth.verifyToastSuccess")),
      });
    } catch (error) {
      setError(error);
    } finally {
      setConfirmingCode(false);
    }
  }, [currentEmail, canConfirmCode, verifyOtp, t, toast, clearAll, setError]);

  const cancelVerification = useCallback(() => {
    clearAll();
    setVerifySent(false);
    setVerifyOtp("");
  }, [clearAll]);

  return (
    <SectionCard>
      <XStack gap="$2" alignItems="center">
        <Mail size={18} color="$colorMuted" />
        <Text variant="h4" weight="bold">
          {String(t("account.sEmailTitle"))}
        </Text>
      </XStack>

      <FormErrorBanner
        message={formError ?? verifyFirstNotice}
        onDismiss={clearAll}
      />

      <FieldRow>
        <Text variant="caption" tone="muted" weight="medium">
          {String(t("account.sCurrentEmail"))}
        </Text>
        <XStack
          gap="$2"
          alignItems="center"
          paddingVertical="$2"
          paddingHorizontal="$3"
          backgroundColor="$backgroundHover"
          borderRadius={0}
          flexWrap="wrap"
        >
          <Mail size={15} color="$colorMuted" />
          <Text variant="body" tone="muted" flex={1}>
            {user.email ?? "\u2014"}
          </Text>
          {deliveryStatusLabel && (
            <XStack
              gap="$2"
              alignItems="center"
              borderWidth={1}
              borderColor="$warning"
              paddingHorizontal="$2"
              paddingVertical="$1"
            >
              <AlertTriangle size={13} color="$warning" aria-hidden />
              <Text
                variant="caption"
                weight="bold"
                color="$warning"
                textTransform="uppercase"
              >
                {deliveryStatusLabel}
              </Text>
            </XStack>
          )}
        </XStack>
      </FieldRow>

      {/* Suppressed while an address CHANGE is pending. The two flows each own
          a "Verification code" input and a "Verify code" button, and they were
          independently reachable at the same time (click "Verify this address",
          then start a change) — which put two identically-named controls and
          two identically-labelled inputs on one card. Finishing the change
          supersedes verifying the address being replaced, so one flow at a
          time is also the correct product behaviour. */}
      {needsVerification &&
        !pendingEmail &&
        (verifySent ? (
          <YStack
            gap="$3"
            padding="$3"
            backgroundColor="$surfaceMuted"
            borderRadius={0}
            borderLeftWidth={3}
            borderLeftColor="$accent"
          >
            <YStack gap="$2">
              <Text variant="body" weight="medium">
                {String(t("account.sEmailSentTitle"))}
              </Text>
            </YStack>

            <LabeledTextInput
              label={String(t("account.sEmailCodeLabel"))}
              name="verifyEmailOtp"
              value={verifyOtp}
              onChangeText={setVerifyOtp}
              placeholder={String(t("account.sEmailCodePlaceholder"))}
              keyboardType="number-pad"
              autoCapitalize="none"
              autoComplete="one-time-code"
              enterKeyHint="done"
              maxLength={6}
              helperText={String(
                t("account.sEmailCodeHint", { email: currentEmail ?? "" }),
              )}
            />

            <XStack justifyContent="space-between" gap="$2" flexWrap="wrap">
              <Button
                variant="ghost"
                size="$3"
                onPress={cancelVerification}
                disabled={confirmingCode}
              >
                {String(t("common.cancel"))}
              </Button>
              <Button
                variant="primary"
                size="$3"
                onPress={handleConfirmVerification}
                disabled={!canConfirmCode}
              >
                {confirmingCode ? (
                  <Spinner size="sm" />
                ) : (
                  String(t("account.sEmailVerifyBtn"))
                )}
              </Button>
            </XStack>
          </YStack>
        ) : (
          <YStack
            gap="$3"
            padding="$3"
            backgroundColor="$surfaceMuted"
            borderRadius={0}
            borderLeftWidth={3}
            borderLeftColor="$accent"
          >
            <YStack gap="$2">
              <XStack gap="$2" alignItems="center">
                <ShieldCheck
                  size={15}
                  color="var(--accent, #E2481D)"
                  aria-hidden
                />
                <Text variant="body" weight="medium">
                  {String(t("auth.evgVerifyTitle"))}
                </Text>
              </XStack>
              <Text variant="caption" tone="muted">
                {String(t("auth.evgBannerDesc"))}
              </Text>
            </YStack>

            <XStack justifyContent="flex-end">
              {/* NOT `sEmailChangeBtn`. This button sends a code to the
                  CURRENT address to verify it; the one at the bottom of the
                  card sends a code to a NEW address to change it. Both render
                  simultaneously whenever an unverified user opens this section,
                  so sharing "Send verification code" gave the card two buttons
                  with one accessible name — ambiguous to a screen reader and
                  untargetable by role+name. */}
              <Button
                variant="primary"
                size="$3"
                onPress={handleSendVerification}
                disabled={sendingCode}
              >
                {sendingCode ? (
                  <Spinner size="sm" />
                ) : (
                  String(t("account.sEmailVerifyCurrentBtn"))
                )}
              </Button>
            </XStack>
          </YStack>
        ))}

      {deliveryStatus && (
        <YStack
          gap="$2"
          padding="$3"
          backgroundColor="$surfaceMuted"
          borderRadius={0}
          borderLeftWidth={3}
          borderLeftColor="$warning"
        >
          <Text variant="body" weight="medium">
            {String(t("account.sEmailDeliveryIssueTitle"))}
          </Text>
          <Text variant="caption" tone="muted">
            {String(
              t(
                deliveryStatus === "COMPLAINED"
                  ? "account.sEmailComplaintDesc"
                  : "account.sEmailUndeliverableDesc",
              ),
            )}
          </Text>
        </YStack>
      )}

      {isOAuthOnly && !deliveryStatus ? (
        <YStack
          gap="$2"
          padding="$3"
          backgroundColor="$surfaceMuted"
          borderRadius={0}
        >
          <Text variant="body" weight="medium">
            {String(t("account.sEmailOAuthTitle"))}
          </Text>
          <Text variant="caption" tone="muted">
            {String(t("account.sEmailOAuthDesc"))}
          </Text>
        </YStack>
      ) : changed ? (
        <YStack
          gap="$2"
          padding="$3"
          backgroundColor="$surfaceMuted"
          borderRadius={0}
        >
          <Text variant="body" weight="medium">
            {String(t("account.sEmailChangedTitle"))}
          </Text>
          <Text variant="caption" tone="muted">
            {String(t("account.sEmailChangedMsg"))}
          </Text>
          <XStack>
            <Button
              variant="ghost"
              size="$3"
              onPress={resetPendingChange}
            >
              {String(t("account.sEmailTryAnother"))}
            </Button>
          </XStack>
        </YStack>
      ) : pendingEmail ? (
        <YStack
          gap="$3"
          padding="$3"
          backgroundColor="$surfaceMuted"
          borderRadius={0}
        >
          <YStack gap="$2">
            <Text variant="body" weight="medium">
              {String(t("account.sEmailSentTitle"))}
            </Text>
            <Text variant="caption" tone="muted">
              {String(t("account.sEmailVerifyHint"))}
            </Text>
          </YStack>

          <LabeledTextInput
            label={String(t("account.sEmailCodeLabel"))}
            name="emailOtp"
            value={otp}
            onChangeText={setOtp}
            placeholder={String(t("account.sEmailCodePlaceholder"))}
            keyboardType="number-pad"
            autoCapitalize="none"
            autoComplete="one-time-code"
            enterKeyHint="done"
            maxLength={6}
            helperText={String(
              t("account.sEmailCodeHint", { email: pendingEmail }),
            )}
          />

          <XStack justifyContent="space-between" gap="$2" flexWrap="wrap">
            <Button
              variant="ghost"
              size="$3"
              onPress={resetPendingChange}
              disabled={verifying}
            >
              {String(t("account.sEmailTryAnother"))}
            </Button>
            <Button
              variant="primary"
              size="$3"
              onPress={handleVerifyChange}
              disabled={!canVerify}
            >
              {verifying ? (
                <Spinner size="sm" />
              ) : (
                String(t("account.sEmailVerifyBtn"))
              )}
            </Button>
          </XStack>
        </YStack>
      ) : (
        <>
          <LabeledTextInput
            label={String(t("account.sNewEmail"))}
            name="newEmail"
            value={newEmail}
            onChangeText={(value) => {
              setNewEmail(value);
              if (changed) setChanged(false);
            }}
            placeholder={String(t("account.sNewEmailPlaceholder"))}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            helperText={String(t("account.sEmailChangeHint"))}
          />

          {isSame && newEmail.trim().length > 0 && (
            <Text variant="caption" color="$warning">
              {String(t("account.sEmailSameAsCurrent"))}
            </Text>
          )}

          <XStack justifyContent="flex-end">
            <Button
              variant="primary"
              size="$3"
              onPress={handleRequestChange}
              disabled={!canSubmit}
            >
              {saving ? (
                <Spinner size="sm" />
              ) : (
                String(t("account.sEmailChangeBtn"))
              )}
            </Button>
          </XStack>
        </>
      )}
    </SectionCard>
  );
}
