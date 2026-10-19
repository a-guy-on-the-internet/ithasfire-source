"use client";

import { useState, useCallback, useId } from "react";
import { YStack, XStack } from "tamagui";
import { Phone, ShieldCheck } from "lucide-react";
import {
  Text,
  Button,
  TextInput,
  Spinner,
  useNotify,
  useTranslations,
} from "@th/ui";
import { authClient } from "@/lib/auth/auth-client";
import { SmsLegalLinks } from "@/components/notifications/SmsLegalLinks";
import {
  SectionCard,
  FieldRow,
} from "./settings-primitives";

type PhoneStage =
  | "idle"
  | "entering"
  | "sending"
  | "verifying-code"
  | "verifying";

// Loose E.164 sanity check: leading "+", 8–15 digits. We don't try to be
// region-smart in the UI — the server (and downstream SMS provider) is the
// authority on what's actually deliverable.
const E164_REGEX = /^\+[1-9]\d{7,14}$/;

// Server codes for a refused text (apps/api/src/auth/otp-senders.ts and
// Better Auth's phoneNumberValidator), mapped to catalog keys so the toast
// never shows raw server English.
const SMS_ERROR_KEYS: Record<string, string> = {
  INVALID_PHONE_NUMBER: "account.sPhoneErrUsOnly",
  SMS_NUMBER_NOT_SUPPORTED: "account.sPhoneErrUsOnly",
  SMS_RATE_LIMITED: "account.sPhoneErrRateLimited",
  SMS_UNAVAILABLE: "account.sPhoneErrUnavailable",
};

function smsErrorKey(error: unknown): string | null {
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  if (typeof code === "string" && SMS_ERROR_KEYS[code]) {
    return SMS_ERROR_KEYS[code];
  }
  // Better Auth's own rate limiter answers 429 with a message and no code.
  return status === 429 ? "account.sPhoneErrRateLimited" : null;
}

