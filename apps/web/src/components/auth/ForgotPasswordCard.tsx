"use client";

import { FormEvent, useState } from "react";
import { ArrowLeft, Mail } from "lucide-react";
import {
  Alert,
  Button,
  LabeledTextInput,
  Spinner,
  Text,
  useTranslations,
} from "@th/ui";
import { XStack, YStack } from "tamagui";

import { authClient } from "@/lib/auth/auth-client";
import { AuthCardShell } from "./AuthCardShell";
import {
  AUTH_FOOTER_LINK,
  AUTH_FOOTER_LINK_TEXT,
  RECEDING_DISABLED,
} from "./auth-card-chrome";

export type ForgotPasswordCardProps = {
  /** Called when the user taps "Back to sign in". */
  onRequestSignInAction?: () => void;
};

export const ForgotPasswordCard = ({
  onRequestSignInAction,
}: ForgotPasswordCardProps) => {
  const t = useTranslations();

  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<
    "idle" | "submitting" | "sent" | "error"
  >("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canSubmit = email.trim().includes("@") && status !== "submitting";

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setStatus("submitting");
    setErrorMessage(null);

    try {
      const { error } = await authClient.requestPasswordReset({
        email: email.trim(),
        redirectTo: "/reset-password",
      });
      if (error) {
        throw error;
      }
      setStatus("sent");
    } catch (error) {
      console.error("[forgot-password] request failed", error);
      setStatus("error");
      const message =
        error instanceof Error
          ? error.message
          : (error as { message?: string } | null)?.message;
      setErrorMessage(message ?? (t("auth.fpError") as string));
    }
  };

  if (status === "sent") {
    return (
      <AuthCardShell
        testId="auth-forgot-password-sent"
        // The band FILLS on the terminal panel rather than resetting, so
        // "done" reads as done.
        step={{ kind: "counted", index: 2, total: 2, name: "Sent" }}
      >
        <YStack alignItems="center" gap="$4">
          <YStack
            width={56}
            height={56}
            borderRadius={0}
            backgroundColor="$backgroundStrong"
            alignItems="center"
            justifyContent="center"
          >
            <Mail size={28} color="var(--colorMuted)" />
          </YStack>

          {/* `h4` already IS uppercase Montserrat with negative tracking —
              the three props this replaces were hand-setting a variant. */}
          <Text variant="h4" tag="h1" textAlign="center">
            {t("auth.fpSentTitle") as string}
          </Text>

          {/* The email is interpolated into this sentence, and an address has
              no break opportunities — at 320 a long one ran straight past the
              card's edge. `anywhere` breaks it rather than overflowing. */}
          <Text
            variant="body"
            color="$colorMuted"
            textAlign="center"
            style={{ overflowWrap: "anywhere" }}
          >
            {t("auth.fpSentDescription", { email: email.trim() }) as string}
          </Text>

          {/* THE accent fill on this panel. There is no form left to submit —
              going back to sign in is the only thing to do here, so it is the
              page's action rather than navigation away from one. */}
          <Button size="$4" onPress={onRequestSignInAction}>
            <ArrowLeft size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
            {t("auth.fpBackToSignIn") as string}
          </Button>
        </YStack>
      </AuthCardShell>
    );
  }

  return (
    <AuthCardShell
      testId="auth-forgot-password-card"
      // Recovery is its own two-step flow with its own count, not a detour
      // inside sign-in: you LEAVE sign-in to do it.
      step={{ kind: "counted", index: 1, total: 2, name: "Request" }}
    >
      <Text variant="h4" tag="h1">
        {t("auth.fpTitle") as string}
      </Text>

      <Text variant="body" color="$colorMuted">
        {t("auth.fpDescription") as string}
      </Text>

      {errorMessage ? <Alert tone="error" description={errorMessage} /> : null}

      <form onSubmit={handleSubmit} noValidate>
        <YStack gap="$4">
          <LabeledTextInput
            label={t("auth.fpEmail") as string}
            labelVariant="overline"
            testId="auth-forgot-password-email"
            id="email"
            name="email"
            type="email"
            value={email}
            onChangeText={setEmail}
            placeholder={t("auth.fpEmailPlaceholder") as string}
            keyboardType="email-address"
            inputMode="email"
            autoCapitalize="none"
            autoComplete="email"
            autoFocus
            disabled={status === "submitting"}
          />

          <Button
            data-testid="auth-forgot-password-submit"
            // @ts-expect-error -- 'type' is valid in the DOM but not in Tamagui's Button typings
            type="submit"
            size="$4"
            width="100%"
            disabled={!canSubmit}
            disabledStyle={RECEDING_DISABLED}
          >
            {/* The label is the atom's own `ButtonText`, which already
                carries uppercase / 700 / +1.5px. */}
            {status === "submitting" ? (
              <Spinner size="sm" indicatorColor="$onBrandSecondary" />
            ) : null}
            {status === "submitting"
              ? (t("auth.fpSending") as string)
              : (t("auth.fpSendLink") as string)}
          </Button>

          {/* A mono text LINK, not an outlined button: leaving recovery is
              navigation, and as a bordered control it read at the same weight
              as the send button directly above it. */}
          <XStack
            {...AUTH_FOOTER_LINK}
            data-testid="auth-forgot-password-back"
            // @ts-expect-error -- 'type' is valid in the DOM but not in Tamagui's typings
            type="button"
            alignSelf="center"
            gap="$2"
            onPress={onRequestSignInAction}
          >
            <ArrowLeft
              size={14}
              color="var(--accentText, #A8300F)"
              aria-hidden="true"
              style={{ flexShrink: 0 }}
            />
            <Text {...AUTH_FOOTER_LINK_TEXT}>
              {t("auth.fpBackToSignIn") as string}
            </Text>
          </XStack>
        </YStack>
      </form>
    </AuthCardShell>
  );
};

ForgotPasswordCard.displayName = "ForgotPasswordCard";
