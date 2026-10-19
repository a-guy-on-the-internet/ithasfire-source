import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";

import {
  StatusScreen,
  ButtonPrimary,
  ButtonOutline,
  ButtonRow,
  STATUS_ICON,
  STATUS_ICON_BG,
} from "@/components/layout/PagePrimitives";
import { FOREGROUND } from "@/lib/design-tokens";
import { sanitizeRedirectPath } from "@/lib/redirect";

export const metadata: Metadata = {
  title: "Enroll a second factor",
  robots: { index: false, follow: false },
};

type Props = {
  searchParams: Promise<{ redirect_url?: string }>;
};

/**
 * Enrollment-prompt screen for platform/moderation staff who don't yet have
 * a second factor (passkey or authenticator app) enrolled — see the
 * step-up-2FA security-hardening item. Reached via:
 *   - `apps/web/src/middleware/staff-route-gate.ts` (edge, `/moderate` and
 *     `/platform`)
 *   - `apps/web/src/app/moderate/layout.tsx` (SSR, `/moderate`)
 *   - `apps/web/src/app/moderate/_components/ModerateShell.tsx` (client)
 *   - `apps/web/src/app/platform/_components/PlatformShell.tsx` (client)
 *
 * Deliberately NOT a hard lockout: the actor already holds the role that
 * would let them in (`platform.checkStaffAccess` /
 * `community.checkModeratorAccess` both returned `allowed: true` with
 * `secondFactorEnrolled: false`) — they just need to add a 2nd factor
 * first. Links to `/account/settings`'s Security section, where passkey/TOTP
 * enrollment already lives (see the local-dev passkey testing docs in
 * CLAUDE.md).
 */
export default async function Enroll2faPage({ searchParams }: Props) {
  const params = await searchParams;
  const returnTo = sanitizeRedirectPath(params.redirect_url ?? null);

  return (
    <StatusScreen
      icon={ShieldAlert}
      iconColor={STATUS_ICON}
      iconBg={STATUS_ICON_BG}
      title="Second factor required"
      description="Staff and moderator accounts need a passkey or authenticator app enrolled before continuing. Add one in Account Settings under Security, then come back."
    >
      <ButtonRow>
        <ButtonPrimary
          // Security is its own route now, so link straight at it. The
          // `redirect_url` round-trip is unchanged: that route renders the
          // sticky "finish setting up your second factor" banner with a
          // Continue link back to `returnTo` (re-sanitised there via
          // `readRedirectParam`). The bare `/account/settings?redirect_url=…`
          // shape still lands on Security via the index shim, so older links
          // and any bookmark keep working.
          href={
            returnTo
              ? `/account/settings/security?redirect_url=${encodeURIComponent(returnTo)}`
              : "/account/settings/security"
          }
          // Ink on the orange fill — white-on-orange is 3.16:1 (AA FAIL);
          // matches the Button atom's $onBrandSecondary (#181818).
          style={{ color: FOREGROUND }}
        >
          Go to security settings
        </ButtonPrimary>
        <ButtonOutline href={returnTo ?? "/"}>
          {returnTo ? "I've enrolled — continue" : "Go home"}
        </ButtonOutline>
      </ButtonRow>
    </StatusScreen>
  );
}
