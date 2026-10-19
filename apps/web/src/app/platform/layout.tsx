import type { ReactNode } from "react";
import type { Metadata } from "next";
import { ShieldCheck } from "lucide-react";

import { PlatformShell } from "./_components/PlatformShell";
import { PLATFORM_SECTIONS } from "./_components/platform-nav-sections";

import {
  StatusScreen,
  ButtonPrimary,
  ButtonRow,
  STATUS_ICON,
  STATUS_ICON_BG,
} from "@/components/layout/PagePrimitives";
import { getServerSession } from "@/lib/auth/get-server-session";
import { getSignInUrl } from "@/lib/auth/urls";
import { appendRedirectParam } from "@/lib/redirect";
import { checkPlatformStaffAccessServer } from "@/server/platform-staff-access";

export const metadata: Metadata = {
  title: "Platform",
  robots: { index: false, follow: false },
};

/**
 * Server-side gate for `/platform/**` — defense in depth behind
 * `middleware/staff-route-gate.ts` and ahead of `PlatformShell`'s client-side
 * check.
 *
 * This route previously had NO server-side check at all: the layout rendered
 * `PlatformShell` unconditionally, so the ONLY thing standing between an
 * anonymous `curl` and a full staff-console document was client-side
 * JavaScript. The edge gate closed that; this closes it a second time, so the
 * console is not one matcher edit away from being open again.
 *
 * WHY THIS RENDERS A DENIAL SCREEN INSTEAD OF CALLING `redirect()`:
 * `ModerateLayout` (its sibling) uses `redirect()`, but this repo has a
 * hard-won finding that a `redirect()` thrown from a Server Component did NOT
 * reliably produce a real HTTP 3xx for a full-document request — verified
 * against a production standalone build, where anonymous `curl -i` against
 * these routes (including, specifically, `app/platform/page.tsx`'s own
 * `redirect("/platform/overview")`) returned a bare `200` with no `Location`.
 * That is the entire reason `staff-route-gate.ts` exists. Relying on
 * `redirect()` here would mean the fallback layer's failure mode is "serves
 * the page anyway" — the one outcome a fallback must never have. Returning a
 * denial ELEMENT cannot fail that way: whatever the response status ends up
 * being, the console markup is not in it.
 *
 * `notFound()` was the alternative and is rejected for the same reason
 * (it throws, and it would hide a real "your 2FA lapsed" from staff who need
 * to act on it).
 *
 * Cost: two SSR round trips (`getServerSession`, then the staff probe) on
 * `/platform` renders, both `cache()`d per request. The edge gate has usually
 * already answered the same questions — accepted, deliberately, because the
 * layers must not depend on each other.
 */
export default async function PlatformLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await getServerSession();
  if (!session) {
    return (
      <StatusScreen
        icon={ShieldCheck}
        iconColor={STATUS_ICON}
        iconBg={STATUS_ICON_BG}
        title="Sign in required"
        description="The platform console is staff-only. Sign in to continue."
      >
        <ButtonRow>
          <ButtonPrimary
            href={appendRedirectParam(getSignInUrl(), "/platform")}
          >
            Sign in
          </ButtonPrimary>
        </ButtonRow>
      </StatusScreen>
    );
  }

  const access = await checkPlatformStaffAccessServer();
  if (!access.allowed) {
    return (
      <StatusScreen
        icon={ShieldCheck}
        iconColor={STATUS_ICON}
        iconBg={STATUS_ICON_BG}
        title="Access denied"
        description="You don't have permission to access the platform console."
      >
        <ButtonRow>
          <ButtonPrimary href="/">Go home</ButtonPrimary>
        </ButtonRow>
      </StatusScreen>
    );
  }

  // Staff, but no enrolled passkey/TOTP. They DO have the role — this is the
  // step-up 2FA prompt, not a denial, matching the edge gate's `/enroll-2fa`
  // redirect and `PlatformShell`'s own branch.
  if (!access.secondFactorEnrolled) {
    return (
      <StatusScreen
        icon={ShieldCheck}
        iconColor={STATUS_ICON}
        iconBg={STATUS_ICON_BG}
        title="Second factor required"
        description="Platform staff need an enrolled passkey or authenticator app before using the console."
      >
        <ButtonRow>
          <ButtonPrimary href={appendRedirectParam("/enroll-2fa", "/platform")}>
            Enroll a second factor
          </ButtonPrimary>
        </ButtonRow>
      </StatusScreen>
    );
  }

  return <PlatformShell sections={PLATFORM_SECTIONS}>{children}</PlatformShell>;
}
