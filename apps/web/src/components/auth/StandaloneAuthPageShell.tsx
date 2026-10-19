"use client";

import { useCallback, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { YStack } from "tamagui";

import { Button, NextLinkAnchor, useNotify, useTranslations } from "@th/ui";

import { useDocumentTitle } from "@/hooks/useDocumentTitle";

import { ForgotPasswordCard } from "./ForgotPasswordCard";
import { LoginCard } from "./LoginCard";
import { SignUpCard } from "./SignUpCard";
import { VerifyEmailCard } from "./VerifyEmailCard";
import { Setup2faCard } from "./Setup2faCard";
import { WelcomeProfileCard } from "./WelcomeProfileCard";
import { TwoFactorChallengeCard } from "./TwoFactorChallengeCard";
import { resolvePostAuthDestination } from "./auth-helpers";

export type StandaloneAuthPanel =
  | "sign-in"
  | "sign-up"
  | "forgot-password"
  | "verify-email"
  | "setup-2fa"
  | "welcome-profile"
  | "verify-2fa";

/**
 * Why this is three-valued rather than a boolean.
 *
 * `/sign-in` reaches the "you're stuck" state via two very different routes and
 * the user needs to be told which. The one that actually shipped to production
 * — a host-only session cookie the api host accepts and the apex never sees —
 * always re-checks as a VALID session, because that re-check is another
 * browser→api-host call. So the "your session expired" copy could never fire
 * for the exact user who hit the bug; they got a blank page followed by a bare
 * form with no explanation at all.
 *
 *  - `none`      — nothing to say (still checking, or nothing went wrong).
 *  - `expired`   — the server answered with no session. Note this is the
 *                  ambiguous answer: it covers a genuinely-ended session AND a
 *                  degraded API (`customSession` turns internal failures into
 *                  `200 + null`). The copy is safe under both readings.
 *  - `unverified` — the server confirmed the session, yet the page we were
 *                  sent to would not accept it. Nothing expired; the session
 *                  simply isn't usable where the user was headed.
 *  - `twoFactorUsePrimary` — the API refused a sign-in that skipped the second
 *                  factor (Google / Apple for a two-factor account) and sent
 *                  the browser here with `?error=TWO_FACTOR_ACCOUNT_USE_PRIMARY_SIGN_IN`.
 *  - `staffUsePasskey` — the API refused a staff account with a passkey and no
 *                  authenticator app on anything but its passkey
 *                  (`?error=STAFF_ACCOUNT_USE_PASSKEY`).
 *  - `accountNotActive` — the API refused a banned or deactivated account
 *                  (`?error=account_not_active`).
 */
export type StandaloneAuthSessionNotice =
  | "none"
  | "expired"
  | "unverified"
  | "twoFactorUsePrimary"
  | "staffUsePasskey"
  | "accountNotActive";

export type StandaloneAuthPageShellProps = {
  initialPanel: StandaloneAuthPanel;
  /**
   * The "← return home" escape hatch above the card. Defaults ON.
   *
   * It used to default OFF, and only `/sign-in` opted in — so `/sign-up`, a
   * page a stranger can land on cold from an OAuth bounce or a shared link,
   * had no way back to the product without the browser's back button. Two
   * pages of the same flow, two different answers to "can I leave?".
   */
  showReturnHomeAction?: boolean;
  /**
   * Shows a calm explanation above the sign-in form. Set by `/sign-in` when it
   * detects that the client is holding a session the server can't use, so the
   * user understands why they're being asked to sign in again instead of
   * landing on a bare form. Also set from `?error=` when the API refused a
   * sign-in (see `sign-in-error-notice.ts`).
   */
  sessionNotice?: StandaloneAuthSessionNotice;
};

const SESSION_NOTICE_KEYS: Record<
  Exclude<StandaloneAuthSessionNotice, "none">,
  string
> = {
  expired: "auth.staleSessionSignInAgain",
  unverified: "auth.unverifiableSessionSignInAgain",
  twoFactorUsePrimary: "auth.twoFactorUsePrimarySignIn",
  staffUsePasskey: "auth.staffUsePasskeySignIn",
  accountNotActive: "auth.accountNotActiveSignIn",
};

export const StandaloneAuthPageShell = ({
  initialPanel,
  showReturnHomeAction = true,
  sessionNotice = "none",
}: StandaloneAuthPageShellProps) => {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const { toast } = useNotify();
  const [currentPanel, setCurrentPanel] =
    useState<StandaloneAuthPanel>(initialPanel);
  const [signUpEmail, setSignUpEmail] = useState("");
  const [signUpPassword, setSignUpPassword] = useState("");
  // Set when sign-up fails because the account already exists: route to
  // sign-in, prefill this email, and show a friendly notice.
  const [signInPrefillEmail, setSignInPrefillEmail] = useState("");
  const [signInNotice, setSignInNotice] = useState<string | null>(null);

  // Derived, not state: the caller can change `sessionNotice` after mount (the
  // bounce is only detected on a timer, and its verdict resolves later still),
  // and an in-flow notice (e.g. "you already have an account") always wins
  // over it.
  let staleSessionNotice: ReactNode = null;
  if (sessionNotice === "accountNotActive") {
    // The one notice with a way out: the public support page, which works
    // signed out.
    staleSessionNotice = (
      <>
        {String(t(SESSION_NOTICE_KEYS.accountNotActive))}{" "}
        {/* `style`, not Tamagui props: NextLinkAnchor forwards only `style`
            to the real <a>, and its default is a block-level flex row with no
            underline, which reads as plain text inside a sentence. */}
        <NextLinkAnchor
          href="/support"
          style={{ display: "inline", textDecoration: "underline" }}
        >
          {String(t("auth.accountNotActiveContactSupport"))}
        </NextLinkAnchor>
      </>
    );
  } else if (sessionNotice !== "none") {
    staleSessionNotice = String(t(SESSION_NOTICE_KEYS[sessionNotice]));
  }

  const navigateHome = useCallback(() => {
    const destination = resolvePostAuthDestination(null);
    if (destination !== pathname) router.replace(destination);
  }, [router, pathname]);

  // Surface auth form-level errors as a Sonner toast (mirrors
  // UnifiedAuthOverlay). Without this the standalone sign-in card was silent
  // and sign-up showed a raw inline banner.
  const showAuthError = useCallback(
    (message: string | null) => {
      if (!message) return;
      const title =
        currentPanel === "sign-in"
          ? (t("auth.signInFailed") as string)
          : (t("auth.signUpFailed") as string);
      toast.danger(message, { title });
    },
    [toast, t, currentPanel],
  );

  const panelTitleKey: Record<StandaloneAuthPanel, string> = {
    "sign-in": "auth.signInTitle",
    "sign-up": "auth.signUpTitle",
    "forgot-password": "auth.fpTitle",
    "verify-email": "auth.verifyTitle",
    "setup-2fa": "auth.signUpTitle",
    "welcome-profile": "auth.signUpTitle",
    "verify-2fa": "auth.signInTitle",
  };
  useDocumentTitle(
    String(
      t(panelTitleKey[currentPanel], {
        appTitle: String(t("common.appTitle")),
      }),
    ),
  );

  return (
    <YStack
      minHeight="100vh"
      alignItems="center"
      justifyContent="center"
      paddingHorizontal="$3"
      paddingVertical="$4"
      $gtSm={{ paddingHorizontal: "$5", paddingVertical: "$6" }}
      $gtMd={{ paddingHorizontal: "$6", paddingVertical: "$6" }}
      backgroundColor="$background"
      position="relative"
      overflow="hidden"
    >
      {/* Ledger-paper backdrop — an INK hairline grid on the 32px module.
          It was 4% sand-on-sand (`rgba(231, 206, 150, 0.04)` over the
          #F6F0E4 canvas), i.e. a difference of well under one 8-bit step:
          it rendered as flat nothing in every screenshot. 6% ink reads as
          ruled paper under the stub without competing with it, and tracks
          the theme because the hue comes from `--color`.
          UniverseDust lives in the root layout so navigating back to home
          doesn't reset its particle state. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 0,
          pointerEvents: "none",
          backgroundImage:
            "linear-gradient(color-mix(in srgb, var(--color, #211c16) 6%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--color, #211c16) 6%, transparent) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }}
      />
      <YStack
        width="100%"
        maxWidth={960}
        alignItems="center"
        gap="$6"
        position="relative"
        zIndex={1}
      >
        {showReturnHomeAction ? (
          <Button variant="ghost" asChild size="$2">
            <NextLinkAnchor href="/">
              ← {String(t("auth.returnHome"))}
            </NextLinkAnchor>
          </Button>
        ) : null}

        {currentPanel === "sign-in" ? (
          <LoginCard
            initialIdentifier={signInPrefillEmail || undefined}
            noticeMessage={signInNotice ?? staleSessionNotice}
            onErrorMessageChangeAction={showAuthError}
            onRequestCreateAccountAction={() => {
              setSignInNotice(null);
              // The prefill goes with the notice. It is not cosmetic —
              // `LoginCard` reads it at mount to decide whether it opens on
              // step 1 or step 2 — so leaving it set stranded the next visit
              // on the password step for an address the user had just
              // declined to sign in with. (No slide on this shell, so unlike
              // the overlay the clear can be synchronous: the outgoing card
              // unmounts in the same commit.)
              setSignInPrefillEmail("");
              setCurrentPanel("sign-up");
            }}
            onRequestForgotPasswordAction={() =>
              setCurrentPanel("forgot-password")
            }
            onTwoFactorRequiredAction={() => setCurrentPanel("verify-2fa")}
            onEmailNotVerifiedAction={(email, password) => {
              setSignUpEmail(email);
              setSignUpPassword(password);
              setCurrentPanel("verify-email");
            }}
          />
        ) : null}

        {currentPanel === "sign-up" ? (
          <SignUpCard
            onErrorMessageChangeAction={showAuthError}
            onRequestSignInAction={() => setCurrentPanel("sign-in")}
            onSignUpSuccessAction={(email, password) => {
              setSignUpEmail(email);
              setSignUpPassword(password);
              setCurrentPanel("verify-email");
            }}
            onAccountExistsAction={(email) => {
              setSignInPrefillEmail(email);
              setSignInNotice(String(t("auth.scAccountExists")));
              setCurrentPanel("sign-in");
            }}
          />
        ) : null}

        {currentPanel === "forgot-password" ? (
          <ForgotPasswordCard
            onRequestSignInAction={() => setCurrentPanel("sign-in")}
          />
        ) : null}

        {currentPanel === "verify-email" ? (
          <VerifyEmailCard
            email={signUpEmail}
            password={signUpPassword || undefined}
            onContinueAction={() => setCurrentPanel("setup-2fa")}
            onSkipAction={navigateHome}
          />
        ) : null}

        {/* Sign-up is four panels: sign-up → verify-email → setup-2fa →
            welcome-profile → destination. Securing (or skipping it) is not
            the end of the flow; the profile step is. */}
        {currentPanel === "setup-2fa" ? (
          <Setup2faCard
            password={signUpPassword}
            onDoneAction={() => setCurrentPanel("welcome-profile")}
            onSkipAction={() => setCurrentPanel("welcome-profile")}
          />
        ) : null}

        {currentPanel === "welcome-profile" ? (
          <WelcomeProfileCard
            onDoneAction={navigateHome}
            onSkipAction={navigateHome}
          />
        ) : null}

        {currentPanel === "verify-2fa" ? (
          <TwoFactorChallengeCard
            onVerifiedAction={navigateHome}
            onBackAction={() => setCurrentPanel("sign-in")}
          />
        ) : null}
      </YStack>
    </YStack>
  );
};

StandaloneAuthPageShell.displayName = "StandaloneAuthPageShell";
