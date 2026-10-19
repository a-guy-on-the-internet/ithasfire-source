"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import {
  useNotify,
  useTranslations,
  elevationTokens,
  getShadowOverflowPx,
} from "@th/ui";
import { YStack, useThemeName } from "tamagui";

import { AuthOverlayShell } from "./AuthOverlayShell";
import { LoginCard } from "./LoginCard";
import { SignUpCard } from "./SignUpCard";
import { VerifyEmailCard } from "./VerifyEmailCard";
import { Setup2faCard } from "./Setup2faCard";
import { WelcomeProfileCard } from "./WelcomeProfileCard";
import { TwoFactorChallengeCard } from "./TwoFactorChallengeCard";
import { ForgotPasswordCard } from "./ForgotPasswordCard";
import { resolvePostAuthDestination } from "./auth-helpers";
import {
  AUTH_PANEL_DURATION_MS,
  getPanelEnterStyle,
  getPanelExitStyle,
  getSlideDirection,
  type AuthPanel,
  type SlideDirection,
} from "@/lib/motion/auth";

export type { AuthPanel };

export type UnifiedAuthOverlayProps = {
  initialPanel: AuthPanel;
  redirectOverride?: string | null;
  onRequestCloseAction?: () => void;
  onSignInSuccessAction?: () => void;
  /**
   * Email to pre-fill when the overlay opens directly on the verify-email
   * panel from outside the sign-up flow (e.g. checkout gating an unverified
   * buyer). When set, "Continue" and "Verify later" both just close the
   * overlay rather than chaining into 2FA setup, because the caller drove
   * the user here for a specific purpose (let them get back to it).
   */
  externalEmail?: string;
};

type Transition = {
  from: AuthPanel;
  to: AuthPanel;
  direction: SlideDirection;
};

