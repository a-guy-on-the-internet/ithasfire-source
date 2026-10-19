"use client";

import { useCallback, useRef, useState } from "react";
import { useNotify, useTranslations } from "@th/ui";
import { AuthOverlayShell } from "./AuthOverlayShell";
import { LoginCard } from "./LoginCard";

export type SignInOverlayProps = {
  redirectOverride?: string | null;
  onRequestCloseAction?: () => void;
  onRequestSignUpAction?: () => void;
  onSignInSuccessAction?: () => void;
};

export const SignInOverlay = ({
  redirectOverride,
  onRequestCloseAction,
  onRequestSignUpAction,
  onSignInSuccessAction,
}: SignInOverlayProps = {}) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useNotify();
  const t = useTranslations();
  const triggerAnimatedCloseRef = useRef<(() => void) | null>(null);

  const handleErrorMessageChange = useCallback(
    (message: string | null) => {
      if (message) {
        toast.danger(message, { title: t("auth.signInFailed") as string });
      }
    },
    [toast, t],
  );

  const handleSignInSuccess = useCallback(() => {
    // Trigger animated close, then call success callback
    if (triggerAnimatedCloseRef.current) {
      triggerAnimatedCloseRef.current();
    }
    onSignInSuccessAction?.();
  }, [onSignInSuccessAction]);

  return (
    <AuthOverlayShell
      id="sign-in-overlay"
      backdropTestId="sign-in-overlay-backdrop"
      layerTestId="sign-in-overlay-layer"
      closeLabel={t("auth.closeSignInOverlay") as string}
      onRequestCloseAction={onRequestCloseAction}
      onAnimatedCloseRef={(fn) => {
        triggerAnimatedCloseRef.current = fn;
      }}
      isDismissDisabled={isSubmitting}
      dismissGuardMs={250}
    >
      <LoginCard
        redirectOverride={redirectOverride}
        onDismissAction={onRequestCloseAction}
        onRequestCreateAccountAction={onRequestSignUpAction}
        onStatusChangeAction={(status) => {
          setIsSubmitting(status === "submitting");
        }}
        onSignInSuccessAction={handleSignInSuccess}
        onErrorMessageChangeAction={handleErrorMessageChange}
      />
    </AuthOverlayShell>
  );
};

SignInOverlay.displayName = "SignInOverlay";
