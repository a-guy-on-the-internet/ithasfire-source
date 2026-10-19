"use client";

import { useState, useCallback } from "react";
import { YStack, XStack } from "tamagui";
import { ShieldCheck, Copy, Check } from "lucide-react";
import {
  Text,
  Button,
  PasswordInput,
  Spinner,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";
import { authClient } from "@/lib/auth/auth-client";
import { trpc } from "@/trpc";
import { QRCodeSVG } from "qrcode.react";
import {
  SectionCard,
  FieldRow,
} from "./settings-primitives";

type TfaSettingsStage =
  | "idle"
  | "method-pick"
  | "password-enable"
  | "enabling"
  | "qr"
  | "verify"
  | "verifying"
  | "email-sending"
  | "email-verify"
  | "email-verifying"
  | "password-disable"
  | "disabling"
  | "password-regen"
  | "regenerating"
  | "regen-backup";

type TfaMethod = "totp" | "email";

// See note in Setup2faCard — Better Auth's OTP client methods aren't in the
// public TS types but exist at runtime on `authClient.twoFactor`.
type TwoFactorOtpClient = {
  sendOtp: () => Promise<{ error?: { message?: string } | null }>;
  verifyOtp: (input: {
    code: string;
  }) => Promise<{ error?: { message?: string } | null; data?: unknown }>;
};

export function TwoFactorSection() {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const sessionQuery = authClient.useSession();
  const user = sessionQuery.data?.user as
    | (NonNullable<typeof sessionQuery.data>["user"] & {
        twoFactorEnabled?: boolean;
      })
    | undefined;

  const isEnabled = user?.twoFactorEnabled ?? false;

  const [stage, setStage] = useState<TfaSettingsStage>("idle");
  const [method, setMethod] = useState<TfaMethod>("totp");
  const [password, setPassword] = useState("");
  const [totpURI, setTotpURI] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [verifyCode, setVerifyCode] = useState("");

  const twoFactorOtp = authClient.twoFactor as unknown as TwoFactorOtpClient;

  // The /platform and /moderate shells cache checkStaffAccess /
  // checkModeratorAccess with a 5-minute staleTime; without invalidation a
  // freshly-enrolled staff user is served the cached
  // `secondFactorEnrolled: false` and bounced back to /enroll-2fa.
  // Fire-and-forget: enrollment UX must not depend on these refetches, and
  // for non-staff users the queries aren't in cache so this is a no-op.
  const invalidateSecondFactorGates = useCallback(() => {
    void utils.platform.checkStaffAccess.invalidate();
    void utils.community.checkModeratorAccess.invalidate();
  }, [utils]);

  const resetState = useCallback(() => {
    setStage("idle");
    setPassword("");
    setTotpURI(null);
    setSecret(null);
    setBackupCodes([]);
    setCopied(false);
    setVerifyCode("");
  }, []);

  // ── Email OTP send (after enable, before twoFactorEnabled flips) ──
  const handleSendEmailOtp = useCallback(async () => {
    setStage("email-sending");
    try {
      const result = await twoFactorOtp.sendOtp();
      if (result.error) throw result.error;
      setStage("email-verify");
    } catch (error) {
      console.error("[2fa] sendOtp failed", error);
      const message =
        (error as { message?: string } | null)?.message ??
        String(t("account.s2faFailedMsg"));
      toast.danger({
        id: "2fa-send-otp-failed",
        title: String(t("account.s2faFailedTitle")),
        message,
      });
      setStage("password-enable");
    }
  }, [twoFactorOtp, toast, t]);

  // ── Enable 2FA (TOTP or Email path, branches after the enable call) ──
  const handleEnable = useCallback(async () => {
    if (password.length < 6) return;
    setStage("enabling");
    try {
      const result = await authClient.twoFactor.enable({ password });
      if (result.error) throw result.error;

      const data = result.data as { totpURI?: string; backupCodes?: string[] };
      setTotpURI(data.totpURI ?? null);
      setBackupCodes(data.backupCodes ?? []);

      if (data.totpURI) {
        const match = data.totpURI.match(/secret=([A-Za-z0-9]+)/);
        if (match) setSecret(match[1]);
      }

      if (method === "email") {
        // Email path — skip QR, immediately send an OTP for confirmation.
        // The TOTP secret stays on the row but the user never uses it.
        await handleSendEmailOtp();
        return;
      }

      setStage("qr");
    } catch (error) {
      console.error("[2fa] enable failed", error);
      const message =
        (error as { message?: string } | null)?.message ??
        String(t("account.s2faFailedMsg"));
      toast.danger({
        id: "2fa-enable-failed",
        title: String(t("account.s2faFailedTitle")),
        message,
      });
      setStage("password-enable");
    }
  }, [password, method, handleSendEmailOtp, t, toast]);

  // ── Disable 2FA ────────────────────────────────────────
  const handleDisable = useCallback(async () => {
    if (password.length < 6) return;
    setStage("disabling");
    try {
      const result = await authClient.twoFactor.disable({ password });
      if (result.error) throw result.error;

      toast.success({
        id: "2fa-disabled",
        title: String(t("account.s2faDisabledTitle")),
        message: String(t("account.s2faDisabledMsg")),
      });
      resetState();
      // Refresh session to pick up twoFactorEnabled: false
      void sessionQuery.refetch();
      invalidateSecondFactorGates();
    } catch (error) {
      console.error("[2fa] disable failed", error);
      const message =
        (error as { message?: string } | null)?.message ??
        String(t("account.s2faFailedMsg"));
      toast.danger({
        id: "2fa-disable-failed",
        title: String(t("account.s2faFailedTitle")),
        message,
      });
      setStage("password-disable");
    }
  }, [password, t, toast, resetState, sessionQuery, invalidateSecondFactorGates]);

  // ── Regenerate backup codes ────────────────────────────
  const handleRegenerate = useCallback(async () => {
    if (password.length < 6) return;
    setStage("regenerating");
    try {
      const result = await authClient.twoFactor.generateBackupCodes({
        password,
      });
      if (result.error) throw result.error;

      const data = result.data as { backupCodes?: string[] };
      setBackupCodes(data.backupCodes ?? []);

      toast.success({
        id: "2fa-backup-regen",
        title: String(t("account.s2faBackupRegenTitle")),
        message: String(t("account.s2faBackupRegenMsg")),
      });
      setStage("regen-backup");
    } catch (error) {
      console.error("[2fa] regenerate backup codes failed", error);
      const message =
        (error as { message?: string } | null)?.message ??
        String(t("account.s2faFailedMsg"));
      toast.danger({
        id: "2fa-regen-failed",
        title: String(t("account.s2faFailedTitle")),
        message,
      });
      setStage("password-regen");
    }
  }, [password, t, toast]);

  const handleCopySecret = useCallback(async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* no-op */
    }
  }, [secret]);

  const handleBackupDone = useCallback(() => {
    toast.success({
      id: "2fa-enabled",
      title: String(t("account.s2faEnabledTitle")),
      message: String(t("account.s2faEnabledMsg")),
    });
    resetState();
    void sessionQuery.refetch();
    // twoFactorEnabled just flipped true (shared success path for TOTP and
    // email-OTP verification) — refresh the staff/moderator gate probes.
    invalidateSecondFactorGates();
  }, [toast, t, resetState, sessionQuery, invalidateSecondFactorGates]);

  // ── Verify TOTP code — required to flip user.twoFactorEnabled ──
  const handleVerifyEnable = useCallback(async () => {
    const code = verifyCode.trim();
    if (code.length < 6) return;
    setStage("verifying");
    try {
      const result = await authClient.twoFactor.verifyTotp({ code });
      if (result.error) throw result.error;
      handleBackupDone();
    } catch (error) {
      console.error("[2fa] verifyTotp failed", error);
      const message =
        (error as { message?: string } | null)?.message ??
        String(t("auth.tfcInvalidCode"));
      toast.danger({
        id: "2fa-verify-failed",
        title: String(t("account.s2faFailedTitle")),
        message,
      });
      setVerifyCode("");
      setStage("verify");
    }
  }, [verifyCode, handleBackupDone, toast, t]);

  // ── Verify email OTP — flips user.twoFactorEnabled on first success ──
  const handleVerifyEmailEnable = useCallback(async () => {
    const code = verifyCode.trim();
    if (code.length < 6) return;
    setStage("email-verifying");
    try {
      const result = await twoFactorOtp.verifyOtp({ code });
      if (result.error) throw result.error;
      handleBackupDone();
    } catch (error) {
      console.error("[2fa] verifyOtp failed", error);
      const message =
        (error as { message?: string } | null)?.message ??
        String(t("auth.tfcInvalidCode"));
      toast.danger({
        id: "2fa-email-verify-failed",
        title: String(t("account.s2faFailedTitle")),
        message,
      });
      setVerifyCode("");
      setStage("email-verify");
    }
  }, [verifyCode, twoFactorOtp, handleBackupDone, toast, t]);

  const toggleLabel = String(t("account.sTogglePw"));
  const visibleStateLabel = String(t("account.sPwVisible"));
  const hiddenStateLabel = String(t("account.sPwHidden"));

  // ── Password prompt sub-form ──────────────────────────
  const renderPasswordPrompt = (
    action: "enable" | "disable" | "regen",
    onSubmit: () => void,
    submitting: boolean,
    submitLabel: string,
    submittingLabel: string,
  ) => (
    <YStack gap="$3">
      <FieldRow>
        <Text variant="caption" tone="muted" weight="medium">
          {String(t("account.s2faPasswordLabel"))}
        </Text>
        <PasswordInput
          value={password}
          onChangeText={setPassword}
          placeholder={String(t("account.s2faPasswordPlaceholder"))}
          autoComplete="current-password"
          toggleLabel={toggleLabel}
          visibleStateLabel={visibleStateLabel}
          hiddenStateLabel={hiddenStateLabel}
        />
      </FieldRow>
      <XStack gap="$3" justifyContent="flex-end">
        <Button
          variant="ghost"
          size="$3"
          onPress={resetState}
          disabled={submitting}
        >
          {String(t("account.s2faCancel"))}
        </Button>
        <Button
          variant={action === "disable" ? "outlined" : "primary"}
          size="$3"
          onPress={onSubmit}
          disabled={password.length < 6 || submitting}
        >
          {submitting ? <Spinner size="sm" /> : submitLabel}
        </Button>
      </XStack>
    </YStack>
  );

  return (
    <SectionCard>
      <XStack gap="$2" alignItems="center">
        <ShieldCheck size={18} color="$colorMuted" />
        <Text variant="h4" weight="bold">
          {String(t("account.s2faTitle"))}
        </Text>
      </XStack>

      {/* ── Status badge ── */}
      <XStack gap="$2" alignItems="center">
        <XStack
          paddingHorizontal="$2"
          paddingVertical="$1"
          borderRadius={0}
          backgroundColor={isEnabled ? "$green3" : "$surfaceMuted"}
        >
          <Text
            variant="bodySmall"
            weight="bold"
            color={isEnabled ? "$green10" : "$colorMuted"}
          >
            {isEnabled
              ? String(t("account.s2faStatusEnabled"))
              : String(t("account.s2faStatusDisabled"))}
          </Text>
        </XStack>
      </XStack>

      <Text variant="body" tone="muted">
        {isEnabled
          ? String(t("account.s2faEnabledDesc"))
          : String(t("account.s2faDisabledDesc"))}
      </Text>

      {/* ── Idle state: show action buttons ── */}
      {stage === "idle" && (
        <XStack gap="$3" flexWrap="wrap">
          {!isEnabled ? (
            <Button
              variant="primary"
              size="$3"
              onPress={() => {
                setPassword("");
                setMethod("totp");
                setStage("method-pick");
              }}
            >
              {String(t("account.s2faEnableBtn"))}
            </Button>
          ) : (
            <>
              <Button
                variant="outlined"
                size="$3"
                onPress={() => {
                  setPassword("");
                  setStage("password-disable");
                }}
              >
                {String(t("account.s2faDisableBtn"))}
              </Button>
              <Button
                variant="ghost"
                size="$3"
                onPress={() => {
                  setPassword("");
                  setStage("password-regen");
                }}
              >
                {String(t("account.s2faRegenBackup"))}
              </Button>
            </>
          )}
        </XStack>
      )}

      {/* ── Method picker — TOTP or Email OTP ── */}
      {stage === "method-pick" && (
        <YStack gap="$3">
          <Text variant="caption" tone="muted">
            Choose how you&apos;d like to receive 2FA codes.
          </Text>
          <XStack gap="$3" flexWrap="wrap">
            <Button
              variant="primary"
              size="$3"
              onPress={() => {
                setMethod("totp");
                setStage("password-enable");
              }}
            >
              USE AUTHENTICATOR APP
            </Button>
            <Button
              variant="outlined"
              size="$3"
              onPress={() => {
                setMethod("email");
                setStage("password-enable");
              }}
            >
              EMAIL ME CODES
            </Button>
            <Button
              variant="ghost"
              size="$3"
              onPress={() => setStage("idle")}
            >
              {String(t("account.s2faCancel"))}
            </Button>
          </XStack>
        </YStack>
      )}

      {/* ── Password prompt: enable (covers both TOTP + email paths because
          the enable call itself is the same; method state drives the
          branching after the password is verified) ── */}
      {(stage === "password-enable" ||
        stage === "enabling" ||
        stage === "email-sending") &&
        renderPasswordPrompt(
          "enable",
          () => {
            void handleEnable();
          },
          stage === "enabling" || stage === "email-sending",
          String(t("account.s2faEnableBtn")),
          String(t("account.s2faEnabling")),
        )}

      {/* ── Password prompt: disable ── */}
      {(stage === "password-disable" || stage === "disabling") &&
        renderPasswordPrompt(
          "disable",
          () => {
            void handleDisable();
          },
          stage === "disabling",
          String(t("account.s2faDisableBtn")),
          String(t("account.s2faDisabling")),
        )}

      {/* ── Password prompt: regenerate backup codes ── */}
      {(stage === "password-regen" || stage === "regenerating") && (
        <YStack gap="$3">
          <Text variant="caption" tone="muted">
            {String(t("account.s2faRegenBackupDesc"))}
          </Text>
          {renderPasswordPrompt(
            "regen",
            () => {
              void handleRegenerate();
            },
            stage === "regenerating",
            String(t("account.s2faRegenBtn")),
            String(t("account.s2faRegenerating")),
          )}
        </YStack>
      )}

      {/* ── QR code stage ── */}
      {stage === "qr" && (
        <YStack gap="$4">
          <YStack gap="$2">
            <Text variant="body" weight="medium">
              {String(t("account.s2faQrTitle"))}
            </Text>
            <Text variant="caption" tone="muted">
              {String(t("account.s2faQrDesc"))}
            </Text>
          </YStack>

          {totpURI && (
            <YStack
              alignItems="center"
              padding="$4"
              // True-white quiet zone — the user scans this TOTP QR with an
              // authenticator app. Required for scan reliability; not debt.
              backgroundColor="white"
              borderRadius={0}
              alignSelf="center"
            >
              <QRCodeSVG value={totpURI} size={180} />
            </YStack>
          )}

          {secret && (
            <YStack gap="$2">
              <Text variant="bodySmall" color="$colorMuted">
                {String(t("account.s2faManualEntry"))}
              </Text>
              <XStack
                alignItems="center"
                gap="$2"
                backgroundColor="$surfaceMuted"
                borderRadius={0}
                padding="$2"
                paddingHorizontal="$3"
              >
                <Text
                  variant="body"
                  fontFamily="$mono"
                  flex={1}
                  selectable
                  style={{
                    wordBreak: "break-all",
                    fontSize: 13,
                    letterSpacing: 1,
                  }}
                >
                  {secret}
                </Text>
                <Button
                  variant="ghost"
                  size="$2"
                  onPress={() => {
                    void handleCopySecret();
                  }}
                >
                  {copied ? (
                    <XStack alignItems="center" gap="$1">
                      <Check size={14} color="var(--accent)" />
                      <Text variant="bodySmall" color="$accent">
                        {String(t("account.s2faCopied"))}
                      </Text>
                    </XStack>
                  ) : (
                    <XStack alignItems="center" gap="$1">
                      <Copy size={14} color="var(--colorMuted)" />
                      <Text variant="bodySmall" color="$colorMuted">
                        {String(t("account.s2faCopySecret"))}
                      </Text>
                    </XStack>
                  )}
                </Button>
              </XStack>
            </YStack>
          )}

          <Button
            size="$3"
            variant="primary"
            onPress={() => setStage("verify")}
          >
            {String(t("auth.vecContinue"))}
          </Button>
        </YStack>
      )}

      {/* ── Verify stage — required to flip user.twoFactorEnabled on the
          server. Without this, the secret is stored but 2FA is never
          actually active for sign-ins. ── */}
      {(stage === "verify" || stage === "verifying") && (
        <YStack gap="$4">
          <YStack gap="$2">
            <Text variant="body" weight="medium">
              Confirm your authenticator
            </Text>
            <Text variant="caption" tone="muted">
              Enter the 6-digit code your authenticator app shows for
              Ithas Fire to finish enabling 2FA.
            </Text>
          </YStack>

          <FieldRow>
            <TextInput
              value={verifyCode}
              onChangeText={(value) =>
                setVerifyCode(value.replace(/\D/g, "").slice(0, 6))
              }
              placeholder="123456"
              keyboardType="number-pad"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              textAlign="center"
              fontSize={22}
              letterSpacing={6}
              minHeight={48}
              data-testid="2fa-settings-verify-code"
            />
          </FieldRow>

          <XStack gap="$3" justifyContent="flex-end">
            <Button
              variant="ghost"
              size="$3"
              onPress={() => {
                setVerifyCode("");
                setStage("qr");
              }}
              disabled={stage === "verifying"}
            >
              Back to QR
            </Button>
            <Button
              variant="primary"
              size="$3"
              onPress={() => void handleVerifyEnable()}
              disabled={verifyCode.length < 6 || stage === "verifying"}
            >
              {stage === "verifying" ? <Spinner size="sm" /> : "Verify & finish"}
            </Button>
          </XStack>
        </YStack>
      )}

      {/* ── Email verify stage — first verifyOtp flips twoFactorEnabled ── */}
      {(stage === "email-verify" || stage === "email-verifying") && (
        <YStack gap="$4">
          <YStack gap="$2">
            <Text variant="body" weight="medium">
              Check your email
            </Text>
            <Text variant="caption" tone="muted">
              We sent a 6-digit code to your inbox. Enter it below to finish
              enabling 2FA via email.
            </Text>
          </YStack>

          <FieldRow>
            <TextInput
              value={verifyCode}
              onChangeText={(value) =>
                setVerifyCode(value.replace(/\D/g, "").slice(0, 6))
              }
              placeholder="123456"
              keyboardType="number-pad"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              textAlign="center"
              fontSize={22}
              letterSpacing={6}
              minHeight={48}
              data-testid="2fa-settings-email-verify-code"
            />
          </FieldRow>

          <XStack gap="$3" justifyContent="flex-end">
            <Button
              variant="ghost"
              size="$3"
              onPress={() => void handleSendEmailOtp()}
              disabled={stage === "email-verifying"}
            >
              Resend
            </Button>
            <Button
              variant="primary"
              size="$3"
              onPress={() => void handleVerifyEmailEnable()}
              disabled={verifyCode.length < 6 || stage === "email-verifying"}
            >
              {stage === "email-verifying" ? (
                <Spinner size="sm" />
              ) : (
                "Verify & finish"
              )}
            </Button>
          </XStack>
        </YStack>
      )}

      {/* ── Backup codes stage (regen-only — initial enable skips this for
          a cleaner onboarding; users can opt in to regen at any time) ── */}
      {stage === "regen-backup" && (
        <YStack gap="$4">
          <YStack gap="$2">
            <Text variant="body" weight="medium">
              {String(t("account.s2faBackupTitle"))}
            </Text>
            <Text variant="caption" tone="muted">
              {String(t("account.s2faBackupDesc"))}
            </Text>
          </YStack>

          <YStack
            backgroundColor="$surfaceMuted"
            borderRadius={0}
            padding="$3"
            gap="$1"
          >
            {backupCodes.map((code, idx) => (
              <Text
                key={idx}
                variant="body"
                fontFamily="$mono"
                textAlign="center"
                style={{ fontSize: 14, letterSpacing: 2 }}
              >
                {code}
              </Text>
            ))}
          </YStack>

          <XStack justifyContent="flex-end">
            <Button variant="primary" size="$3" onPress={resetState}>
              {String(t("account.s2faBackupDone"))}
            </Button>
          </XStack>
        </YStack>
      )}
    </SectionCard>
  );
}
