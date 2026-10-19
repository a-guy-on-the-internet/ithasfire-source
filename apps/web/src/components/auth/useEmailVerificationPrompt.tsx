"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Modal, useNotify, useTranslations } from "@th/ui";
import { authClient } from "@/lib/auth/auth-client";
import { VerifyEmailCard } from "./VerifyEmailCard";

/**
 * The send-a-code-then-enter-it flow behind every "verify your email" prompt,
 * extracted from `AdminEmailVerificationGate` so the admin gate and the B2
 * own-orders prompt (`EmailVerificationRequired`) share one implementation.
 *
 * Email verification is OTP-based (6-digit code), not a link: the legacy
 * `authClient.sendVerificationEmail` path is not configured server-side and
 * throws "Verification email isn't enabled". `openVerify` seeds the first
 * code, then `VerifyEmailCard` (inside `verifyModal`) owns resend, the 60s
 * cooldown, wrong-code errors and the verify call, and refreshes the session
 * on success.
 */

export const getEmailVerified = (session: unknown): boolean => {
  // Better Auth session shape can vary depending on plugins/serialization.
  // We defensively check a few common places.
  const s = session as any;
  return Boolean(
    s?.user?.emailVerified ??
    s?.user?.email_verified ??
    s?.user?.email_verified_at,
  );
};

// Don't re-issue a fresh code if one was just sent — reopen the existing
// card instead (VerifyEmailCard has its own 60s resend control). Guards
// against open/close/open spam burning codes / SES sends.
export const RESEND_WINDOW_MS = 60 * 1000;

const NOOP_TOAST = {
  info: () => "",
  success: () => "",
  warning: () => "",
  danger: () => "",
};

export function useSafeNotify() {
  try {
    return useNotify();
  } catch {
    return { toast: NOOP_TOAST, alert: NOOP_TOAST } as unknown as ReturnType<
      typeof useNotify
    >;
  }
}

export function useSafeTranslations() {
  try {
    return useTranslations();
  } catch {
    return ((key: string) => key) as ReturnType<typeof useTranslations>;
  }
}

export type UseEmailVerificationPromptOptions = {
  /** Runs once the code is accepted and the card has shown its success beat. */
  onVerified?: () => void;
};

export function useEmailVerificationPrompt({
  onVerified,
}: UseEmailVerificationPromptOptions = {}) {
  const { toast } = useSafeNotify();
  const t = useSafeTranslations();
  const { data: session, isPending } = authClient.useSession();

  const isSignedIn = Boolean((session as any)?.user);
  const isVerified = useMemo(() => getEmailVerified(session), [session]);
  const email = (session as any)?.user?.email as string | undefined;

  const [isSending, setIsSending] = useState(false);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [verifyOpen, setVerifyOpen] = useState(false);
  // True for RESEND_WINDOW_MS after a code goes out: within it the action
  // reopens the card instead of mailing another code. Flipped back by a
  // timer, so a label bound to it does not go stale.
  const [codeIsFresh, setCodeIsFresh] = useState(false);
  useEffect(() => {
    if (sentAt === null) return;
    const remaining = sentAt + RESEND_WINDOW_MS - Date.now();
    const id = setTimeout(() => setCodeIsFresh(false), Math.max(0, remaining));
    return () => clearTimeout(id);
  }, [sentAt]);

  // Held in a ref: VerifyEmailCard re-arms its 800ms success timer whenever
  // `onContinueAction` changes identity, so an inline `onVerified` from the
  // caller must not reach it directly.
  const onVerifiedRef = useRef(onVerified);
  useEffect(() => {
    onVerifiedRef.current = onVerified;
  }, [onVerified]);

  const canSend = Boolean(email) && !isSending;

  const openVerify = useCallback(async () => {
    if (!email) {
      toast.danger({
        title: t("auth.evgMissingEmail") as string,
        message: t("auth.evgMissingEmailDesc") as string,
      });
      return;
    }

    // Recently seeded? Reopen the card without sending another code.
    if (sentAt && Date.now() - sentAt < RESEND_WINDOW_MS) {
      setVerifyOpen(true);
      return;
    }

    setIsSending(true);
    try {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: "email-verification",
      });
      if (error) {
        toast.danger({
          title: t("auth.evgFailedTitle") as string,
          message: error.message ?? (t("auth.evgFailedFallback") as string),
        });
        return;
      }
      setSentAt(Date.now());
      setCodeIsFresh(true);
      setVerifyOpen(true);
    } catch (err: any) {
      toast.danger({
        title: t("auth.evgFailedTitle") as string,
        message: err?.message ?? (t("auth.evgFailedFallback") as string),
      });
    } finally {
      setIsSending(false);
    }
  }, [email, toast, t, sentAt]);

  const closeVerify = useCallback(() => setVerifyOpen(false), []);
  // A Resend from inside the card is a fresh code too: restart the window.
  const handleCodeSent = useCallback(() => {
    setSentAt(Date.now());
    setCodeIsFresh(true);
  }, []);
  const handleVerified = useCallback(() => {
    setVerifyOpen(false);
    onVerifiedRef.current?.();
  }, []);

  // OTP entry overlay. Modal.Panel is stripped of its own surface so the
  // card's AuthCardShell provides the chrome; Panel still stops backdrop
  // press-through so clicks inside the card don't dismiss the overlay.
  const verifyModal = email ? (
    <Modal open={verifyOpen} onClose={closeVerify}>
      <Modal.Panel
        width={440}
        borderWidth={0}
        backgroundColor="transparent"
        overflow="visible"
      >
        <VerifyEmailCard
          email={email}
          onContinueAction={handleVerified}
          onSkipAction={closeVerify}
          onCodeSent={handleCodeSent}
          step={{
            kind: "interruption",
            name: String(t("emailGate.stepName")),
          }}
        />
      </Modal.Panel>
    </Modal>
  ) : null;

  return {
    isPending,
    isSignedIn,
    isVerified,
    email,
    isSending,
    canSend,
    sentAt,
    codeIsFresh,
    openVerify,
    verifyModal,
  };
}
