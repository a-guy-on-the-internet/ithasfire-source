import "server-only";

import { cache } from "react";
import * as Sentry from "@sentry/nextjs";

import { getServerTrpcClient } from "@/server/trpc-client";

export type PlatformStaffAccessResult = {
  allowed: boolean;
  /** Enrolled passkey or TOTP. `false` (not computed) when `!allowed`. */
  secondFactorEnrolled: boolean;
};

const DENIED: PlatformStaffAccessResult = {
  allowed: false,
  secondFactorEnrolled: false,
};

/**
 * Server-side mirror of `PlatformShell`'s `platform.checkStaffAccess` gate
 * (any PLATFORM_STAFF_ROLES member — ADMIN, REVIEWER, SUPPORT, DEVELOPER),
 * called through the SAME tRPC procedure the client uses so the staff check
 * never drifts between SSR and CSR.
 *
 * Written as the direct peer of `server/moderator-access.ts` — same shape,
 * same `cache()`, same fail-closed posture — because `/platform` had NO
 * server-side check at all: `app/platform/layout.tsx` rendered `PlatformShell`
 * unconditionally, so before the edge gate in
 * `middleware/staff-route-gate.ts` there was exactly one boundary on the staff
 * console's document response, and it was CLIENT-side.
 *
 * `checkStaffAccess` is an `authedProcedure`: an anonymous caller (no
 * forwarded session) makes the underlying query throw UNAUTHORIZED before this
 * resolves. Callers that need to distinguish "no session" from "signed in, not
 * staff" should check `getServerSession()` FIRST, exactly as
 * `ModerateLayout` does.
 *
 * Also surfaces `secondFactorEnrolled` (step-up 2FA gate). The procedure is
 * deliberately excluded from `requireStaffSecondFactor`'s gated-path allowlist
 * (`packages/transport/trpc/src/guard.ts`) so it keeps answering for staff who
 * haven't enrolled one — that's a UX signal, not the enforcement boundary.
 *
 * Fails CLOSED: any error — UNAUTHORIZED, a downstream API outage, a network
 * hiccup — resolves to `{ allowed: false, secondFactorEnrolled: false }`,
 * matching `PlatformShell`'s own `isError || !allowed` → `/access-denied`
 * branch.
 */
export const checkPlatformStaffAccessServer = cache(
  async (): Promise<PlatformStaffAccessResult> => {
    try {
      const client = getServerTrpcClient();
      const result = await client.platform.checkStaffAccess.query();
      if (result.allowed !== true) return DENIED;
      return {
        allowed: true,
        secondFactorEnrolled: result.secondFactorEnrolled === true,
      };
    } catch (err) {
      // NOTE: a signed-in-but-not-staff caller does NOT land here —
      // `hasStaffRole` returns `{ allowed: false }` as a normal value, so the
      // `!== true` check above handles that without throwing. This catch is
      // reserved for genuine anomalies (missing actor id, downstream outage,
      // network hiccup) that would otherwise fail closed with no signal —
      // report them, per the Jun 2026 silent-search-outage convention in
      // CLAUDE.md.
      Sentry.captureException(err, {
        tags: { area: "ssr-auth-gate", check: "platform-staff-access" },
      });
      return DENIED;
    }
  },
);
