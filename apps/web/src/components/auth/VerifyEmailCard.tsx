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
  useNotify,
  useTranslations,
} from "@th/ui";
import { XStack, YStack } from "tamagui";
import { Mail, CheckCircle2 } from "lucide-react";

import { authClient } from "@/lib/auth/auth-client";
import { requestEmailChangeCode } from "@/lib/auth/request-email-change-code";
import { isVerifyCurrentEmailFirst } from "@/lib/email-verification-required";
import { AuthCardShell, type AuthCardStep } from "./AuthCardShell";
import { RECEDING_DISABLED } from "./auth-card-chrome";

export type VerifyEmailCardProps = {
  email: string;
  onContinueAction: () => void;
  /**
   * Optional password from the upstream sign-up or sign-in attempt. When
   * present, we re-issue `signIn.email` after the OTP verifies so the
   * downstream session is fresh (emailVerified=true) and any 2FA setup
   * step can run against a known credential. Acceptable to omit; we'll
   * still refresh the session as a fallback.
   */
  password?: string;
  /**
   * Optional callback when the user opts to verify later. The sign-up flow
   * already created a session via signUp.email(), so skipping just closes
   * the overlay — the user stays signed in and can verify later from
   * Settings.
   */
  onSkipAction?: () => void;
  /** Optional header rendered inside the card surface (e.g. step indicator). */
  cardHeader?: ReactNode;
  /**
   * The step band. Defaults to sign-up's counted step 2 of 4; a prompt that
   * interrupts some other task (the B2 own-orders gate, the admin gate)
   * passes `{ kind: "interruption", name }`.
   */
  step?: AuthCardStep;
  /**
   * Called when Resend mails a fresh verification code to the address the
   * account holds (not a change-email code), so a caller tracking "a code is
   * out" stays in step with the card.
   */
  onCodeSent?: () => void;
};

const SIGN_UP_STEP: AuthCardStep = {
  kind: "counted",
  index: 2,
  total: 4,
  name: "Verify",
};

const RESEND_COOLDOWN_SECONDS = 60;

const sanitizeOtp = (raw: string) => raw.replace(/\D/g, "").slice(0, 6);

