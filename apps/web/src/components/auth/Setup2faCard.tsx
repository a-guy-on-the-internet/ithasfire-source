"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Button,
  Spinner,
  Text,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";
import { XStack, YStack, styled } from "tamagui";
import { ArrowLeft, Copy, Check, Mail } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { derivePasskeyName } from "@th/types";

import { authClient } from "@/lib/auth/auth-client";
import { detectDeviceLabel } from "@/lib/auth/device-label";
import { formatAuthErrorMessage, isWebAuthnCancel } from "./auth-helpers";
import { AuthCardShell } from "./AuthCardShell";
import {
  AUTH_FOOTER_LINK,
  AUTH_FOOTER_LINK_TEXT,
  AUTH_FOOTER_RULE,
  RECEDING_DISABLED,
} from "./auth-card-chrome";
import { SecureMethodChoice } from "./SecureMethodChoice";
import type { SecureMethod } from "./secure-method.helpers";

/** The two methods that go through Better Auth's `twoFactor.enable`. */
type TfaMethod = "totp" | "email";

type TfaStage =
  | "prompt"
  | "passkey-enrolling"
  | "enabling"
  | "qr"
  | "verify"
  | "verifying"
  | "email-sending"
  | "email-verify"
  | "email-verifying";

// Better Auth's twoFactor client surfaces `twoFactor.{sendOtp,verifyOtp}` at
// runtime but its public TS types only declare `twoFactor.{enable,disable,
// verifyTotp,generateBackupCodes}`. Narrow cast so we can call the OTP
// channel without `as any` everywhere.
type TwoFactorOtpClient = {
  sendOtp: () => Promise<{ error?: { message?: string } | null }>;
  verifyOtp: (input: {
    code: string;
  }) => Promise<{ error?: { message?: string } | null; data?: unknown }>;
};

/**
 * True when `addPasskey` reports that the reader dismissed the browser sheet
 * or let it time out — the outcome that deserves no toast.
 *
 * The passkey client CATCHES every WebAuthn failure and returns it as
 * `{ error }` rather than throwing (`@better-auth/passkey/dist/client.mjs`,
 * `registerPasskey`), so `isWebAuthnCancel` on a thrown value never sees a
 * cancel. SimpleWebAuthn maps the browser's `NotAllowedError` (dismiss AND
 * timeout) to `ERROR_CEREMONY_ABORTED`; the message check is the fallback for
 * a client that changes the code. Measured before this predicate existed:
 * cancelling the sheet toasted "registration cancelled" at the reader.
 */
function isPasskeyCancelResult(error: {
  code?: string;
  message?: string;
}): boolean {
  if (error.code === "ERROR_CEREMONY_ABORTED") return true;
  const message = (error.message ?? "").toLowerCase();
  return (
    message.includes("cancel") ||
    message.includes("not allowed") ||
    message.includes("timed out")
  );
}

/**
 * The footer rule. A hairline at 20% of the panel's foreground — see
 * `AUTH_FOOTER_RULE`.
 */
const Separator = styled(YStack, {
  name: "AuthFooterRule",
  ...AUTH_FOOTER_RULE,
});

export type Setup2faCardProps = {
  /** The password the user just signed up with, needed to enable 2FA. */
  password: string;
  onDoneAction: () => void;
  onSkipAction: () => void;
  /** Optional header rendered inside the card surface (e.g. step indicator). */
  cardHeader?: ReactNode;
};

/**
 * Step 3 of 4 — Secure.
 *
 * "Secure your account", not "set up 2FA": the step covers a passkey OR a
 * second factor, and passkey leads because it is the only option that makes
 * the next sign-in faster rather than slower. The rest of the panel is the
 * consolation prize for declining it.
 *
 * ## Passkey needs no panel of its own
 *
 * It is a browser ceremony. Choosing it and pressing Continue fires
 * `addPasskey`; success goes straight to step 4. The enrolment logic moved
 * here from `SignUpCard`'s post-sign-up prompt — a fifth screen asking one
 * question that now has a home — unchanged: same `derivePasskeyName`, same
 * `detectDeviceLabel`, so the name matches what account settings would mint.
 *
 * ## The ceremony can be refused, and that must not strand the reader
 *
 * Browsers only allow WebAuthn from a real user gesture, and the sheet can be
 * dismissed, time out, or fail. Every one of those lands the reader back on
 * THIS panel with the picker live and "Skip for now" reachable. Skip also
 * stays enabled DURING the ceremony: a sheet that hangs is not a reason to
 * trap someone on step 3.
 */
