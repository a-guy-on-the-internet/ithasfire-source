import { z } from "zod";

import { SECOND_FACTOR_STAFF_ROLES } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

/**
 * One-time sweep, run by the owner at deploy: sign out every staff account
 * that has a second factor enrolled.
 *
 * Before the sign-in gate in `apps/api/src/auth/second-factor-bypass.ts`
 * learned about passkey-only staff, a staff account with a passkey and no
 * authenticator app could sign in with its password (or the inbox, or
 * Google / Apple) and get a full session. `hasStaffRole` checks that a factor
 * is ENROLLED, not that the session passed one, and sessions slide, so those
 * sessions keep staff authority after the deploy. A session row does not say
 * how it was minted, so every enrolled staff holder is signed out, TOTP
 * holders included. Staff with no factor enrolled are left alone: their roles
 * grant nothing yet.
 *
 * `dryRun: true` counts and writes nothing. Otherwise one transaction: the
 * selection is re-read inside it, each holder's sessions are deleted, and
 * each holder gets one `staff.sessions_revoked` audit row (also when they
 * had no session, so the run is on record per person). Re-running is safe:
 * it signs the same people out again.
 */

export const revokeSecondFactorStaffSessionsInputSchema = z
  .object({ dryRun: z.boolean() })
  .strict();

export const revokeSecondFactorStaffSessionsOutputSchema = z
  .object({
    dryRun: z.boolean(),
    /** Staff holders with a factor enrolled. */
    humans: z.number().int().nonnegative(),
    /** Session rows those holders had when counted. */
    sessionsFound: z.number().int().nonnegative(),
    /** Session rows deleted (0 on a dry run). */
    sessionsRevoked: z.number().int().nonnegative(),
  })
  .strict();

export type RevokeSecondFactorStaffSessionsOutput = z.infer<
  typeof revokeSecondFactorStaffSessionsOutputSchema
>;

export type RevokeSecondFactorStaffSessionsDeps = {
  repos: Pick<Repos, "authz" | "tx">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function revokeSecondFactorStaffSessions(
  deps: RevokeSecondFactorStaffSessionsDeps,
  rawInput: unknown,
): Promise<RevokeSecondFactorStaffSessionsOutput> {
  const input = parseInput(revokeSecondFactorStaffSessionsInputSchema, rawInput);

  if (input.dryRun) {
    const holders = await deps.repos.authz.listSecondFactorStaffAuthUsers(
      SECOND_FACTOR_STAFF_ROLES,
    );
    return revokeSecondFactorStaffSessionsOutputSchema.parse({
      dryRun: true,
      humans: holders.length,
      sessionsFound: holders.reduce((sum, h) => sum + h.sessionCount, 0),
      sessionsRevoked: 0,
    });
  }

  const result = await deps.repos.tx(async (tx) => {
    const now = deps.clock.now();
    const holders = await tx.authz.listSecondFactorStaffAuthUsers(
      SECOND_FACTOR_STAFF_ROLES,
    );
    let sessionsFound = 0;
    let sessionsRevoked = 0;
    for (const holder of holders) {
      sessionsFound += holder.sessionCount;
      const { count } = await tx.humans.invalidateSessionsForAuthUsers([
        holder.authUserId,
      ]);
      sessionsRevoked += count;
      await tx.audit.log({
        entity: "Human",
        entityId: holder.humanId,
        action: "staff.sessions_revoked",
        data: {
          actorHumanId: null,
          source: "OPS_SCRIPT",
          reason: "second_factor_staff_sweep",
          authUserId: holder.authUserId,
          sessionsInvalidated: count,
        },
        at: now,
      });
    }
    return { humans: holders.length, sessionsFound, sessionsRevoked };
  });

  deps.logger?.info("platform.revokeSecondFactorStaffSessions.done", result);

  return revokeSecondFactorStaffSessionsOutputSchema.parse({
    dryRun: false,
    ...result,
  });
}
