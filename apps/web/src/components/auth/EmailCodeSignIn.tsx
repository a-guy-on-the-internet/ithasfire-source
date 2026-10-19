"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Button, LabeledTextInput, Text, useTranslations } from "@th/ui";
import { XStack, YStack } from "tamagui";

import { authClient } from "@/lib/auth/auth-client";
import { formatAuthErrorMessage } from "./auth-helpers";
import { signInRefusalMessage } from "./sign-in-refusal-message";

/**
 * Email-code (OTP) sign-in — the escape hatch for accounts with no credential
 * at all.
 *
 * A guest-checkout buyer gets a shadow `auth_user` row with ZERO `auth_account`
 * rows: no password, no OAuth, no passkey. Their ticket email links to
 * `/my-tickets/{orderId}`, which the private-route gate bounces to
 * `/sign-in?redirect_url=…`, where every option on offer needs a credential
 * they do not have. This panel is the way out of that dead end.
 *
 * CONTROLLED by the card, not self-disclosing. It used to own a collapsed
 * chevron row of its own, which made it a fifth peer competing on step 1 of a
 * page that already had too many. It now opens in place on step 2 — the
 * credential step for an identifier the user has already given us — from the
 * `EMAIL ME A CODE INSTEAD` link beside `FORGOT YOUR PASSWORD?`, which is
 * exactly where somebody with no password looks. The `auth-email-code-toggle`
 * test id moved onto that link with the behaviour it names.
 *
 * Both buttons here still ride `variant="secondary"`: the accent budget on
 * step 2 is spent on `SIGN IN` (v2 §4, "one primary button per viewport").
 *
 * Client method names are the ones Better Auth derives from the endpoint paths
 * `/email-otp/send-verification-otp` and `/sign-in/email-otp`; both were
 * confirmed against the installed plugin, not assumed.
 */

/** Digits in the code Better Auth generates (`otpLength` default). */
const OTP_LENGTH = 6;

/**
 * Mirrors `emailOTP({ expiresIn: 60 * 10 })` in
 * `apps/api/src/auth/better-auth.ts`. Stated in the copy so an expired code
 * reads as expected rather than broken. Keep the two in step.
 */
const OTP_EXPIRY_MINUTES = 10;

/** Client-side courtesy throttle on "Resend code". Not a security control. */
const RESEND_COOLDOWN_SECONDS = 30;

const EMAIL_ADDRESS_INPUT_ID = "auth-email-code-address";
const OTP_INPUT_ID = "auth-email-code-otp";

/** Deliberately loose: the server is the authority on address validity. */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Map Better Auth's email-OTP failures onto copy a human can act on.
 *
 * None of these leak account existence. `/email-otp/send-verification-otp`
 * answers `{"success":true}` for unknown and known addresses alike, and because
 * sign-up is not disabled it writes a verification row either way — so
 * `OTP_EXPIRED` and `TOO_MANY_ATTEMPTS` are reachable for an address with no
 * account exactly as they are for one with an account. Attempt counting stays
 * server-side (the stored value is `"<otp>:<attempts>"`); we never count here.
 */
const describeVerifyError = (
  error: unknown,
  t: (key: string) => string,
): {
  message: string;
  /**
   * True when the server has discarded the stored code, so the "we sent you a
   * code, it expires in 10 minutes" notice is now a lie and must come down.
   * A plain wrong-digits rejection leaves the code alive, and the notice is
   * still the user's only reminder of WHICH address it went to — so it stays.
   */
  codeIsDead: boolean;
} => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === "OTP_EXPIRED") {
    return {
      message: "That code has expired. Send a new one and try again.",
      codeIsDead: true,
    };
  }
  if (code === "TOO_MANY_ATTEMPTS") {
    return {
      message: "Too many tries with that code. Send a new one to start over.",
      codeIsDead: true,
    };
  }
  if (code === "INVALID_OTP") {
    return {
      message: "That code didn't work. Check the digits and try again.",
      codeIsDead: false,
    };
  }
  // A second-factor refusal comes AFTER the code was accepted: the code is
  // spent and retrying it cannot help.
  const refusal = signInRefusalMessage(error, t);
  if (refusal) return { message: refusal, codeIsDead: true };
  return { message: formatAuthErrorMessage(error, t), codeIsDead: false };
};