export const Setup2faCard = ({
  password,
  onDoneAction,
  onSkipAction,
  cardHeader,
}: Setup2faCardProps) => {
  const t = useTranslations();
  const { toast } = useNotify();
  const sessionQuery = authClient.useSession();
  const [stage, setStage] = useState<TfaStage>("prompt");
  const [choice, setChoice] = useState<SecureMethod>("passkey");
  const [totpURI, setTotpURI] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [verifyCode, setVerifyCode] = useState("");

  // Optimistic on first paint (every current browser has WebAuthn), then
  // confirmed after mount. Reading `window` during render would SSR one tree
  // and hydrate another; an effect keeps the two identical and only removes
  // the row where it genuinely cannot work.
  const [passkeySupported, setPasskeySupported] = useState(true);
  useEffect(() => {
    if (typeof window.PublicKeyCredential === "undefined") {
      setPasskeySupported(false);
      setChoice((current) => (current === "passkey" ? "totp" : current));
    }
  }, []);

  // The ceremony's promise outlives this card when the reader skips past it
  // mid-flight; nothing after the await may touch state or route once that
  // has happened.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const twoFactorOtp = authClient.twoFactor as unknown as TwoFactorOtpClient;

  // ── TOTP verify (first verifyTotp flips twoFactorEnabled + verified=true) ──
  const handleVerifyTotp = useCallback(async () => {
    const code = verifyCode.trim();
    if (code.length < 6) return;
    setStage("verifying");
    try {
      const result = await authClient.twoFactor.verifyTotp({ code });
      if (result.error) {
        console.error("[2fa] verifyTotp returned error", result.error);
        toast.danger(
          result.error.message ?? String(t("auth.tfcInvalidCode")),
        );
        setStage("verify");
        setVerifyCode("");
        return;
      }
      onDoneAction();
    } catch (error) {
      console.error("[2fa] verifyTotp threw", error);
      const message =
        error instanceof Error
          ? error.message
          : String(t("auth.tfcInvalidCode"));
      toast.danger(message);
      setStage("verify");
      setVerifyCode("");
    }
  }, [verifyCode, toast, t, onDoneAction]);

  // ── Email OTP send (after twoFactor.enable, before twoFactorEnabled flips) ──
  const handleSendEmailOtp = useCallback(async () => {
    setStage("email-sending");
    try {
      const result = await twoFactorOtp.sendOtp();
      if (result.error) {
        console.error("[2fa] sendOtp returned error", result.error);
        toast.danger(
          result.error.message ?? String(t("auth.tfcOtpSendFailed")),
        );
        setStage("prompt");
        return;
      }
      setStage("email-verify");
    } catch (error) {
      console.error("[2fa] sendOtp threw", error);
      const message =
        error instanceof Error
          ? error.message
          : String(t("auth.tfcOtpSendFailed"));
      toast.danger(message);
      setStage("prompt");
    }
  }, [twoFactorOtp, toast, t]);

  // ── Email OTP verify (first verifyOtp flips twoFactorEnabled=true) ──
  const handleVerifyEmail = useCallback(async () => {
    const code = verifyCode.trim();
    if (code.length < 6) return;
    setStage("email-verifying");
    try {
      const result = await twoFactorOtp.verifyOtp({ code });
      if (result.error) {
        console.error("[2fa] verifyOtp returned error", result.error);
        toast.danger(
          result.error.message ?? String(t("auth.tfcInvalidCode")),
        );
        setStage("email-verify");
        setVerifyCode("");
        return;
      }
      onDoneAction();
    } catch (error) {
      console.error("[2fa] verifyOtp threw", error);
      const message =
        error instanceof Error
          ? error.message
          : String(t("auth.tfcInvalidCode"));
      toast.danger(message);
      setStage("email-verify");
      setVerifyCode("");
    }
  }, [verifyCode, twoFactorOtp, toast, t, onDoneAction]);

  // ── Enable 2FA — same server call for both paths. Branches after the call
  // based on the user's chosen method. ──
  const handleEnable = useCallback(
    async (chosenMethod: TfaMethod) => {
      setStage("enabling");
      try {
        const result = await authClient.twoFactor.enable({ password });
        if (result.error) {
          console.error("[2fa] enable returned error", result.error);
          toast.danger(result.error.message ?? String(t("auth.tfaFailed")));
          setStage("prompt");
          return;
        }

        const data = result.data as { totpURI?: string };

        if (chosenMethod === "totp") {
          setTotpURI(data.totpURI ?? null);
          if (data.totpURI) {
            const match = data.totpURI.match(/secret=([A-Za-z0-9]+)/);
            if (match) setSecret(match[1]);
          }
          setStage("qr");
          return;
        }

        // Email path — discard the TOTP URI, immediately send an OTP and ask
        // the user to confirm it. The TOTP secret exists on the row but the
        // user never uses it. On future sign-ins they'll receive OTPs via
        // the same email channel.
        await handleSendEmailOtp();
      } catch (error) {
        console.error("[2fa] enable threw", error);
        const message =
          error instanceof Error ? error.message : String(t("auth.tfaFailed"));
        toast.danger(message);
        setStage("prompt");
      }
    },
    [password, toast, t, handleSendEmailOtp],
  );

  // ── Passkey — the browser ceremony, moved here from the sign-up card ──
  const handleAddPasskey = useCallback(async () => {
    setStage("passkey-enrolling");
    try {
      // Shared derivation (`@th/types`) so this name matches the one account
      // settings produces. No `existingNames`: this runs minutes after
      // sign-up, when the account has no other passkeys to collide with.
      // `userName` is whatever the account is called right now — between
      // steps 1 and 4 that is the email-derived placeholder.
      const result = await authClient.passkey.addPasskey({
        name: derivePasskeyName({
          deviceLabel: detectDeviceLabel(),
          userName: sessionQuery.data?.user?.name ?? undefined,
        }),
      });
      if (!mountedRef.current) return;
      if (result?.error) {
        // Dismissed / timed out → no toast; anything else is worth a word.
        // Either way the reader is back on the picker with Skip in reach.
        if (!isPasskeyCancelResult(result.error)) {
          toast.danger(formatAuthErrorMessage(result.error, t));
        }
        setStage("prompt");
        return;
      }
      onDoneAction();
    } catch (err) {
      if (!mountedRef.current) return;
      // The client returns rather than throws for WebAuthn failures, so this
      // is the network/unexpected path — but a thrown NotAllowedError still
      // reads as a cancel if one ever surfaces here.
      if (!isWebAuthnCancel(err)) {
        toast.danger(formatAuthErrorMessage(err, t));
      }
      setStage("prompt");
    }
  }, [sessionQuery.data?.user?.name, toast, t, onDoneAction]);

  const handleContinue = useCallback(() => {
    if (choice === "passkey") {
      void handleAddPasskey();
      return;
    }
    void handleEnable(choice);
  }, [choice, handleAddPasskey, handleEnable]);

  const handleCopySecret = useCallback(async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: no-op
    }
  }, [secret]);

  const returnToPicker = useCallback(() => {
    setVerifyCode("");
    setStage("prompt");
  }, []);

  const isEnabling = stage === "enabling" || stage === "email-sending";
  const isEnrollingPasskey = stage === "passkey-enrolling";
  const isBusy = isEnabling || isEnrollingPasskey;
  const showPicker = stage === "prompt" || isBusy;

  const continueLabel = isEnrollingPasskey
    ? String(t("auth.tfaEnabling"))
    : stage === "email-sending"
      ? "Sending code…"
      : isEnabling
        ? String(t("auth.tfaEnabling"))
        : String(t("auth.vecContinue"));

  const methodOptions = [
    ...(passkeySupported
      ? [
          {
            value: "passkey" as const,
            title: "Passkey",
            tag: "· fastest",
            description:
              "Touch ID, Face ID or a security key. No password to type next time.",
            testId: "auth-2fa-choose-passkey",
          },
        ]
      : []),
    {
      value: "totp" as const,
      title: "Authenticator app",
      description: "A code from an app on your phone. Works offline.",
      testId: "auth-2fa-enable-totp",
    },
    {
      value: "email" as const,
      title: "Email me codes",
      description: "A fresh code each time you sign in somewhere new.",
      testId: "auth-2fa-enable-email",
    },
  ];

  /** "← Choose another method" — the sub-states' way back to the picker. */
  const backToPicker = (
    <Button
      data-testid="auth-2fa-choose-another"
      variant="ghost"
      size="$2"
      alignSelf="flex-start"
      onPress={returnToPicker}
      disabled={stage === "verifying" || stage === "email-verifying"}
    >
      <ArrowLeft size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
      Choose another method
    </Button>
  );

  return (
    <AuthCardShell
      testId="auth-setup-2fa-card"
      step={{ kind: "counted", index: 3, total: 4, name: "Secure" }}
      header={cardHeader}
    >
      {/* ── Prompt stage — method picker ── */}
      {showPicker && (
        <>
          <YStack gap="$2">
            <Text variant="h4" tag="h1">
              Secure your account
            </Text>
            <Text variant="bodySmall" color="$colorMuted">
              Pick one. You can add the others later in settings.
            </Text>
          </YStack>

          <SecureMethodChoice
            label="How to secure your account"
            options={methodOptions}
            value={choice}
            onChangeAction={setChoice}
            disabled={isBusy}
          />

          {/* THE accent fill on this card. Never `disabled` while busy — that
              would dim the very spinner that is the feedback — so it takes
              `aria-busy` and guards its own press. */}
          <Button
            data-testid="auth-2fa-continue"
            size="$4"
            width="100%"
            aria-busy={isBusy ? true : undefined}
            aria-disabled={isBusy ? true : undefined}
            disabledStyle={RECEDING_DISABLED}
            onPress={() => {
              if (isBusy) return;
              handleContinue();
            }}
          >
            {isBusy ? (
              <Spinner size="sm" indicatorColor="$onBrandSecondary" />
            ) : null}
            {continueLabel}
          </Button>

          <Separator />

          {/* Skip is a footer LINK, and it stays live through the passkey
              ceremony: a browser sheet that never resolves must not hold the
              reader here. It only goes quiet for the two short server calls,
              where a skip mid-flight would race the enable. */}
          <XStack justifyContent="center" alignItems="center">
            <XStack
              {...AUTH_FOOTER_LINK}
              data-testid="auth-2fa-skip"
              // @ts-expect-error -- 'type' is valid in the DOM but not in Tamagui's typings
              type="button"
              disabled={isEnabling}
              onPress={onSkipAction}
            >
              <Text {...AUTH_FOOTER_LINK_TEXT}>{String(t("auth.tfaSkip"))}</Text>
            </XStack>
          </XStack>
        </>
      )}

      {/* ── QR code stage (TOTP only) ── */}
      {stage === "qr" && (
        <>
          <YStack gap="$3" alignItems="flex-start">
            {backToPicker}
            <Text variant="h4" tag="h1">
              {String(t("auth.tfaQrTitle"))}
            </Text>
            <Text variant="bodySmall" color="$colorMuted">
              {String(t("auth.tfaQrDescription"))}
            </Text>
          </YStack>

          {totpURI && (
            <YStack
              alignItems="center"
              padding="$4"
              /* ds-color-ok: QR quiet zone must be pure white to scan.
                 A QR reader thresholds the image; the cream `$surface`
                 (#FDFAF3) narrows the black/white gap the decoder is looking
                 for, and cheap phone cameras in bad light lose it. This is the
                 one surface on the card that is deliberately NOT themed.

                 The bare `white` KEYWORD, not `#FFFFFF`: this file is on
                 `eslint-white-permanents.mjs` (with the QR rationale written
                 out there), which exempts the keyword and still enforces the
                 no-raw-hex rule — so the hex form is the one that fails. */
              backgroundColor="white"
              borderRadius={0}
              alignSelf="center"
            >
              <QRCodeSVG value={totpURI} size={180} />
            </YStack>
          )}

          {secret && (
            <YStack gap="$2">
              {/* A label ABOUT the secret below it — the label idiom, not
                  prose. */}
              <Text variant="overline" color="$colorMuted">
                {String(t("auth.tfaManualEntry"))}
              </Text>
              <XStack
                alignItems="center"
                gap="$2"
                backgroundColor="$surfaceMuted"
                borderRadius={0}
                padding="$2"
                paddingHorizontal="$3"
              >
                {/* `code` — genuine code-like content, and the variant that
                    already rides `$mono`. */}
                <Text
                  variant="code"
                  flex={1}
                  selectable
                  style={{ wordBreak: "break-all" }}
                >
                  {secret}
                </Text>
                <Button
                  data-testid="auth-2fa-copy-secret"
                  variant="ghost"
                  size="$2"
                  onPress={() => void handleCopySecret()}
                >
                  {/* `$accentText` on the copied state, never `$accent`:
                      flame as SMALL TEXT is 3.89:1 on this surface. The glyph
                      swap (Copy → Check) carries the state change too, so
                      colour is not the sole signal. */}
                  {copied ? (
                    <Check
                      size={14}
                      color="var(--accentText, #A8300F)"
                      aria-hidden="true"
                      style={{ flexShrink: 0 }}
                    />
                  ) : (
                    <Copy
                      size={14}
                      color="var(--colorMuted, #5C544A)"
                      aria-hidden="true"
                      style={{ flexShrink: 0 }}
                    />
                  )}
                  <Text
                    variant="overline"
                    color={copied ? "$accentText" : "$colorMuted"}
                  >
                    {copied
                      ? String(t("auth.tfaCopied"))
                      : String(t("auth.tfaCopySecret"))}
                  </Text>
                </Button>
              </XStack>
            </YStack>
          )}

          <Button
            data-testid="auth-2fa-continue-to-verify"
            size="$4"
            width="100%"
            onPress={() => setStage("verify")}
          >
            {String(t("auth.vecContinue"))}
          </Button>
        </>
      )}

      {/* ── Verify stage (TOTP) — first verifyTotp flips twoFactorEnabled ── */}
      {(stage === "verify" || stage === "verifying") && (
        <>
          <YStack alignItems="center" gap="$3">
            <Text variant="h4" tag="h1" textAlign="center">
              Confirm your authenticator
            </Text>
            <Text
              variant="body"
              color="$colorMuted"
              textAlign="center"
              lineHeight={24}
            >
              Enter the 6-digit code your authenticator app shows for
              Ithas Fire to finish setup.
            </Text>
          </YStack>

          <YStack gap="$3">
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
              // `testId`, not `data-testid`: `TextInput` forwards only the
              // former and strips a raw `data-testid` off the element, so
              // this id never reached the DOM before.
              testId="auth-2fa-verify-code"
            />

            <Button
              data-testid="auth-2fa-verify-submit"
              size="$4"
              width="100%"
              disabled={verifyCode.length < 6 || stage === "verifying"}
              disabledStyle={RECEDING_DISABLED}
              onPress={() => void handleVerifyTotp()}
            >
              {stage === "verifying" ? <Spinner size="sm" /> : null}
              {stage === "verifying" ? "Verifying…" : "Verify & finish"}
            </Button>

            <Button
              variant="ghost"
              size="$3"
              onPress={() => {
                setVerifyCode("");
                setStage("qr");
              }}
              disabled={stage === "verifying"}
            >
              Back to QR code
            </Button>
          </YStack>
        </>
      )}

      {/* ── Email verify stage — first verifyOtp flips twoFactorEnabled ── */}
      {(stage === "email-verify" || stage === "email-verifying") && (
        <>
          <YStack gap="$3" alignItems="flex-start">
            {backToPicker}
            <YStack alignItems="center" gap="$3" width="100%">
              <YStack
                width={56}
                height={56}
                borderRadius={0}
                backgroundColor="$accentSoft"
                alignItems="center"
                justifyContent="center"
              >
                <Mail
                  size={28}
                  color="var(--accent, #E2481D)"
                  aria-hidden="true"
                />
              </YStack>
              <Text variant="h4" tag="h1" textAlign="center">
                Check your email
              </Text>
              <Text
                variant="body"
                color="$colorMuted"
                textAlign="center"
                lineHeight={24}
              >
                We sent a 6-digit code to your inbox. Enter it below to finish
                enabling 2FA. You&apos;ll receive a fresh code each time you
                sign in from a new device.
              </Text>
            </YStack>
          </YStack>

          <YStack gap="$3">
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
              testId="auth-2fa-email-verify-code"
            />

            <Button
              data-testid="auth-2fa-email-verify-submit"
              size="$4"
              width="100%"
              disabled={verifyCode.length < 6 || stage === "email-verifying"}
              disabledStyle={RECEDING_DISABLED}
              onPress={() => void handleVerifyEmail()}
            >
              {stage === "email-verifying" ? <Spinner size="sm" /> : null}
              {stage === "email-verifying" ? "Verifying…" : "Verify & finish"}
            </Button>

            <Button
              variant="ghost"
              size="$3"
              onPress={() => void handleSendEmailOtp()}
              disabled={stage === "email-verifying"}
            >
              Resend code
            </Button>
          </YStack>
        </>
      )}
    </AuthCardShell>
  );
};

Setup2faCard.displayName = "Setup2faCard";