export function PhoneNumberSection() {
  const { toast } = useNotify();
  const t = useTranslations();
  const phoneHintId = useId();
  const sessionQuery = authClient.useSession();
  const user = sessionQuery.data?.user as
    | (NonNullable<typeof sessionQuery.data>["user"] & {
        phoneNumber?: string | null;
        phoneNumberVerified?: boolean | null;
      })
    | undefined;

  const currentNumber = user?.phoneNumber ?? null;
  const isVerified = Boolean(user?.phoneNumberVerified);

  const [stage, setStage] = useState<PhoneStage>("idle");
  const [phoneInput, setPhoneInput] = useState("");
  const [otpInput, setOtpInput] = useState("");
  // Snapshot of the number we sent the OTP to — used to display "Code sent
  // to +1 555 ..." and as the canonical value passed to verify().
  const [pendingNumber, setPendingNumber] = useState<string | null>(null);

  const normalizedInput = phoneInput.trim();
  const inputValid = E164_REGEX.test(normalizedInput);

  const resetFlow = useCallback(() => {
    setStage("idle");
    setPhoneInput("");
    setOtpInput("");
    setPendingNumber(null);
  }, []);

  const startChangeFlow = useCallback(() => {
    setStage("entering");
    setPhoneInput(currentNumber ?? "");
    setOtpInput("");
    setPendingNumber(null);
  }, [currentNumber]);

  const handleSendCode = useCallback(async () => {
    if (!inputValid) return;
    setStage("sending");
    try {
      const result = await authClient.phoneNumber.sendOtp({
        phoneNumber: normalizedInput,
      });
      if (result.error) throw result.error;
      setPendingNumber(normalizedInput);
      setStage("verifying-code");
      toast.success({
        id: "phone-otp-sent",
        title: "CODE SENT",
        message: `We texted a 6-digit code to ${normalizedInput}.`,
      });
    } catch (error) {
      console.error("[phone] sendOtp failed", error);
      const key = smsErrorKey(error);
      const message = key
        ? String(t(key))
        : ((error as { message?: string } | null)?.message ??
          "Couldn't send the verification code. Check the number and try again.");
      toast.danger({
        id: "phone-otp-send-failed",
        title: "COULDN'T SEND CODE",
        message,
      });
      setStage("entering");
    }
  }, [inputValid, normalizedInput, t, toast]);

  const handleVerify = useCallback(async () => {
    if (!pendingNumber || otpInput.trim().length < 4) return;
    setStage("verifying");
    try {
      const result = await authClient.phoneNumber.verify({
        phoneNumber: pendingNumber,
        code: otpInput.trim(),
        updatePhoneNumber: true,
      });
      if (result.error) throw result.error;
      toast.success({
        id: "phone-verified",
        title: "PHONE VERIFIED",
        message:
          "We'll use SMS for 2FA codes if your authenticator is unavailable.",
      });
      resetFlow();
      void sessionQuery.refetch();
    } catch (error) {
      console.error("[phone] verify failed", error);
      const message =
        (error as { message?: string } | null)?.message ??
        "That code didn't match. Try again or request a new one.";
      toast.danger({
        id: "phone-verify-failed",
        title: "VERIFICATION FAILED",
        message,
      });
      setOtpInput("");
      setStage("verifying-code");
    }
  }, [otpInput, pendingNumber, resetFlow, sessionQuery, toast]);

  // ── Idle state: show current number (verified or not) + change CTA ──
  if (stage === "idle") {
    return (
      <SectionCard>
        <XStack gap="$2" alignItems="center">
          <Phone size={18} color="$colorMuted" />
          <Text variant="h4" weight="bold">
            PHONE NUMBER
          </Text>
        </XStack>

        <YStack gap="$2">
          {currentNumber ? (
            <XStack gap="$2" alignItems="center" flexWrap="wrap">
              <Text variant="body" fontFamily="$mono">
                {currentNumber}
              </Text>
              <XStack
                paddingHorizontal="$2"
                paddingVertical="$1"
                borderRadius={0}
                backgroundColor={isVerified ? "$green3" : "$surfaceMuted"}
                alignItems="center"
                gap="$1"
              >
                {isVerified ? (
                  <ShieldCheck size={12} color="var(--success)" />
                ) : null}
                <Text
                  variant="bodySmall"
                  weight="bold"
                  color={isVerified ? "$green10" : "$colorMuted"}
                >
                  {isVerified ? "VERIFIED" : "UNVERIFIED"}
                </Text>
              </XStack>
            </XStack>
          ) : (
            <Text variant="body" tone="muted">
              No phone number on file.
            </Text>
          )}

          <Text variant="caption" tone="muted">
            A verified phone number can receive 2FA codes by SMS — handy if
            you're without your authenticator app — and unlocks the SMS
            switches in Notification preferences.
          </Text>
        </YStack>

        <XStack>
          <Button variant="primary" size="$3" onPress={startChangeFlow}>
            {currentNumber ? "CHANGE NUMBER" : "ADD A PHONE NUMBER"}
          </Button>
        </XStack>
      </SectionCard>
    );
  }

  // ── Active flow: enter number / send code / verify code ──
  return (
    <SectionCard>
      <XStack gap="$2" alignItems="center">
        <Phone size={18} color="$colorMuted" />
        <Text variant="h4" weight="bold">
          PHONE NUMBER
        </Text>
      </XStack>

      {(stage === "entering" || stage === "sending") && (
        <YStack gap="$3">
          <FieldRow>
            <Text variant="caption" tone="muted" weight="medium">
              PHONE NUMBER (E.164 FORMAT)
            </Text>
            <TextInput
              value={phoneInput}
              onChangeText={setPhoneInput}
              placeholder="+15555550123"
              aria-label="Phone number"
              aria-describedby={phoneHintId}
              autoComplete="tel"
              keyboardType="phone-pad"
              inputMode="tel"
              testId="phone-number-input"
              fullWidth
            />
            <Text id={phoneHintId} variant="caption" tone="muted">
              {t("account.sPhoneHint")}
            </Text>
            <Text variant="caption" tone="muted">
              By tapping SEND CODE, you agree to get security-code texts from
              Ithas Fire: one text each time you ask for a code. A phone number
              is optional and not required to use Ithas Fire. Msg & data rates
              may apply.
              Reply STOP to opt out, HELP for help. <SmsLegalLinks />
            </Text>
          </FieldRow>

          <XStack gap="$3" justifyContent="flex-end">
            <Button
              variant="ghost"
              size="$3"
              onPress={resetFlow}
              disabled={stage === "sending"}
            >
              CANCEL
            </Button>
            <Button
              variant="primary"
              size="$3"
              onPress={() => void handleSendCode()}
              disabled={!inputValid || stage === "sending"}
            >
              {stage === "sending" ? <Spinner size="sm" /> : "SEND CODE"}
            </Button>
          </XStack>
        </YStack>
      )}

      {(stage === "verifying-code" || stage === "verifying") &&
        pendingNumber && (
          <YStack gap="$3">
            <Text variant="body" tone="muted">
              Enter the 6-digit code we texted to{" "}
              <Text variant="body" weight="bold" fontFamily="$mono">
                {pendingNumber}
              </Text>
              .
            </Text>

            <FieldRow>
              <Text variant="caption" tone="muted" weight="medium">
                VERIFICATION CODE
              </Text>
              <TextInput
                value={otpInput}
                onChangeText={setOtpInput}
                placeholder="123456"
                aria-label="Verification code"
                autoComplete="one-time-code"
                keyboardType="number-pad"
                inputMode="numeric"
                maxLength={6}
                testId="phone-otp-input"
                fullWidth
              />
            </FieldRow>

            <XStack gap="$3" justifyContent="flex-end">
              <Button
                variant="ghost"
                size="$3"
                onPress={resetFlow}
                disabled={stage === "verifying"}
              >
                CANCEL
              </Button>
              <Button
                variant="ghost"
                size="$3"
                onPress={() => void handleSendCode()}
                disabled={stage === "verifying"}
              >
                RESEND
              </Button>
              <Button
                variant="primary"
                size="$3"
                onPress={() => void handleVerify()}
                disabled={otpInput.trim().length < 4 || stage === "verifying"}
              >
                {stage === "verifying" ? <Spinner size="sm" /> : "VERIFY"}
              </Button>
            </XStack>
          </YStack>
        )}
    </SectionCard>
  );
}
