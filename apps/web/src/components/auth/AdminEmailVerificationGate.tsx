"use client";

import { useMemo } from "react";

import { isRateLimitedPrompt } from "@/lib/storage/web-storage";
import {
  useEmailVerificationPrompt,
  useSafeNotify,
  useSafeTranslations,
} from "./useEmailVerificationPrompt";

export type AdminEmailVerificationGateMode = "banner" | "block";

type AdminEmailVerificationGateProps = {
  children: React.ReactNode;
  mode?: AdminEmailVerificationGateMode;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ADMIN_VERIFY_EMAIL_PROMPT_KEY = "th:admin:verify-email:lastPromptAt";

export const AdminEmailVerificationGate = ({
  children,
  mode = "banner",
}: AdminEmailVerificationGateProps) => {
  const { alert } = useSafeNotify();
  const t = useSafeTranslations();
  // Send / reopen / verify live in the shared hook (also behind the B2
  // own-orders prompt, `EmailVerificationRequired`). VerifyEmailCard refreshes
  // the session on success, so `isVerified` flips and this gate drops away.
  const {
    isPending,
    isSignedIn,
    isVerified,
    email,
    isSending,
    canSend,
    sentAt,
    openVerify,
    verifyModal,
  } = useEmailVerificationPrompt();

  // One-time (rate-limited) nudge when admins land in the admin area.
  useMemo(() => {
    if (typeof window === "undefined") return;
    if (isPending) return;
    if (!isSignedIn) return;
    if (isVerified) return;
    if (isRateLimitedPrompt(ADMIN_VERIFY_EMAIL_PROMPT_KEY, ONE_DAY_MS)) return;

    alert.warning({
      title: t("auth.evgVerifyTitle") as string,
      message: t("auth.evgNudgeMessage") as string,
    });
  }, [isPending, isSignedIn, isVerified, alert, t]);

  if (isPending) {
    return <>{children}</>;
  }

  if (!isSignedIn || isVerified) {
    return <>{children}</>;
  }

  const banner = (
    <div
      role="status"
      style={{
        width: "100%",
        background: "rgba(245, 158, 11, 0.12)",
        border: "2px solid rgba(245, 158, 11, 0.35)",
        borderRadius: 0,
        padding: 12,
        marginBottom: 16,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700 }}>
          {String(t("auth.evgBannerTitle"))}
        </div>
        <div style={{ fontSize: 13, opacity: 0.85, lineHeight: 1.3 }}>
          {String(
            t("auth.evgBannerDesc", {
              email: email ?? (t("auth.evgYourInbox") as string),
            }),
          )}
          {sentAt ? ` ${String(t("auth.evgRecentlyResent"))}` : null}
        </div>
      </div>
      <button
        type="button"
        onClick={openVerify}
        disabled={!canSend}
        style={{
          borderRadius: 0,
          padding: "10px 12px",
          border: "2px solid rgba(0,0,0,0.15)",
          // Raised chip on the amber banner wash. The label inherits the body
          // ink, so a hardcoded white only happened to work on the light
          // canvas; $surface keeps the pairing intact in every theme.
          background: "var(--surface, #FDFAF3)",
          cursor: canSend ? "pointer" : "not-allowed",
          whiteSpace: "nowrap",
        }}
      >
        {isSending
          ? String(t("auth.evgSending"))
          : String(t("auth.evgResendEmail"))}
      </button>
    </div>
  );

  if (mode === "banner") {
    return (
      <>
        {banner}
        {verifyModal}
        {children}
      </>
    );
  }

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: 24 }}>
      {banner}
      {verifyModal}
      <div
        style={{
          padding: 16,
          borderRadius: 0,
          border: "2px solid rgba(0,0,0,0.12)",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 8 }}>
          {String(t("auth.evgBlockTitle"))}
        </div>
        <div style={{ fontSize: 14, opacity: 0.9, lineHeight: 1.4 }}>
          {String(t("auth.evgBlockDesc"))}
        </div>
      </div>
    </div>
  );
};

AdminEmailVerificationGate.displayName = "AdminEmailVerificationGate";
