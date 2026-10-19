import "server-only";

import { cache } from "react";
import * as Sentry from "@sentry/nextjs";

import { getServerTrpcClient } from "@/server/trpc-client";

export type ModeratorAccessResult = {
  allowed: boolean;
  /** Enrolled passkey or TOTP. `false` (not computed) when `!allowed`. */
  secondFactorEnrolled: boolean;
};

const DENIED: ModeratorAccessResult = {
  allowed: false,
  secondFactorEnrolled: false,
};

/**
 * Server-side mirror of `ModerateShell`'s `community.checkModeratorAccess`
 * gate (COMMUNITY_MODERATOR or platform ADMIN — see
 * `packages/core/src/use-cases/community/_shared/suggestion-validation.ts`),
 * called through the SAME tRPC procedure the client uses so the moderator
 * role check never drifts between SSR and CSR.
 *
 * `checkModeratorAccess` is an `authedProcedure`: an anonymous caller (no
 * forwarded session) makes the underlying query throw UNAUTHORIZED before
 * this ever resolves. Callers that need to distinguish "no session" (→
 * sign-in) from "signed in, not a moderator" (→ /access-denied) should check
 * `getServerSession()` FIRST and only call this once a session is confirmed
 * present.
 *
 * Also surfaces `secondFactorEnrolled` (step-up 2FA gate for platform/
 * moderation staff) so `ModerateLayout` can redirect a moderator missing a
 * 2nd factor to the friendly `/enroll-2fa` prompt instead of rendering the
 * shell — see `packages/transport/trpc/src/guard.ts` for why the procedure
 * itself never throws for this case (it's a UX signal, not the enforcement
 * boundary).
 *
 * Fails CLOSED: any error — UNAUTHORIZED, a downstream API outage, a
 * network hiccup — resolves to `{ allowed: false, secondFactorEnrolled: false }`,
 * matching `ModerateShell`'s own client-side `accessQuery.isError || !allowed`
 * → `/access-denied` branch.
 */
export const checkModeratorAccessServer = cache(
  async (): Promise<ModeratorAccessResult> => {
    try {
      const client = getServerTrpcClient();
      const result = await client.community.checkModeratorAccess.query();
      if (result.allowed !== true) return DENIED;
      return {
        allowed: true,
        secondFactorEnrolled: result.secondFactorEnrolled === true,
      };
    } catch (err) {
      // NOTE: a signed-in-but-not-moderator caller does NOT land here —
      // `hasStaffRole` returns `{ allowed: false }` as a normal value (see the
      // procedure above), so the `!== true` check above already handles that
      // case without throwing. This catch is therefore reserved for genuine
      // anomalies (an actor id missing despite passing the authed-procedure
      // guard, a downstream API outage, a network hiccup) that would otherwise
      // silently fail closed with no signal — report them, matching the
      // Jun 2026 silent-search-outage postmortem convention in CLAUDE.md.
      Sentry.captureException(err, {
        // `ssr-auth-gate` = the Server Component layer; the edge middleware
        // gate reports under `staff-route-gate`. See the same note in
        // `lib/auth/get-server-session.ts`.
        tags: { area: "ssr-auth-gate", check: "moderator-access" },
      });
      return DENIED;
    }
  },
);
