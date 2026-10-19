"use client";

import {
  type KeyboardEvent,
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  CheckCircle,
  KeyRound,
  Mail,
  ShieldCheck,
} from "lucide-react";
import {
  Alert,
  Button,
  Spinner,
  Text,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";
import { XStack, YStack, styled } from "tamagui";

import { authClient } from "@/lib/auth/auth-client";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { AuthCardShell } from "./AuthCardShell";
import { AUTH_FOOTER_RULE, RECEDING_DISABLED } from "./auth-card-chrome";

/**
 * The footer rule. A hairline at 20% ink, not a 2px full-ink structural line —
 * see `AUTH_FOOTER_RULE`.
 */
const Separator = styled(YStack, {
  name: "AuthFooterRule",
  ...AUTH_FOOTER_RULE,
});

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ChallengeMethod = "totp" | "otp" | "backup";

type TwoFactorOtpClient = {
  sendOtp: () => Promise<{ error?: unknown }>;
  verifyOtp: (input: {
    code: string;
    trustDevice: boolean;
  }) => Promise<{ error?: unknown }>;
};

export type TwoFactorChallengeCardProps = {
  /** Called after the 2FA challenge is verified successfully. */
  onVerifiedAction: () => void;
  /** Called when the user wants to go back to the sign-in form. */
  onBackAction?: () => void;
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const TwoFactorChallengeCard = ({
  onVerifiedAction,
  onBackAction,
}: TwoFactorChallengeCardProps) => {
  const t = useTranslations();
  // With no SMS provider configured the server sends every code by email, so
  // the copy says email unless SMS is explicitly on (fail-closed while loading).
  const { gates } = useFeatureGates();
  const smsAvailable = gates?.sms === true;
  const { toast } = useNotify();

  const [method, setMethod] = useState<ChallengeMethod>("totp");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(true);
  const [status, setStatus] = useState<
    "idle" | "submitting" | "sending-otp" | "verified"
  >("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [otpSent, setOtpSent] = useState(false);
  const inputRef = useRef<{ focus: () => void } | null>(null);
  const successRef = useRef<{ focus: () => void } | null>(null);
  const twoFactorOtp = authClient.twoFactor as TwoFactorOtpClient;

  const canSubmit = code.trim().length >= 6 && status === "idle";

  // Autofocus the code input on mount and after method switch
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [method, otpSent]);

  /** Flash a success state briefly, then proceed. */
  const completeVerification = useCallback(() => {
    setStatus("verified");
    setTimeout(() => {
      onVerifiedAction();
    }, 1_200);
  }, [onVerifiedAction]);

  const toggleTrustDevice = useCallback(() => {
    setTrustDevice((value) => !value);
  }, []);

  const handleTrustKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (
        event.key !== " " &&
        event.key !== "Spacebar" &&
        event.key !== "Enter"
      )
        return;
      event.preventDefault();
      toggleTrustDevice();
    },
    [toggleTrustDevice],
  );

  // ── Verify TOTP code ─────────────────────────────────────
  const verifyTotp = useCallback(async () => {
    setStatus("submitting");
    setErrorMessage(null);
    try {
      const result = await authClient.twoFactor.verifyTotp({
        code: code.trim(),
        trustDevice,
      });
      if (result.error) throw result.error;
      completeVerification();
    } catch (error) {
      console.error("[2fa-challenge] verifyTotp failed", error);
      const message =
        (error as { message?: string } | null)?.message ??
        String(t("auth.tfcInvalidCode"));
      setErrorMessage(message);
      setCode("");
      inputRef.current?.focus();
    } finally {
      if (status !== "verified") setStatus("idle");
    }
  }, [code, trustDevice, completeVerification, t, status]);

  // ── Verify OTP (email/SMS) ───────────────────────────────
  const sendOtp = useCallback(async () => {
    setStatus("sending-otp");
    setErrorMessage(null);
    try {
      // Better Auth's twoFactor.sendOtp triggers the server's otpOptions.sendOTP
      // which our sendTwoFactorOtp use case handles (SMS preferred, email fallback)
      const result = await twoFactorOtp.sendOtp();
      if (result?.error) throw result.error;
      setOtpSent(true);
      toast.success({
        id: "2fa-otp-sent",
        title: String(t("auth.tfcOtpSentTitle")),
        message: String(
          t(smsAvailable ? "auth.tfcOtpSentMsg" : "auth.tfcOtpSentMsgEmail"),
        ),
      });
    } catch (error) {
      console.error("[2fa-challenge] sendOtp failed", error);
      const message =
        (error as { message?: string } | null)?.message ??
        String(t("auth.tfcOtpSendFailed"));
      setErrorMessage(message);
    } finally {
      setStatus("idle");
    }
  }, [toast, t, twoFactorOtp, smsAvailable]);

  const verifyOtp = useCallback(async () => {
    setStatus("submitting");
    setErrorMessage(null);
    try {
      const result = await twoFactorOtp.verifyOtp({
        code: code.trim(),
        trustDevice,
      });
      if (result?.error) throw result.error;
      completeVerification();
    } catch (error) {
      console.error("[2fa-challenge] verifyOtp failed", error);
      const message =
        (error as { message?: string } | null)?.message ??
        String(t("auth.tfcInvalidCode"));
      setErrorMessage(message);
      setCode("");
      inputRef.current?.focus();
    } finally {
      if (status !== "verified") setStatus("idle");
    }
  }, [code, trustDevice, completeVerification, t, status, twoFactorOtp]);

  // ── Verify backup code ───────────────────────────────────
  const verifyBackup = useCallback(async () => {
    setStatus("submitting");
    setErrorMessage(null);
    try {
      // Better Auth accepts backup codes via the same TOTP verify endpoint
      const result = await authClient.twoFactor.verifyTotp({
        code: code.trim(),
        trustDevice,
      });
      if (result.error) throw result.error;
      completeVerification();
    } catch (error) {
      console.error("[2fa-challenge] verifyBackup failed", error);
      const message =
        (error as { message?: string } | null)?.message ??
        String(t("auth.tfcInvalidBackup"));
      setErrorMessage(message);
      setCode("");
      inputRef.current?.focus();
    } finally {
      if (status !== "verified") setStatus("idle");
    }
  }, [code, trustDevice, completeVerification, t, status]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canSubmit) return;

      switch (method) {
        case "totp":
          void verifyTotp();
          break;
        case "otp":
          void verifyOtp();
          break;
        case "backup":
          void verifyBackup();
          break;
      }
    },
    [canSubmit, method, verifyTotp, verifyOtp, verifyBackup],
  );

  const switchMethod = useCallback((newMethod: ChallengeMethod) => {
    setMethod(newMethod);
    setCode("");
    setErrorMessage(null);
    setOtpSent(false);
  }, []);

  // Auto-submit when exactly 6 digits are entered (TOTP or OTP only)
  const autoSubmitTriggered = useRef(false);
  useEffect(() => {
    if (method === "backup" || status !== "idle") return;
    const trimmed = code.trim();
    if (trimmed.length === 6 && !autoSubmitTriggered.current) {
      autoSubmitTriggered.current = true;
      void (method === "totp" ? verifyTotp() : verifyOtp());
    }
    if (trimmed.length < 6) {
      autoSubmitTriggered.current = false;
    }
  }, [code, method, status, verifyTotp, verifyOtp]);

  const isSubmitting = status === "submitting";
  const isVerified = status === "verified";
  const isSendingOtp = status === "sending-otp";
  const isBusy = isSubmitting || isSendingOtp || isVerified;

  useEffect(() => {
    if (!isVerified) return;
    const id = requestAnimationFrame(() => successRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [isVerified]);

  if (isVerified) {
    return (
      <AuthCardShell
        testId="auth-2fa-challenge-card"
        // UNCOUNTED, and amber. A 2FA challenge is not step 3 of signing in —
        // it fires only for accounts that have it on, so numbering it would
        // move sign-in's total underneath the reader.
        step={{ kind: "interruption", name: "Security check" }}
      >
        <YStack
          ref={successRef as never}
          role="status"
          aria-live="polite"
          tabIndex={-1}
          className="th-auth-success-pop"
          alignItems="center"
          justifyContent="center"
          gap="$3"
          paddingVertical="$8"
        >
          <YStack
            width={64}
            height={64}
            borderRadius={0}
            backgroundColor="$accentSoft"
            alignItems="center"
            justifyContent="center"
          >
            <CheckCircle
              size={32}
              color="var(--accent, #E2481D)"
              aria-hidden="true"
            />
          </YStack>
          <Text variant="h4" tag="h1" textAlign="center">
            {String(t("auth.tfcVerified"))}
          </Text>
        </YStack>
      </AuthCardShell>
    );
  }

  return (
    <AuthCardShell
      testId="auth-2fa-challenge-card"
      // UNCOUNTED, and amber. A 2FA challenge is not step 3 of signing in — it
      // fires only for accounts that have it on, so numbering it would move
      // sign-in's total underneath the reader.
      step={{ kind: "interruption", name: "Security check" }}
    >
      {/* Header */}
      <YStack alignItems="center" gap="$3">
        <YStack
          width={56}
          height={56}
          borderRadius={0}
          backgroundColor="$accentSoft"
          alignItems="center"
          justifyContent="center"
        >
          <ShieldCheck
            size={28}
            color="var(--accent, #E2481D)"
            aria-hidden="true"
          />
        </YStack>
        <YStack gap="$2" alignItems="center">
          <Text variant="h4" tag="h1" textAlign="center">
            {String(t("auth.tfcTitle"))}
          </Text>
          <Text
            variant="body"
            color="$colorMuted"
            textAlign="center"
            lineHeight={24}
          >
            {method === "totp" && String(t("auth.tfcTotpDesc"))}
            {method === "otp" &&
              String(
                t(smsAvailable ? "auth.tfcOtpDesc" : "auth.tfcOtpDescEmail"),
              )}
            {method === "backup" && String(t("auth.tfcBackupDesc"))}
          </Text>
        </YStack>
      </YStack>

      {errorMessage && <Alert tone="error" description={errorMessage} />}

      {/* OTP: send code button */}
      {method === "otp" && !otpSent && (
        <Button
          variant="primary"
          size="$4"
          width="100%"
          onPress={() => void sendOtp()}
          disabled={isBusy}
        >
          {/* The label rides the atom's own `ButtonText` (uppercase / 700 /
              +1.5px) rather than a `bodySmall` nested inside the button. */}
          {isSendingOtp ? <Spinner size="sm" /> : null}
          {isSendingOtp
            ? String(t("auth.tfcSendingOtp"))
            : String(t("auth.tfcSendOtp"))}
        </Button>
      )}

      {/* Code input form (always for TOTP/backup, after send for OTP) */}
      {(method !== "otp" || otpSent) && (
        <form
          onSubmit={handleSubmit}
          noValidate
          data-testid="auth-2fa-challenge-form"
        >
          <YStack gap="$4">
            <YStack gap="$2">
              {/* One label idiom across the flow — mono 11/2px/600, the same
                  as every field label on sign-in and sign-up. */}
              <Text variant="overline" color="$colorMuted">
                {method === "backup"
                  ? String(t("auth.tfcBackupLabel"))
                  : String(t("auth.tfcCodeLabel"))}
              </Text>
              <TextInput
                ref={inputRef as never}
                // `testId`, not a raw `data-testid`: `TextInput` re-asserts a
                // fixed set of DOM attributes after every render and REMOVES
                // `data-testid` when its own `testId` prop is empty, so the
                // raw form was being stripped off the element — verified in
                // the browser 2026-09-06, the selector matched nothing. It is
                // unused by the e2e suite today, which is why nobody noticed.
                testId="auth-2fa-challenge-code"
                value={code}
                onChangeText={(v) => {
                  // Allow only digits for TOTP/OTP, alphanumeric for backup
                  const filtered =
                    method === "backup"
                      ? v.replace(/[^a-zA-Z0-9-]/g, "")
                      : v.replace(/\D/g, "");
                  setCode(filtered);
                  setErrorMessage(null);
                }}
                placeholder={
                  method === "backup"
                    ? (t("auth.tfcBackupPlaceholder") as string)
                    : (t("auth.tfcCodePlaceholder") as string)
                }
                inputMode={method === "backup" ? "text" : "numeric"}
                autoComplete="one-time-code"
                autoCapitalize="none"
                autoCorrect={false}
                fullWidth
                disabled={isBusy}
                maxLength={method === "backup" ? 20 : 6}
                // The only field in the flow that carried NO rejected state.
                // That is an a11y gap on its own — every sibling field sets
                // both — but it also reads as nothing at all on screen: the
                // auth-scoped focus rule in `globals.css` holds a focused
                // valid field at ink, and the reader's cursor is still in this
                // box when the code comes back wrong, so a rejected code left
                // the field looking untouched. `Alert` above stays: it carries
                // the reason, this carries which control it is about.
                status={errorMessage ? "error" : undefined}
                aria-invalid={errorMessage ? true : undefined}
              />
            </YStack>

            {/* Trust device checkbox */}
            <XStack
              gap="$2"
              alignItems="center"
              minHeight={44}
              cursor="pointer"
              onPress={toggleTrustDevice}
              {...({
                onKeyDown: handleTrustKeyDown,
                role: "checkbox",
                "aria-checked": trustDevice,
                tabIndex: 0,
              } as Record<string, unknown>)}
            >
              <XStack
                width={18}
                height={18}
                borderRadius={0}
                borderWidth={1.5}
                borderColor={trustDevice ? "$accent" : "$colorMuted"}
                backgroundColor={trustDevice ? "$accent" : "transparent"}
                alignItems="center"
                justifyContent="center"
              >
                {trustDevice && (
                  // `overline` IS 11/14 — the exact metrics the inline style
                  // was hand-setting on top of a `bodySmall`.
                  <Text variant="overline" color="$onBrandSecondary">
                    ✓
                  </Text>
                )}
              </XStack>
              <Text variant="bodySmall" color="$colorMuted">
                {String(t("auth.tfcTrustDevice"))}
              </Text>
            </XStack>

            <Button
              data-testid="auth-2fa-challenge-submit"
              size="$4"
              width="100%"
              disabled={!canSubmit || isBusy}
              disabledStyle={RECEDING_DISABLED}
            >
              {isSubmitting ? <Spinner size="sm" /> : null}
              {isSubmitting
                ? String(t("auth.tfcVerifying"))
                : String(t("auth.tfcVerify"))}
            </Button>

            {/* Resend OTP */}
            {method === "otp" && otpSent && (
              <Button
                variant="ghost"
                size="$3"
                onPress={() => void sendOtp()}
                disabled={isBusy}
              >
                {String(t("auth.tfcResendOtp"))}
              </Button>
            )}
          </YStack>
        </form>
      )}

      <Separator />

      {/* Method switcher */}
      <YStack gap="$2">
        {/* A label ABOUT the row of choices below it, not prose. */}
        <Text variant="overline" color="$colorMuted" textAlign="center">
          {String(t("auth.tfcOtherMethods"))}
        </Text>
        <XStack gap="$2" justifyContent="center" flexWrap="wrap">
          {method !== "totp" && (
            <Button
              variant="ghost"
              size="$3"
              onPress={() => switchMethod("totp")}
              disabled={isBusy}
            >
              <ShieldCheck size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
              {String(t("auth.tfcMethodTotp"))}
            </Button>
          )}
          {method !== "otp" && (
            <Button
              variant="ghost"
              size="$3"
              onPress={() => switchMethod("otp")}
              disabled={isBusy}
            >
              <Mail size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
              {String(
                t(smsAvailable ? "auth.tfcMethodOtp" : "auth.tfcMethodOtpEmail"),
              )}
            </Button>
          )}
          {method !== "backup" && (
            <Button
              variant="ghost"
              size="$3"
              onPress={() => switchMethod("backup")}
              disabled={isBusy}
            >
              <KeyRound size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
              {String(t("auth.tfcMethodBackup"))}
            </Button>
          )}
        </XStack>
      </YStack>

      {/* Back to sign-in */}
      {onBackAction && (
        <>
          <Separator />
          <XStack justifyContent="center">
            <Button
              variant="ghost"
              size="$3"
              onPress={onBackAction}
              disabled={isBusy}
            >
              {/* Was flame `$accent` on a 12px uppercase label — 3.89:1, under
                  the small-text floor — with the arrow as a literal "←"
                  character in the accessible name. Now a real icon (hidden
                  from the a11y tree) plus the atom's own label, which inherits
                  the ghost variant's ink. */}
              <ArrowLeft size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
              {String(t("auth.tfcBackToSignIn"))}
            </Button>
          </XStack>
        </>
      )}
    </AuthCardShell>
  );
};

TwoFactorChallengeCard.displayName = "TwoFactorChallengeCard";