export const UnifiedAuthOverlay = ({
  initialPanel,
  redirectOverride,
  onRequestCloseAction,
  onSignInSuccessAction,
  externalEmail,
}: UnifiedAuthOverlayProps) => {
  const router = useRouter();
  const pathname = usePathname();
  const [currentPanel, setCurrentPanel] = useState<AuthPanel>(initialPanel);
  // True only when we entered the overlay directly at verify-email from
  // outside the sign-up flow. Drives short-circuit Continue / Skip wiring.
  const isStandaloneVerifyEmail =
    initialPanel === "verify-email" && Boolean(externalEmail);
  /**
   * Set during a slide transition. When non-null, BOTH `from` and `to`
   * panels render simultaneously in absolutely-positioned layers, each
   * with its own fresh animation. After the duration elapses, transition
   * clears and only `to` (now `currentPanel`) remains.
   */
  const [transition, setTransition] = useState<Transition | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useNotify();
  const t = useTranslations();
  const themeName = useThemeName();
  const triggerAnimatedCloseRef = useRef<(() => void) | null>(null);

  /**
   * How far the auth card's print shadow paints OUTSIDE its own box.
   *
   * `AuthCardShell` puts Stub's `4px 4px 0` hard offset shadow on the card —
   * the brand's single most identifying property. A box shadow never counts as
   * scrollable overflow, so the `overflow: hidden` this file needs for the
   * panel slide clipped 100% of it: measured in the overlay, the clipping
   * wrapper's rect was IDENTICAL to the card's (480×598 at the same origin),
   * so every one of those 4px fell outside the clip and the shadow simply did
   * not paint. It rendered fine on `/sign-in` and was invisible in the overlay
   * — the surface most users meet first. Same fix as `EventGrid`'s carousel
   * track: reserve exactly the shadow's overflow. 0 on the flat themes
   * (`card: "none"`), so they gain no dead space.
   */
  const shadowGutter = useMemo(() => {
    const elevation =
      elevationTokens[themeName as keyof typeof elevationTokens] ??
      elevationTokens.ember;
    return getShadowOverflowPx(elevation.card);
  }, [themeName]);

  // Stored after sign-up for downstream cards. Seeded with `externalEmail`
  // when the overlay opens directly at verify-email (no sign-up flow).
  const [signUpEmail, setSignUpEmail] = useState(externalEmail ?? "");
  const [signUpPassword, setSignUpPassword] = useState("");

  // Set when sign-up fails because the account already exists: we route to
  // sign-in, prefill this email, and show a friendly notice instead of
  // trapping the user on the create-account form.
  const [signInPrefillEmail, setSignInPrefillEmail] = useState("");
  const [signInNotice, setSignInNotice] = useState<string | null>(null);
  /**
   * Staged clear for `signInPrefillEmail`, applied when the slide retires.
   *
   * The prefill is not cosmetic — `LoginCard` reads it at mount to decide
   * whether it opens on step 1 or step 2 — and it has to survive the slide,
   * because the exit layer mounts a FRESH `LoginCard`. Clearing it
   * synchronously therefore flipped the outgoing card back to step 1 while it
   * was still on screen. Left uncleared, though, it stranded the next visit:
   * step 2 → "Create account" → sign up → "Sign in" reopened the card on step
   * 2 for an address the user had already walked away from. So: clear, but
   * one transition later.
   */
  const clearPrefillOnSettleRef = useRef(false);

  const destination = useMemo(
    () => resolvePostAuthDestination(redirectOverride ?? null),
    [redirectOverride],
  );

  const handleErrorMessageChange = useCallback(
    (message: string | null) => {
      if (message) {
        const title =
          currentPanel === "sign-in"
            ? (t("auth.signInFailed") as string)
            : (t("auth.signUpFailed") as string);
        toast.danger(message, { title });
      }
    },
    [toast, t, currentPanel],
  );

  const handleSignInSuccess = useCallback(() => {
    if (triggerAnimatedCloseRef.current) {
      triggerAnimatedCloseRef.current();
    }
    onSignInSuccessAction?.();
  }, [onSignInSuccessAction]);

  /** Close the overlay and navigate to the destination. */
  const closeAndNavigate = useCallback(() => {
    if (triggerAnimatedCloseRef.current) {
      triggerAnimatedCloseRef.current();
    }
    onRequestCloseAction?.();
    if (destination !== pathname) router.replace(destination);
  }, [onRequestCloseAction, router, destination, pathname]);

  const switchToPanel = useCallback(
    (target: AuthPanel) => {
      if (target === currentPanel || transition) return;

      const direction = getSlideDirection(currentPanel, target);

      if (!direction) {
        setCurrentPanel(target);
        return;
      }

      // Blur the focused input before sliding so macOS/Safari autofill and
      // passkey popovers (anchored to the focused element) dismiss instead of
      // tracking the outgoing card off-screen.
      (document.activeElement as HTMLElement | null)?.blur();

      // Commit the target as the new currentPanel immediately so callbacks
      // routed through children see the new state. The transition state keeps
      // the outgoing panel mounted for the slide.
      const fromPanel = currentPanel;
      setCurrentPanel(target);
      setTransition({ from: fromPanel, to: target, direction });
    },
    [currentPanel, transition],
  );

  // Clear the transition after the animation completes.
  useEffect(() => {
    if (!transition) return;
    const id = setTimeout(() => {
      setTransition(null);
      if (clearPrefillOnSettleRef.current) {
        clearPrefillOnSettleRef.current = false;
        setSignInPrefillEmail("");
      }
    }, AUTH_PANEL_DURATION_MS);
    return () => clearTimeout(id);
  }, [transition]);

  /** Called by SignUpCard after successful email+password sign-up. */
  const handleSignUpSuccess = useCallback(
    (email: string, password: string) => {
      setSignUpEmail(email);
      setSignUpPassword(password);
      switchToPanel("verify-email");
    },
    [switchToPanel],
  );

  /**
   * Called by SignUpCard when sign-up fails because the email already exists.
   * Route to sign-in with the email prefilled and a friendly notice.
   */
  const handleAccountExists = useCallback(
    (email: string) => {
      setSignInPrefillEmail(email);
      setSignInNotice(String(t("auth.scAccountExists")));
      switchToPanel("sign-in");
    },
    [switchToPanel, t],
  );

  /**
   * "Create account" from the sign-in card.
   *
   * Retires the sign-in notice AND stages the prefill clear, so the account
   * the user declined to sign into does not come back pre-filled the next
   * time they open sign-in. Bails while a slide is in flight because
   * `switchToPanel` would bail too — staging a clear for a transition we are
   * not driving would drop the prefill under the card still showing it.
   */
  const handleRequestCreateAccount = useCallback(() => {
    if (transition) return;
    setSignInNotice(null);
    clearPrefillOnSettleRef.current = true;
    switchToPanel("sign-up");
  }, [switchToPanel, transition]);

  const renderPanel = useCallback(
    (panel: AuthPanel) => {
      switch (panel) {
        case "sign-in":
          return (
            <LoginCard
              redirectOverride={redirectOverride}
              initialIdentifier={signInPrefillEmail || undefined}
              noticeMessage={signInNotice}
              onDismissAction={onRequestCloseAction}
              onRequestCreateAccountAction={handleRequestCreateAccount}
              onStatusChangeAction={(status) => {
                setIsSubmitting(status === "submitting");
              }}
              onSignInSuccessAction={handleSignInSuccess}
              onErrorMessageChangeAction={handleErrorMessageChange}
              onTwoFactorRequiredAction={() => switchToPanel("verify-2fa")}
              onEmailNotVerifiedAction={(email, password) => {
                setSignUpEmail(email);
                setSignUpPassword(password);
                switchToPanel("verify-email");
              }}
              onRequestForgotPasswordAction={() =>
                switchToPanel("forgot-password")
              }
            />
          );
        case "forgot-password":
          return (
            <ForgotPasswordCard
              onRequestSignInAction={() => switchToPanel("sign-in")}
            />
          );
        case "sign-up":
          return (
            <SignUpCard
              redirectOverride={redirectOverride}
              onDismissAction={onRequestCloseAction}
              onRequestSignInAction={() => switchToPanel("sign-in")}
              onStatusChangeAction={(status) => {
                setIsSubmitting(status === "submitting");
              }}
              onErrorMessageChangeAction={handleErrorMessageChange}
              onSignUpSuccessAction={handleSignUpSuccess}
              onAccountExistsAction={handleAccountExists}
            />
          );
        case "verify-email":
          return (
            <VerifyEmailCard
              email={signUpEmail}
              password={signUpPassword || undefined}
              onContinueAction={
                isStandaloneVerifyEmail
                  ? // Buyer was bounced here mid-checkout; close the overlay
                    // and let them resume what they were doing.
                    () => onRequestCloseAction?.()
                  : () => switchToPanel("setup-2fa")
              }
              onSkipAction={
                isStandaloneVerifyEmail
                  ? () => onRequestCloseAction?.()
                  : // signUp.email() already created a session; skipping verify
                    // simply closes the overlay and the user stays logged in.
                    closeAndNavigate
              }
            />
          );
        case "setup-2fa":
          // Securing (or skipping it) hands off to the profile step; only
          // step 4 leaves the overlay.
          return (
            <Setup2faCard
              password={signUpPassword}
              onDoneAction={() => switchToPanel("welcome-profile")}
              onSkipAction={() => switchToPanel("welcome-profile")}
            />
          );
        case "verify-2fa":
          return (
            <TwoFactorChallengeCard
              onVerifiedAction={() => {
                handleSignInSuccess();
                onRequestCloseAction?.();
                if (destination !== pathname) router.replace(destination);
              }}
              onBackAction={() => switchToPanel("sign-in")}
            />
          );
        case "welcome-profile":
          // Step 4 of sign-up, and the landing for `?onboarding=oauth`
          // (`AppOverlayProvider`). Finish and Skip both close and go to the
          // destination — the account is complete either way.
          return (
            <WelcomeProfileCard
              onDoneAction={closeAndNavigate}
              onSkipAction={closeAndNavigate}
            />
          );
      }
    },
    [
      closeAndNavigate,
      destination,
      handleAccountExists,
      handleErrorMessageChange,
      handleRequestCreateAccount,
      handleSignInSuccess,
      handleSignUpSuccess,
      onRequestCloseAction,
      pathname,
      redirectOverride,
      router,
      signInNotice,
      signInPrefillEmail,
      signUpEmail,
      signUpPassword,
      switchToPanel,
    ],
  );

  return (
    <AuthOverlayShell
      id="auth-overlay"
      backdropTestId="auth-overlay-backdrop"
      layerTestId="auth-overlay-layer"
      closeLabel={
        currentPanel === "sign-in"
          ? (t("auth.closeSignInOverlay") as string)
          : (t("auth.closeSignUpOverlay") as string)
      }
      onRequestCloseAction={onRequestCloseAction}
      onAnimatedCloseRef={(fn) => {
        triggerAnimatedCloseRef.current = fn;
      }}
      // "before-interaction", not "always": once the user has typed into the
      // card, a stray click on the transparent backdrop tore the overlay down
      // and threw away their email/password. Matches SignInOverlay's default
      // (see its "does not dismiss from backdrop once the user has
      // interacted" test). Escape and the X button still close at any time —
      // both are unambiguous intent.
      backdropDismissBehavior="before-interaction"
      escapeDismissBehavior="always"
      isDismissDisabled={isSubmitting}
      dismissGuardMs={250}
    >
      {transition ? (
        // During a slide: render BOTH panels stacked. Each layer is its own
        // fresh DOM node with its own animation — no animation state carries
        // between transitions. The incoming panel is in-flow so the container
        // sizes to it; the outgoing panel overlays absolutely.
        <YStack
          position="relative"
          overflow="hidden"
          // The clip is load-bearing here — it is what hides the outgoing
          // panel as it slides off — so the shadow gets ROOM rather than the
          // clip being dropped. The box grows by exactly the gutter and the
          // padding gives it straight back, so the card inside still measures
          // its full 480 and the shadow lands in the reserved strip.
          paddingRight={shadowGutter}
          paddingBottom={shadowGutter}
          style={{ width: `calc(100% + ${shadowGutter}px)` }}
        >
          <YStack
            key={`enter-${transition.to}`}
            width="100%"
            style={getPanelEnterStyle(transition.direction)}
          >
            {renderPanel(transition.to)}
          </YStack>
          <YStack
            key={`exit-${transition.from}`}
            position="absolute"
            top={0}
            left={0}
            width="100%"
            style={getPanelExitStyle(transition.direction)}
            pointerEvents="none"
            // `inert`, not just `pointerEvents`: for the whole slide the
            // outgoing panel is still a live subtree, so a screen reader met
            // TWO `h1`s and a fast Tab could land on a control that is
            // travelling off-screen and about to unmount. `inert` takes both
            // the a11y entry and the tab stop, and unlike `aria-hidden` it
            // does not warn when focus is still inside. (`EmailCodeSignIn`
            // uses it the same way on its collapsed panel.)
            {...({ inert: true } as Record<string, unknown>)}
          >
            {renderPanel(transition.from)}
          </YStack>
        </YStack>
      ) : (
        // No clip: nothing here overflows except the card's own print shadow,
        // and hiding it was the whole defect.
        <YStack key={`idle-${currentPanel}`} width="100%">
          {renderPanel(currentPanel)}
        </YStack>
      )}
    </AuthOverlayShell>
  );
};

UnifiedAuthOverlay.displayName = "UnifiedAuthOverlay";