export const VerifyEmailCard = ({
  email,
  password,
  onContinueAction,
  onSkipAction,
  cardHeader,
  step = SIGN_UP_STEP,
  onCodeSent,
}: VerifyEmailCardProps) => {
  const t = useTranslations();
  const { toast } = useNotify();
  const [otp, setOtp] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [verified, setVerified] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resendState, setResendState] = useState<
    "idle" | "sending" | "cooldown"
  >("idle");
  const [resendCooldown, setResendCooldown] = useState(0);
  // Local override of the email shown on this card. Lets an unverified
  // buyer fix a typo (e.g. `gnail.com`) without bouncing them through a
  // full sign-out / re-signup cycle. Authoritative source for the OTP
  // verify call is `currentEmail`, not the prop.
  const [currentEmail, setCurrentEmail] = useState(email);
  const [showEmailChange, setShowEmailChange] = useState(false);
  const [emailChangeDraft, setEmailChangeDraft] = useState("");
  const [emailChanging, setEmailChanging] = useState(false);
  // Set while a typo fix is in flight: the account still holds the OLD
  // address until the code mailed to this NEW one is entered, at which point
  // `emailOtp.changeEmail` moves it and marks it verified in one step.
  const [pendingNewEmail, setPendingNewEmail] = useState<string | null>(null);
  // `TextInput` is the Tamagui-wrapped RN component, but on web the
  // underlying DOM element exposes `focus()` directly. Type the ref
  // loosely so both platforms compile.
  const inputRef = useRef<{ focus: () => void } | null>(null);
  const successRef = useRef<{ focus: () => void } | null>(null);

  // Autofocus the OTP input on mount so the user can start typing the
  // moment the card appears.
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  // Resend cooldown countdown drives the disabled state on the
  // "Resend code" button so users can't spam Mailpit/SES.
  useEffect(() => {
    if (resendCooldown <= 0) {
      if (resendState === "cooldown") setResendState("idle");
      return;
    }
    const id = setInterval(() => {
      setResendCooldown((s) => Math.max(0, s - 1));
    }, 1_000);
    return () => clearInterval(id);
  }, [resendCooldown, resendState]);

  // Auto-advance once verified after a short delay so the user gets a clear
  // "you did it" beat before the next step animates in.
  useEffect(() => {
    if (!verified) return;
    const focusId = requestAnimationFrame(() => successRef.current?.focus());
    const id = setTimeout(onContinueAction, 800);
    return () => {
      cancelAnimationFrame(focusId);
      clearTimeout(id);
    };
  }, [verified, onContinueAction]);

  const verify = useCallback(
    async (code: string) => {
      setSubmitting(true);
      setErrorMessage(null);
      try {
        const { error } = pendingNewEmail
          ? await authClient.emailOtp.changeEmail({
              newEmail: pendingNewEmail,
              otp: code,
            })
          : await authClient.emailOtp.verifyEmail({
              email: currentEmail,
              otp: code,
            });
        if (error) {
          if (pendingNewEmail && isVerifyCurrentEmailFirst(error)) {
            // Backstop for the route refusal above: Better Auth's change-email
            // hook refused the move. Fall back to verifying the address the
            // account still holds.
            setPendingNewEmail(null);
            setCurrentEmail(email);
            setErrorMessage(
              String(t("emailGate.changeBlockedCard", { email })),
            );
            setOtp("");
            inputRef.current?.focus();
            return;
          }
          setErrorMessage(error.message ?? String(t("auth.veInvalidCode")));
          setOtp("");
          inputRef.current?.focus();
          return;
        }

        // Refresh the cached session so consumers (e.g. checkout's
        // verification gate) see `emailVerified=true` immediately. Without
        // this, the next gated action would bounce the user right back
        // here because the client's session snapshot is stale.
        try {
          await authClient.getSession({
            query: { disableCookieCache: true },
          });
        } catch {
          // Non-fatal: the verify succeeded, the session will catch up on
          // the next natural refetch (focus / interval).
        }

        // Auto-login after verification. If we have the password from the
        // upstream sign-up/sign-in attempt, re-issue signIn.email so the
        // session reflects emailVerified=true and downstream onboarding
        // (e.g. 2FA setup) can run against a fresh, known credential.
        // Failures here are non-fatal: the user is already verified, and
        // they'll be prompted to sign in again only if the session was
        // never established.
        if (password) {
          try {
            const signInResult = await authClient.signIn.email({
              email: currentEmail,
              password,
            });
            if (signInResult.error) {
              console.warn(
                "[verify-email] auto sign-in after OTP failed",
                signInResult.error,
              );
            }
          } catch (signInErr) {
            console.warn(
              "[verify-email] auto sign-in after OTP threw",
              signInErr,
            );
          }
        }

        setVerified(true);
      } catch (err: unknown) {
        setErrorMessage(
          err instanceof Error ? err.message : String(t("auth.veInvalidCode")),
        );
        setOtp("");
        inputRef.current?.focus();
      } finally {
        setSubmitting(false);
      }
    },
    [currentEmail, email, pendingNewEmail, password, t],
  );

  // Auto-submit once 6 digits are entered. Mirrors the 2FA-challenge UX
  // and saves the user a tap on mobile.
  const autoSubmittedRef = useRef(false);
  useEffect(() => {
    if (
      otp.length === 6 &&
      !autoSubmittedRef.current &&
      !submitting &&
      !verified
    ) {
      autoSubmittedRef.current = true;
      void verify(otp);
    }
    if (otp.length < 6) {
      autoSubmittedRef.current = false;
    }
  }, [otp, submitting, verified, verify]);

  const handleResend = useCallback(async () => {
    setResendState("sending");
    setErrorMessage(null);
    try {
      // During a typo fix the code must come from the change-email flow, not
      // the plain verification flow (the account still holds the old address).
      const { error } = pendingNewEmail
        ? await requestEmailChangeCode(pendingNewEmail).then(
            () => ({ error: null as { message?: string } | null }),
            (e: unknown) => ({
              error: { message: e instanceof Error ? e.message : undefined },
            }),
          )
        : await authClient.emailOtp.sendVerificationOtp({
            email: currentEmail,
            type: "email-verification",
          });
      if (error) {
        toast.danger(error.message ?? String(t("auth.veResendFailed")));
        setResendState("idle");
        return;
      }
      setResendState("cooldown");
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
      if (!pendingNewEmail) onCodeSent?.();
      toast.success(String(t("auth.veCodeSent")));
    } catch (err: unknown) {
      toast.danger(
        err instanceof Error ? err.message : String(t("auth.veResendFailed")),
      );
      setResendState("idle");
    }
  }, [currentEmail, pendingNewEmail, t, toast, onCodeSent]);

  const handleManualSubmit = useCallback(() => {
    if (otp.length !== 6 || submitting) return;
    void verify(otp);
  }, [otp, submitting, verify]);

  const handleChangeEmail = useCallback(async () => {
    const trimmed = emailChangeDraft.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setErrorMessage(String(t("auth.invalidEmail") ?? "Enter a valid email."));
      return;
    }
    if (trimmed === currentEmail.toLowerCase()) {
      setShowEmailChange(false);
      return;
    }
    setEmailChanging(true);
    setErrorMessage(null);
    try {
      // Mails a code to the NEW address; the account is only moved (and
      // verified) when that code is entered — see `verify`. The old
      // unproven `authClient.changeEmail` rewrite is refused server-side.
      await requestEmailChangeCode(trimmed);
      setPendingNewEmail(trimmed);
      setCurrentEmail(trimmed);
      setOtp("");
      setShowEmailChange(false);
      setEmailChangeDraft("");
      setResendState("cooldown");
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
      toast.success(`Code sent to ${trimmed}.`);
    } catch (err: unknown) {
      if (isVerifyCurrentEmailFirst(err)) {
        // B2: this account holds orders, tickets or seats, so it must prove
        // the address it has before moving. The code for that address is the
        // one this card is already waiting for: close the detour, point at it.
        setShowEmailChange(false);
        setEmailChangeDraft("");
        setErrorMessage(
          String(t("emailGate.changeBlockedCard", { email: currentEmail })),
        );
        return;
      }
      setErrorMessage(
        err instanceof Error ? err.message : "Could not change email.",
      );
    } finally {
      setEmailChanging(false);
    }
  }, [emailChangeDraft, currentEmail, t, toast]);

  if (verified) {
    return (
      <AuthCardShell
        testId="auth-verify-email-card"
        step={step}
        header={cardHeader}
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
          {/* `$accentSoft` + an accent glyph, matching the identical success
              beat in `TwoFactorChallengeCard`. It was a solid `$accent` fill
              carrying a raw `#FFFFFF` mark — white on flame #E2481D is 4.06:1,
              which clears nothing but AA-large, and the hex bypassed the token
              system to get there. A 32px glyph only owes 3:1, which accent on
              accentSoft clears comfortably. */}
          <YStack
            width={64}
            height={64}
            borderRadius={0}
            backgroundColor="$accentSoft"
            alignItems="center"
            justifyContent="center"
          >
            <CheckCircle2
              size={32}
              color="var(--accent, #E2481D)"
              aria-hidden="true"
            />
          </YStack>
          <Text variant="h4" tag="h1" textAlign="center">
            {String(t("auth.vecVerified"))}
          </Text>
          <Text variant="body" color="$colorMuted" textAlign="center">
            {String(t("auth.vecVerifiedDescription"))}
          </Text>
        </YStack>
      </AuthCardShell>
    );
  }

  const resendDisabled = resendState !== "idle" || submitting;
  const resendLabel =
    resendState === "sending"
      ? String(t("auth.vecResending"))
      : resendState === "cooldown"
        ? String(t("auth.veResendIn", { seconds: resendCooldown }))
        : String(t("auth.veResend"));

  return (
    <AuthCardShell
      testId="auth-verify-email-card"
      step={step}
      header={cardHeader}
    >
      <YStack alignItems="center" gap="$4">
        <YStack
          width={56}
          height={56}
          borderRadius={0}
          backgroundColor="$accentSoft"
          alignItems="center"
          justifyContent="center"
        >
          <Mail size={28} color="var(--accent, #E2481D)" aria-hidden="true" />
        </YStack>
        <YStack gap="$2" alignItems="center" width="100%">
          <Text variant="h4" tag="h1" textAlign="center">
            {String(t("auth.veTitle"))}
          </Text>
          {/* Same interpolated-address hazard as the reset panel: an email has
              no break opportunities, so a long one overflows the card at 320
              unless it is allowed to break mid-word. */}
          <Text
            variant="body"
            color="$colorMuted"
            textAlign="center"
            lineHeight={24}
            style={{ overflowWrap: "anywhere" }}
          >
            {String(t("auth.veDescription", { email: currentEmail }))}
          </Text>
        </YStack>
      </YStack>

      <YStack gap="$3">
        {/* Segmented OTP: 6 visual cells in a flex row (natural centering
            via justify-content), with a transparent input overlaid to
            collect keystrokes + autofill. The cells just display the
            characters from `otp`; the input is the only writable element. */}
        <YStack position="relative" alignItems="center">
          <XStack gap="$2" justifyContent="center" width="100%">
            {Array.from({ length: 6 }).map((_, i) => {
              const char = otp[i] ?? "";
              const isActive = i === otp.length;
              const isFilled = Boolean(char);
              return (
                <YStack
                  key={i}
                  // Flexible up to 44, never fixed at it. Six 44px cells plus
                  // five 8px gaps measure 304, against the 244px content
                  // column a 320px viewport leaves — so the fixed row ran a
                  // 60px overflow out of the card. Flexing lands them at 34
                  // there and back at 44 anywhere the column allows it.
                  flex={1}
                  minWidth={0}
                  maxWidth={44}
                  height={52}
                  borderWidth={2}
                  /* A four-rung ladder, and every rung has to survive the
                     ink panel:
                       error   `$dangerSoft` — the ink card binds it to a
                               red that reads there (6.11:1). `$red8` was a
                               raw Tamagui palette token with no theme
                               meaning and no inverse-surface value.
                       active  `$accent` — flame, 4.17:1 on ink: line work,
                               which is where the accent is legal.
                       filled  `$borderColor` — full paper, 16.22:1.
                       empty   `$borderColorSoft` — 40% paper, 3.69:1, which
                               clears WCAG 1.4.11's 3:1 for a control
                               boundary while staying visibly behind a
                               filled cell. It used to be `$borderColor`
                               against `$borderColorStrong`, i.e. #211C16
                               against #000000 — a distinction nobody could
                               see on cream either. */
                  borderColor={
                    errorMessage
                      ? "$dangerSoft"
                      : isActive
                        ? "$accent"
                        : isFilled
                          ? "$borderColor"
                          : "$borderColorSoft"
                  }
                  alignItems="center"
                  justifyContent="center"
                >
                  <Text
                    fontSize={22}
                    weight="bold"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {char}
                  </Text>
                </YStack>
              );
            })}
          </XStack>
          <input
            ref={inputRef as unknown as React.Ref<HTMLInputElement>}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={otp}
            onChange={(e) => setOtp(sanitizeOtp(e.target.value))}
            data-testid="auth-verify-email-otp"
            aria-label={String(t("auth.veTitle"))}
            aria-invalid={errorMessage ? true : undefined}
            aria-describedby={
              errorMessage
                ? "auth-verify-email-error auth-verify-email-status"
                : "auth-verify-email-status"
            }
            enterKeyHint="done"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              opacity: 0,
              border: "none",
              background: "transparent",
              cursor: "text",
              caretColor: "transparent",
              fontSize: 16, // ≥16px so iOS doesn't zoom on focus
            }}
          />
        </YStack>
        <Text
          id="auth-verify-email-status"
          variant="caption"
          tone="muted"
          textAlign="center"
          {...({ "aria-live": "polite" } as Record<string, unknown>)}
        >
          {resendState === "cooldown"
            ? resendLabel
            : String(t("auth.veCodeSent"))}
        </Text>
        {errorMessage ? (
          <Text
            id="auth-verify-email-error"
            variant="bodySmall"
            // `$dangerSoft`, not `$red10`. Same reason as the OTP cells above:
            // `$red10` is a raw Tamagui palette rung with no theme meaning and
            // no value tuned for the ink panel, where it renders as a dark red
            // on dark ink. `$dangerSoft` is the theme's legible danger TEXT
            // colour, and the card binds it to the inverse-surface red
            // (#F87171 = 6.11:1 on #211C16).
            color="$dangerSoft"
            {...({ role: "alert", "aria-live": "assertive" } as Record<
              string,
              unknown
            >)}
          >
            {errorMessage}
          </Text>
        ) : null}

        <Button
          data-testid="auth-verify-email-continue"
          size="$4"
          width="100%"
          minHeight={44}
          onPress={handleManualSubmit}
          disabled={otp.length !== 6 || submitting}
          disabledStyle={RECEDING_DISABLED}
        >
          {/* The label is the atom's own `ButtonText`, which inherits the
              frame's colour — the `#FFFFFF` this replaces pinned white
              regardless of variant or theme, and was a raw hex besides. */}
          {submitting ? <Spinner size="sm" /> : null}
          {submitting
            ? String(t("auth.veVerifying"))
            : String(t("auth.veVerifyButton"))}
        </Button>

        <Button
          data-testid="auth-verify-email-resend"
          variant="secondary"
          size="$4"
          width="100%"
          minHeight={44}
          disabled={resendDisabled}
          onPress={() => void handleResend()}
        >
          {resendLabel}
        </Button>

        {/* Typo recovery: an unverified buyer who entered a bad email at
            sign-up would otherwise be stuck — they can sign in but never
            check out. A code goes to the NEW address and the account moves
            only when it is entered (`requestEmailChangeCode` +
            `emailOtp.changeEmail`). */}
        {showEmailChange ? (
          <YStack
            gap="$2"
            padding="$3"
            borderWidth={1}
            borderColor="$borderColor"
            backgroundColor="$surfaceMuted"
          >
            <Text variant="bodySmall" color="$colorMuted">
              Update the email on your account. We&apos;ll send a new code to
              the new address.
            </Text>
            <input
              data-testid="auth-verify-email-change-input"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={emailChangeDraft}
              onChange={(e) => setEmailChangeDraft(e.target.value)}
              disabled={emailChanging}
              // A bare <input>, so it is styled inline rather than by a
              // token prop. Every `var()` now carries its Stub value as the
              // fallback — that fallback is what SSR and first paint render,
              // so an absent one meant this field flashed as the UA default
              // before hydration. `background` is the page's `--background`,
              // not `--surface`: the DS boxed field sits one step BELOW the
              // panel it is on, which is what every other field on this card
              // already does. `fontSize: 16` is the iOS Safari focus-zoom
              // threshold — below it the whole page zooms on tap.
              style={{
                height: 44,
                padding: "0 12px",
                fontSize: 16,
                fontFamily: "inherit",
                color: "var(--color, #211C16)",
                background: "var(--background, #F6F0E4)",
                border: "2px solid var(--borderColor, #211C16)",
                borderRadius: 0,
              }}
            />
            {/* Stacked, not a 2-up row. Measured at 320: the card's content
                column is 244px, so each half of a row gave its label 82 —
                against the 130 "SEND NEW CODE" needs at the atom's 12px/700/
                +1.5px. `ellipse` on `ButtonText` truncates rather than
                wrapping, so the row failed silently. Full width gives 208. */}
            <YStack gap="$2">
              {/* Ink outline, not the accent fill. This block only opens
                  while `Continue` is on screen above it, so two accent fills
                  were co-visible — the exact breach the redesign took off
                  `/sign-in` (v2 §4: one primary button per viewport). The
                  card's action is still `Continue`; changing your address is
                  a detour, and this is the detour's submit. `Cancel` drops a
                  further rung to `ghost` so the pair keeps its own internal
                  order, matching the `Change email` / `Verify later` ghosts
                  it sits between. */}
              <Button
                data-testid="auth-verify-email-change-submit"
                variant="secondary"
                size="$3"
                width="100%"
                disabled={emailChanging || !emailChangeDraft.trim()}
                disabledStyle={RECEDING_DISABLED}
                onPress={() => void handleChangeEmail()}
              >
                {emailChanging ? "Updating…" : "Send new code"}
              </Button>
              <Button
                variant="ghost"
                size="$3"
                width="100%"
                disabled={emailChanging}
                onPress={() => {
                  setShowEmailChange(false);
                  setEmailChangeDraft("");
                }}
              >
                Cancel
              </Button>
            </YStack>
          </YStack>
        ) : (
          <Button
            data-testid="auth-verify-email-change-toggle"
            variant="ghost"
            size="$3"
            width="100%"
            minHeight={36}
            onPress={() => {
              setEmailChangeDraft(currentEmail);
              setShowEmailChange(true);
            }}
            disabled={submitting}
          >
            Change email
          </Button>
        )}

        {/* Skip — session is already created by signUp.email so the user stays
            signed in. They can verify later from their profile. */}
        {onSkipAction ? (
          <Button
            data-testid="auth-verify-email-skip"
            variant="ghost"
            size="$3"
            width="100%"
            minHeight={36}
            onPress={onSkipAction}
          >
            Verify later
          </Button>
        ) : null}
      </YStack>
    </AuthCardShell>
  );
};

VerifyEmailCard.displayName = "VerifyEmailCard";
