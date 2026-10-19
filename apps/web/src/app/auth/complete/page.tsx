"use client";

import { Suspense, useCallback, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { YStack } from "tamagui";

import { Button, NextLinkAnchor, Text, useNotify, useTranslations } from "@th/ui";

import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { ForgotPasswordCard } from "@/components/auth/ForgotPasswordCard";
import { LoginCard } from "@/components/auth/LoginCard";
import { SignUpCard } from "@/components/auth/SignUpCard";
import { VerifyEmailCard } from "@/components/auth/VerifyEmailCard";
import { Setup2faCard } from "@/components/auth/Setup2faCard";
import { WelcomeProfileCard } from "@/components/auth/WelcomeProfileCard";
import { TwoFactorChallengeCard } from "@/components/auth/TwoFactorChallengeCard";
import { resolvePostAuthDestination } from "@/components/auth/auth-helpers";

type Panel =
  | "sign-in"
  | "sign-up"
  | "forgot-password"
  | "verify-email"
  | "setup-2fa"
  | "welcome-profile"
  | "verify-2fa";

/**
 * Account-completion landing (`/auth/complete?email=…&src=…`) — the link
 * shipped in volunteer signup / coordinator invite emails for shadow
 * profiles created from a contact email.
 *
 * HONEST-MINIMAL: there is no token-based claim flow yet. Signing up (or
 * signing in) with the SAME email is what links the shadow profile — the
 * existing guest-human merge runs server-side on account creation. This
 * page explains that and hands off into the standard auth panels with the
 * email prefilled where the cards support it (sign-in; the sign-up card
 * has no prefill prop, so the banner keeps the address visible).
 */
const AuthCompleteContent = () => {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const { toast } = useNotify();
  const searchParams = useSearchParams();
  const email = (searchParams.get("email") ?? "").trim();

  const [currentPanel, setCurrentPanel] = useState<Panel>("sign-up");
  const [signUpEmail, setSignUpEmail] = useState("");
  const [signUpPassword, setSignUpPassword] = useState("");
  const [signInPrefillEmail, setSignInPrefillEmail] = useState(email);
  const [signInNotice, setSignInNotice] = useState<string | null>(null);

  useDocumentTitle(String(t("volunteering.authCompleteTitle")));

  const navigateHome = useCallback(() => {
    const destination = resolvePostAuthDestination(null);
    if (destination !== pathname) router.replace(destination);
  }, [router, pathname]);

  const showAuthError = useCallback(
    (message: string | null) => {
      if (!message) return;
      toast.danger(message, {
        title:
          currentPanel === "sign-in"
            ? (t("auth.signInFailed") as string)
            : (t("auth.signUpFailed") as string),
      });
    },
    [toast, t, currentPanel],
  );

  return (
    <YStack
      minHeight="100vh"
      alignItems="center"
      justifyContent="center"
      paddingHorizontal="$3"
      paddingVertical="$4"
      $gtSm={{ paddingHorizontal: "$5", paddingVertical: "$6" }}
      backgroundColor="$background"
    >
      <YStack width="100%" maxWidth={960} alignItems="center" gap="$5">
        <Button variant="ghost" asChild size="$2">
          <NextLinkAnchor href="/">
            ← {String(t("auth.returnHome"))}
          </NextLinkAnchor>
        </Button>

        {/* Why-am-I-here explainer — the emailed link's context. */}
        <YStack
          gap="$2"
          maxWidth={480}
          width="100%"
          padding="$4"
          borderWidth={2}
          borderColor="$borderColor"
          borderRadius={0}
          data-testid="auth-complete-explainer"
        >
          <Text variant="subtitle" weight="bold">
            {String(t("volunteering.authCompleteTitle"))}
          </Text>
          <Text variant="bodySmall" tone="muted">
            {email
              ? String(
                  t("volunteering.authCompleteBodyWithEmail", { email }),
                )
              : String(t("volunteering.authCompleteBody"))}
          </Text>
          <Text variant="caption" tone="muted">
            {String(t("volunteering.authCompleteHint"))}
          </Text>
        </YStack>

        {currentPanel === "sign-in" ? (
          <LoginCard
            initialIdentifier={signInPrefillEmail || email || undefined}
            noticeMessage={signInNotice}
            onErrorMessageChangeAction={showAuthError}
            onRequestCreateAccountAction={() => {
              setSignInNotice(null);
              setCurrentPanel("sign-up");
            }}
            onRequestForgotPasswordAction={() =>
              setCurrentPanel("forgot-password")
            }
            onTwoFactorRequiredAction={() => setCurrentPanel("verify-2fa")}
            onEmailNotVerifiedAction={(verifyEmail, password) => {
              setSignUpEmail(verifyEmail);
              setSignUpPassword(password);
              setCurrentPanel("verify-email");
            }}
          />
        ) : null}

        {currentPanel === "sign-up" ? (
          <YStack gap="$3" alignItems="center" width="100%">
            <SignUpCard
              onErrorMessageChangeAction={showAuthError}
              onRequestSignInAction={() => setCurrentPanel("sign-in")}
              onSignUpSuccessAction={(newEmail, password) => {
                setSignUpEmail(newEmail);
                setSignUpPassword(password);
                setCurrentPanel("verify-email");
              }}
              onAccountExistsAction={(existingEmail) => {
                setSignInPrefillEmail(existingEmail);
                setSignInNotice(String(t("auth.scAccountExists")));
                setCurrentPanel("sign-in");
              }}
            />
            <Button
              variant="ghost"
              size="$2"
              onPress={() => setCurrentPanel("sign-in")}
              data-testid="auth-complete-switch-sign-in"
            >
              {String(t("volunteering.authCompleteAlreadyHave"))}
            </Button>
          </YStack>
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

        {currentPanel === "setup-2fa" ? (
          <Setup2faCard
            password={signUpPassword}
            // Step 3 (secure) no longer ends the flow — done AND skip advance
            // to the profile step, same as the overlay and the standalone
            // shell. This host used to jump home here, which left an account
            // created from a shadow profile with the placeholder name forever.
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

export default function AuthCompletePage() {
  return (
    <Suspense fallback={null}>
      <AuthCompleteContent />
    </Suspense>
  );
}
