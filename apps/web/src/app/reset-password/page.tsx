"use client";

import { FormEvent, Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { AlertTriangle, ArrowLeft, CheckCircle } from "lucide-react";
import {
  Alert,
  Button,
  LabeledPasswordInput,
  Spinner,
  Text,
  useTranslations,
} from "@th/ui";
import { XStack, YStack } from "tamagui";

import { authClient } from "@/lib/auth/auth-client";
import { AuthCardShell } from "@/components/auth/AuthCardShell";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

const ResetPasswordPage = () => {
  const t = useTranslations();
  const router = useRouter();
  const params = useSearchParams();

  useDocumentTitle(String(t("auth.rpTitle")));

  const token = params.get("token") ?? "";
  const errorParam = params.get("error");

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState<
    "idle" | "submitting" | "success" | "error"
  >("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(
    errorParam === "INVALID_TOKEN" ? null : null, // will be set in effect
  );

  const passwordsMatch = newPassword === confirmPassword;
  const meetsMinLength = newPassword.length >= 10;
  const canSubmit =
    token.length > 0 &&
    meetsMinLength &&
    passwordsMatch &&
    status !== "submitting";
  const toggleLabel = String(t("auth.lcTogglePw"));
  const visibleStateLabel = String(t("auth.lcPwVisible"));
  const hiddenStateLabel = String(t("auth.lcPwHidden"));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (!passwordsMatch) {
      setErrorMessage(t("auth.rpPasswordsMismatch") as string);
      return;
    }

    setStatus("submitting");
    setErrorMessage(null);

    try {
      const result = await authClient.resetPassword({
        newPassword,
        token,
      });

      if (result?.error) {
        setStatus("error");
        setErrorMessage(result.error.message ?? (t("auth.rpError") as string));
        return;
      }

      setStatus("success");
    } catch (error) {
      console.error("[reset-password] resetPassword failed", error);
      setStatus("error");
      const message =
        error instanceof Error
          ? error.message
          : (error as { message?: string } | null)?.message;
      setErrorMessage(message ?? (t("auth.rpError") as string));
    }
  };

  // Invalid or expired token
  if (errorParam === "INVALID_TOKEN" || (!token && status === "idle")) {
    return (
      <YStack
        flex={1}
        alignItems="center"
        justifyContent="center"
        padding="$6"
        minHeight="60vh"
      >
        <AuthCardShell testId="auth-reset-password-invalid">
          <YStack alignItems="center" gap="$4">
            <AlertTriangle size={32} color="var(--colorMuted)" />

            <Text
              variant="h4"
              weight="bold"
              textTransform="uppercase"
              letterSpacing={-0.5}
            >
              {t("auth.rpInvalidTitle") as string}
            </Text>

            <Text variant="body" color="$colorMuted" textAlign="center">
              {t("auth.rpInvalidDescription") as string}
            </Text>

            <Button
              variant="outlined"
              size="$3"
              onPress={() => router.push("/forgot-password")}
              borderWidth={2}
            >
              {t("auth.rpRequestNewLink") as string}
            </Button>
          </YStack>
        </AuthCardShell>
      </YStack>
    );
  }

  // Success state
  if (status === "success") {
    return (
      <YStack
        flex={1}
        alignItems="center"
        justifyContent="center"
        padding="$6"
        minHeight="60vh"
      >
        <AuthCardShell testId="auth-reset-password-success">
          <YStack alignItems="center" gap="$4">
            {/* Stub's success is the deep #166534, not Swiss/Ember's bright
                green — bright fills wash out entirely on warm paper (see
                tokens/colors.ts). The Stub hex is the SSR fallback (v2 §2). */}
            <CheckCircle size={32} color="var(--success, #166534)" />

            <Text
              variant="h4"
              weight="bold"
              textTransform="uppercase"
              letterSpacing={-0.5}
            >
              {t("auth.rpSuccessTitle") as string}
            </Text>

            <Text variant="body" color="$colorMuted" textAlign="center">
              {t("auth.rpSuccessDescription") as string}
            </Text>

            <Button
              size="$4"
              width="100%"
              onPress={() => router.push("/sign-in")}
            >
              {t("auth.rpSignIn") as string}
            </Button>
          </YStack>
        </AuthCardShell>
      </YStack>
    );
  }

  return (
    <YStack
      flex={1}
      alignItems="center"
      justifyContent="center"
      padding="$6"
      minHeight="60vh"
    >
      <AuthCardShell testId="auth-reset-password-card">
        <Text
          variant="h4"
          weight="bold"
          textTransform="uppercase"
          letterSpacing={-0.5}
        >
          {t("auth.rpTitle") as string}
        </Text>

        <Text variant="body" color="$colorMuted">
          {t("auth.rpDescription") as string}
        </Text>

        {errorMessage ? (
          <Alert
            tone="error"
            icon={<AlertTriangle size={18} />}
            description={errorMessage}
          />
        ) : null}

        <form onSubmit={handleSubmit} noValidate>
          <YStack gap="$4">
            <LabeledPasswordInput
              label={t("auth.rpNewPassword") as string}
              testId="auth-reset-password-new"
              id="new-password"
              name="new-password"
              value={newPassword}
              onChangeText={setNewPassword}
              placeholder={t("auth.rpNewPasswordPlaceholder") as string}
              autoCapitalize="none"
              autoComplete="new-password"
              autoFocus
              disabled={status === "submitting"}
              status={
                newPassword.length > 0 && !meetsMinLength ? "error" : undefined
              }
              toggleLabel={toggleLabel}
              visibleStateLabel={visibleStateLabel}
              hiddenStateLabel={hiddenStateLabel}
              helperText={
                newPassword.length > 0 && !meetsMinLength
                  ? (t("auth.rpMinLength") as string)
                  : undefined
              }
            />

            <LabeledPasswordInput
              label={t("auth.rpConfirmPassword") as string}
              testId="auth-reset-password-confirm"
              id="confirm-password"
              name="confirm-password"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder={t("auth.rpConfirmPasswordPlaceholder") as string}
              autoCapitalize="none"
              autoComplete="new-password"
              disabled={status === "submitting"}
              toggleLabel={toggleLabel}
              visibleStateLabel={visibleStateLabel}
              hiddenStateLabel={hiddenStateLabel}
              status={
                confirmPassword.length > 0 && !passwordsMatch
                  ? "error"
                  : undefined
              }
              helperText={
                confirmPassword.length > 0 && !passwordsMatch
                  ? (t("auth.rpPasswordsMismatch") as string)
                  : undefined
              }
            />

            <Button
              data-testid="auth-reset-password-submit"
              // @ts-expect-error -- 'type' is valid in the DOM but not in Tamagui's Button typings
              type="submit"
              size="$4"
              width="100%"
              disabled={!canSubmit}
            >
              {status === "submitting" ? (
                <XStack alignItems="center" justifyContent="center" gap="$2">
                  <Spinner size="sm" indicatorColor="$onBrandSecondary" />
                  <Text
                    variant="bodySmall"
                    color="$onBrandSecondary"
                    textTransform="uppercase"
                    letterSpacing={1}
                    weight="bold"
                  >
                    {t("auth.rpResetting") as string}
                  </Text>
                </XStack>
              ) : (
                (t("auth.rpResetPassword") as string)
              )}
            </Button>

            <Button
              variant="outlined"
              size="$3"
              onPress={() => router.push("/sign-in")}
              borderWidth={2}
            >
              <XStack alignItems="center" gap="$2">
                <ArrowLeft size={16} />
                <Text
                  tone="inherit"
                  variant="bodySmall"
                  textTransform="uppercase"
                  letterSpacing={1}
                  weight="bold"
                >
                  {t("auth.fpBackToSignIn") as string}
                </Text>
              </XStack>
            </Button>
          </YStack>
        </form>
      </AuthCardShell>
    </YStack>
  );
};

export default function ResetPasswordPageWrapper() {
  return (
    <Suspense
      fallback={
        <YStack
          flex={1}
          alignItems="center"
          justifyContent="center"
          minHeight="60vh"
        >
          <Spinner />
        </YStack>
      }
    >
      <ResetPasswordPage />
    </Suspense>
  );
}
