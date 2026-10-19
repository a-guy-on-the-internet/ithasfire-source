"use client";

import { useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useNotify, useTranslations } from "@th/ui";

import { getAppErrorCode } from "@/lib/app-error";
import { appendRedirectParam } from "@/lib/redirect";

/**
 * Enrollment-prompt screen for staff missing a second factor — same target the
 * `/moderate` and `/platform` gates redirect to
 * (apps/web/src/middleware/staff-route-gate.ts).
 */
export const ENROLL_TWO_FACTOR_PATH = "/enroll-2fa";

/**
 * Whether a tRPC mutation error is the moderation step-up 2FA gate
 * (`SECOND_FACTOR_REQUIRED`, thrown by `requireStaffSecondFactorMiddleware`
 * in packages/transport/trpc/src/guard.ts). The code arrives on
 * `error.data.appCode` (with the message as a legacy fallback) — resolved by
 * the shared {@link getAppErrorCode} helper.
 */
export function isSecondFactorRequiredError(err: unknown): boolean {
  return getAppErrorCode(err) === "SECOND_FACTOR_REQUIRED";
}

/**
 * Build the enrollment URL with a `redirect_url` back to the current page —
 * same param + encoding as the `/moderate` edge gate
 * (`appendRedirectParam("/enroll-2fa", pathname)`).
 */
export function buildEnrollTwoFactorUrl(currentPath: string | null): string {
  return appendRedirectParam(ENROLL_TWO_FACTOR_PATH, currentPath);
}

/**
 * Shared handler for the moderation step-up 2FA gate on client-side review
 * mutations (`eventSuggestions.review` & friends).
 *
 * The `/moderate/**` surface redirects unenrolled staff to `/enroll-2fa`
 * before they can act, but the org-dashboard SuggestionInbox has no such
 * route gate — and even on `/moderate` the enrollment state can change
 * mid-session. Without this, a staff-role viewer without a second factor
 * gets a working Approve/Reject button and a generic FORBIDDEN toast.
 *
 * Returns `true` (handled) when the error is `SECOND_FACTOR_REQUIRED`, after
 * showing an explanatory toast with a "set up" action that navigates to
 * `/enroll-2fa?redirect_url=<current path>`. Returns `false` for every other
 * error so callers fall through to their own handling.
 */
export function useSecondFactorRequiredToast(): (err: unknown) => boolean {
  const t = useTranslations();
  const { toast } = useNotify();
  const router = useRouter();
  const pathname = usePathname();

  return useCallback(
    (err: unknown): boolean => {
      if (!isSecondFactorRequiredError(err)) return false;
      const enrollUrl = buildEnrollTwoFactorUrl(pathname);
      toast.warning({
        title: String(t("moderation.secondFactorRequiredToast")),
        message: String(t("moderation.secondFactorRequiredToastMessage")),
        // Give the reader time to see the action button before auto-dismiss.
        durationMs: 10_000,
        action: {
          label: String(t("moderation.secondFactorRequiredToastAction")),
          onPress: () => router.push(enrollUrl),
        },
      });
      return true;
    },
    [pathname, router, t, toast],
  );
}