export type EmailCodeSignInProps = {
  /**
   * Whether the panel is expanded. Owned by the card, which renders the
   * control that flips it (`auth-email-code-toggle`) alongside the other
   * step-2 affordances.
   */
  open: boolean;
  /**
   * The identifier the reader already typed on step 1, used to seed the
   * address field the first time the panel opens. Ignored unless it looks like
   * an email — the step-1 field also accepts a username, and this endpoint
   * cannot do anything with one.
   */
  initialEmail?: string;
  /** Resolved post-auth destination (already sanitized by `useAuthRedirect`). */
  destination: string;
  /** Current pathname, so we can skip a redundant `replace`. */
  pathname: string | null;
  /** Router `replace`, injected so this component stays router-agnostic. */
  onNavigateAction: (href: string) => void;
  /** True when another auth path (OAuth, passkey, password) is mid-flight. */
  disabled?: boolean;
  /** Lets the parent fold this panel's in-flight state into its own `isBusy`. */
  onBusyChangeAction?: (busy: boolean) => void;
  /** Fired after a successful sign-in, before navigation. */
  onSignInSuccessAction?: () => void;
  /** Closes the overlay, when this card is rendered inside one. */
  onDismissAction?: () => void;
};

export const EmailCodeSignIn = ({
  open,
  initialEmail,
  destination,
  pathname,
  onNavigateAction,
  disabled = false,
  onBusyChangeAction,
  onSignInSuccessAction,
  onDismissAction,
}: EmailCodeSignInProps) => {
  const t = useTranslations();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "verifying">(
    "idle",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  /** Id of the field that should receive focus once it is mountable. */
  const [focusRequest, setFocusRequest] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const busy = status !== "idle";
  /** Every field/button in the panel is inert while any auth path runs. */
  const controlsDisabled = disabled || busy;

  // Keep the parent's `isBusy` honest so OAuth/passkey can't be fired while a
  // code request or verification is in flight.
  //
  // The cleanup matters now that this panel is mounted only on the card's step
  // 2: unmounting while `busy` is true would latch the parent's
  // `emailCodeBusy` at `true` for good, pinning `isBusy` and leaving the whole
  // card inert with no way back. Every unmount path today is behind a
  // `disabled={isBusy}` control, so it is not reachable — but that invariant
  // rests on six separate `disabled` props all staying correct, and this
  // reset costs one line. (It also fires between a busy-flag change and its
  // replacement; React batches the pair into one commit, so the parent never
  // observes the intermediate `false`.)
  useEffect(() => {
    onBusyChangeAction?.(busy);
    return () => {
      onBusyChangeAction?.(false);
    };
  }, [busy, onBusyChangeAction]);

  // Resend cooldown tick. One interval, cleared on unmount.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((n) => (n <= 1 ? 0 : n - 1));
    }, 1_000);
    return () => clearInterval(timer);
  }, [cooldown]);

  /**
   * Ask for focus on one of the two step fields.
   *
   * Recorded as state and applied from an effect rather than imperatively at
   * the call site, because every call site sits next to a `setStep`/`setOpen`
   * and the target input does not exist yet. The first cut used
   * `requestAnimationFrame` and lost the race against React's commit — the real
   * page put focus on `<body>` after "Send code" on some runs and on the input
   * on others.
   *
   * Queried off the panel rather than held as a ref because
   * `LabeledTextInput` is not a `forwardRef` component — a ref threaded through
   * its prop spread would land on the styled input on web and on nothing at all
   * on native.
   */
  const requestFocus = useCallback((id: string) => {
    setFocusRequest(id);
  }, []);

  /**
   * Apply a pending focus request, and only then clear it.
   *
   * The `controlsDisabled` guard is the whole reason this is a latch rather
   * than a one-shot. The parent's `isBusy` trails us by one render: it is fed
   * by `onBusyChangeAction`, which is itself an effect, so on the commit that
   * flips `status` back to "idle" the incoming `disabled` prop is STILL true —
   * every field renders disabled, and `.focus()` on a disabled input is a
   * silent no-op. Measured, not reasoned: a document-level `focusin` log on the
   * live page showed no focus event at all for the code field. Holding the
   * request until the controls are live means the focus lands on the render
   * after, where the field is actually focusable.
   */
  useEffect(() => {
    if (!open || !focusRequest || controlsDisabled) return;
    const field = panelRef.current?.querySelector<HTMLInputElement>(
      `#${focusRequest}`,
    );
    if (!field) return;
    field.focus({ preventScroll: true });
    setFocusRequest(null);
  }, [controlsDisabled, focusRequest, open]);

  /**
   * Opening the panel seeds the address and takes focus.
   *
   * Guarded by a ref rather than keyed on `open` alone so it fires once per
   * OPENING, not on every render while open: without the latch, a keystroke in
   * the address field would re-run the seed and stamp the step-1 identifier
   * back over whatever the reader had just typed.
   *
   * The seed only runs while the field is still untouched, and only for an
   * address — step 1 accepts a username too, and there is nothing this endpoint
   * can do with one.
   */
  const openedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      openedRef.current = false;
      return;
    }
    if (openedRef.current) return;
    openedRef.current = true;

    const seed = initialEmail?.trim() ?? "";
    if (step === "email" && email.length === 0 && LOOKS_LIKE_EMAIL.test(seed)) {
      setEmail(seed);
    }
    requestFocus(step === "email" ? EMAIL_ADDRESS_INPUT_ID : OTP_INPUT_ID);
  }, [email.length, initialEmail, open, requestFocus, step]);

  const sendCode = useCallback(
    async (intent: "initial" | "resend") => {
      const address = email.trim();
      if (!LOOKS_LIKE_EMAIL.test(address)) {
        setNoticeMessage(null);
        setErrorMessage("Enter a valid email address.");
        requestFocus(EMAIL_ADDRESS_INPUT_ID);
        return;
      }

      setStatus("sending");
      setErrorMessage(null);

      try {
        const result = await authClient.emailOtp.sendVerificationOtp({
          email: address,
          type: "sign-in",
        });

        if (result?.error) {
          // Transport / rate-limit failures only. The endpoint answers
          // `{"success":true}` whether or not the address has an account, so
          // nothing reachable here distinguishes the two.
          setNoticeMessage(null);
          setErrorMessage(formatAuthErrorMessage(result.error));
          return;
        }

        setCode("");
        setStep("code");
        setCooldown(RESEND_COOLDOWN_SECONDS);
        // Distinct wording per intent so the live region actually re-announces
        // on a resend instead of repeating an unchanged string.
        setNoticeMessage(
          `${intent === "resend" ? "New code sent" : "Code sent"} to ${address}. It expires in ${OTP_EXPIRY_MINUTES} minutes.`,
        );
        requestFocus(OTP_INPUT_ID);
      } catch (error) {
        setNoticeMessage(null);
        setErrorMessage(formatAuthErrorMessage(error));
      } finally {
        setStatus("idle");
      }
    },
    [email, requestFocus],
  );

  const verifyCode = useCallback(async () => {
    const address = email.trim();
    if (code.length !== OTP_LENGTH) {
      setErrorMessage(`Enter the ${OTP_LENGTH}-digit code from your email.`);
      requestFocus(OTP_INPUT_ID);
      return;
    }

    setStatus("verifying");
    setErrorMessage(null);

    try {
      const result = await authClient.signIn.emailOtp({
        email: address,
        otp: code,
      });

      if (result?.error) {
        // Stay on step 2 with the address intact — the only thing worth
        // retyping is the code.
        const failure = describeVerifyError(result.error, t);
        if (failure.codeIsDead) setNoticeMessage(null);
        setErrorMessage(failure.message);
        setCode("");
        requestFocus(OTP_INPUT_ID);
        return;
      }

      onSignInSuccessAction?.();
      onDismissAction?.();
      if (destination !== pathname) onNavigateAction(destination);
    } catch (error) {
      const failure = describeVerifyError(error, t);
      if (failure.codeIsDead) setNoticeMessage(null);
      setErrorMessage(failure.message);
      setCode("");
      requestFocus(OTP_INPUT_ID);
    } finally {
      setStatus("idle");
    }
  }, [
    code,
    destination,
    email,
    requestFocus,
    onDismissAction,
    onNavigateAction,
    onSignInSuccessAction,
    pathname,
    t,
  ]);

  const handleSendSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void sendCode("initial");
  };

  const handleVerifySubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void verifyCode();
  };

  const handleChangeEmail = () => {
    setStep("email");
    setCode("");
    setErrorMessage(null);
    setNoticeMessage(null);
    requestFocus(EMAIL_ADDRESS_INPUT_ID);
  };

  return (
    <YStack gap="$3">
      {/* Animated expand, grid 0fr → 1fr: children stay mounted so focus
          survives the transition, and `inert` (not `aria-hidden`) removes them
          from BOTH the a11y tree and the tab order without the focus-retention
          console warning.

          The control that flips `open` is `auth-email-code-toggle`, now the
          `EMAIL ME A CODE INSTEAD` link on the card's step 2; it owns the
          `aria-expanded` / `aria-controls` pair that points at this id. */}
      <div
        id="auth-email-code-panel"
        ref={panelRef}
        inert={!open}
        style={{
          display: "grid",
          gridTemplateRows: open ? "1fr" : "0fr",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition:
            "grid-template-rows 320ms cubic-bezier(0.34, 1.3, 0.64, 1), opacity 220ms ease-out",
        }}
      >
        {/* The `0fr → 1fr` grid collapse needs `overflow: hidden` to clip the
            row while it animates — but this box is EXACTLY the content
            column's width, so it was also clipping the horizontal halves of
            every focus ring inside it. Measured on /sign-in step 2 with the
            panel open: the emailed-code field's 3px ring at 2px offset painted
            its top and bottom edges only, both verticals gone (the field's box
            is 530–910, the ring wants 525–915, this div ends at 910).

            A ring that renders as two stray rules is worse than no ring — it
            reads as a border style, not as focus. So the clip box is bled 8px
            wider on each side and the padding gives it back, which leaves the
            fields aligned with the ones above while putting the ring inside
            the clip. Negative margin, not gap: this is a bleed, not spacing
            between siblings (v2 §4 allows margins for exactly this kind of
            pinning). */}
        <div
          style={{
            overflow: "hidden",
            minHeight: 0,
            paddingInline: 8,
            marginInline: -8,
          }}
        >
          <YStack gap="$4" paddingTop="$3">
            {/* Live regions. `status` carries the send confirmation, `alert`
                the failures, so an error interrupts and a confirmation does
                not. Both are words, never colour alone. */}
            {noticeMessage ? (
              <YStack
                role="status"
                aria-live="polite"
                data-testid="auth-email-code-notice"
                backgroundColor="$surfaceMuted"
                borderLeftWidth={4}
                borderLeftColor="$structure"
                borderRadius={0}
                paddingVertical="$3"
                paddingHorizontal="$4"
              >
                <Text variant="bodySmall" color="$color">
                  {noticeMessage}
                </Text>
              </YStack>
            ) : null}

            {errorMessage ? (
              <YStack
                role="alert"
                data-testid="auth-email-code-error"
                backgroundColor="$surfaceMuted"
                borderLeftWidth={4}
                borderLeftColor="$dangerSoft"
                borderRadius={0}
                paddingVertical="$3"
                paddingHorizontal="$4"
              >
                <Text variant="bodySmall" color="$dangerSoft" weight="medium">
                  {errorMessage}
                </Text>
              </YStack>
            ) : null}

            {step === "email" ? (
              <form
                onSubmit={handleSendSubmit}
                noValidate
                data-testid="auth-email-code-request-form"
              >
                <YStack gap="$4">
                  <Text variant="bodySmall" color="$colorMuted">
                    {`No password or passkey? We'll email you a ${OTP_LENGTH}-digit code that signs you in. It expires in ${OTP_EXPIRY_MINUTES} minutes.`}
                  </Text>

                  <LabeledTextInput
                    label="Email address"
                    // The brand's label idiom, not a hand-typed imitation of
                    // it: `overline` IS uppercase IBM Plex Mono 11/2px/600, so
                    // this label matches the password label one step up
                    // instead of shouting a sans caption at it.
                    labelVariant="overline"
                    testId="auth-email-code-email"
                    id={EMAIL_ADDRESS_INPUT_ID}
                    name="email"
                    // type="text", not "email": RNW derives the DOM `type` from
                    // `inputMode`/`keyboardType` and TextInput re-asserts it
                    // after every render, so a mismatch resets the caret to 0
                    // on each keystroke. Validation is ours anyway.
                    type="text"
                    value={email}
                    onChangeText={(value) => {
                      setEmail(value);
                      if (errorMessage) setErrorMessage(null);
                    }}
                    placeholder="you@example.com"
                    autoCapitalize="none"
                    autoComplete={"email" as never}
                    autoCorrect={false}
                    disabled={controlsDisabled}
                    status={errorMessage ? "error" : undefined}
                    aria-invalid={errorMessage ? true : undefined}
                    // Match the password form's field metrics.
                    height={52}
                    paddingHorizontal={16}
                    fontSize={16}
                    borderWidth={2}
                  />

                  <Button
                    data-testid="auth-email-code-send"
                    // @ts-expect-error -- 'type' is valid in the DOM but not in Tamagui's Button typings
                    type="submit"
                    variant="secondary"
                    size="$4"
                    width="100%"
                    borderWidth={2}
                    disabled={controlsDisabled || email.trim().length === 0}
                  >
                    {status === "sending" ? "Sending…" : "Send code"}
                  </Button>
                </YStack>
              </form>
            ) : (
              <form
                onSubmit={handleVerifySubmit}
                noValidate
                data-testid="auth-email-code-verify-form"
              >
                <YStack gap="$4">
                  <LabeledTextInput
                    label={`${OTP_LENGTH}-digit code`}
                    labelVariant="overline"
                    testId="auth-email-code-otp"
                    id={OTP_INPUT_ID}
                    name="otp"
                    value={code}
                    onChangeText={(value) => {
                      setCode(value.replace(/\D/g, "").slice(0, OTP_LENGTH));
                      if (errorMessage) setErrorMessage(null);
                    }}
                    placeholder="000000"
                    // No `type`: `inputMode="numeric"` already resolves to DOM
                    // type="text" in RNW, and leaving `type` unset keeps
                    // TextInput's imperative patcher from touching the
                    // attribute at all (re-setting it resets the caret).
                    inputMode="numeric"
                    maxLength={OTP_LENGTH}
                    autoComplete={"one-time-code" as never}
                    autoCapitalize="none"
                    autoCorrect={false}
                    disabled={controlsDisabled}
                    status={errorMessage ? "error" : undefined}
                    aria-invalid={errorMessage ? true : undefined}
                    height={52}
                    paddingHorizontal={16}
                    fontSize={20}
                    letterSpacing={6}
                    borderWidth={2}
                  />

                  <Button
                    data-testid="auth-email-code-verify"
                    // @ts-expect-error -- 'type' is valid in the DOM but not in Tamagui's Button typings
                    type="submit"
                    variant="secondary"
                    size="$4"
                    width="100%"
                    borderWidth={2}
                    disabled={controlsDisabled || code.length !== OTP_LENGTH}
                  >
                    {status === "verifying" ? "Verifying…" : "Verify code"}
                  </Button>

                  <XStack
                    justifyContent="space-between"
                    alignItems="center"
                    flexWrap="wrap"
                    gap="$2"
                  >
                    <Button
                      data-testid="auth-email-code-change-email"
                      variant="ghost"
                      size="$4"
                      paddingHorizontal="$3"
                      onPress={handleChangeEmail}
                      disabled={controlsDisabled}
                    >
                      Change email
                    </Button>
                    <Button
                      data-testid="auth-email-code-resend"
                      variant="ghost"
                      size="$4"
                      paddingHorizontal="$3"
                      onPress={() => void sendCode("resend")}
                      disabled={controlsDisabled || cooldown > 0}
                    >
                      {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
                    </Button>
                  </XStack>
                </YStack>
              </form>
            )}
          </YStack>
        </div>
      </div>
    </YStack>
  );
};
