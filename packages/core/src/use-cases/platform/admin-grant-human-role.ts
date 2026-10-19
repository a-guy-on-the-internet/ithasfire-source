import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import { humanRoleSchema, isSecondFactorStaffRole } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";

/**
 * ADMIN-only platform action: grant a {@link HumanRole} to a target human.
 * Powers the /platform/roles admin UI (no such UI existed before — roles
 * were previously only settable via `pnpm seed:admin` or raw psql).
 *
 * NOTE: the bootstrap path for the very first platform admin remains
 * `apps/api/src/scripts/reference-data/seed-platform-admin.ts` (`pnpm seed:admin`) — there is
 * a chicken-and-egg problem where no ADMIN exists yet to use this UI. Do not
 * remove that script.
 *
 * `grantHumanRole` returns `{granted:false}` AMBIGUOUSLY for both "role
 * already held" and "human does not exist" (see its port doc comment), so the
 * target human is verified to exist FIRST — same calling convention as
 * `reviewModeratorApplication`. After that check, `granted:false` can only
 * mean already-held, which is a benign idempotent outcome (no error).
 *
 * A newly granted STAFF role (`SECOND_FACTOR_STAFF_ROLES`) signs the target
 * out everywhere, in the same transaction. Their open sessions were minted
 * under the rules for a non-staff account (a passkey holder could sign in
 * with the password alone), and `hasStaffRole` checks that a factor is
 * enrolled, not that this session passed one; without the sign-out such a
 * session would gain staff authority the moment the role lands. Their next
 * sign-in goes through the staff rules in `second-factor-bypass.ts`. An admin
 * who grants themselves a new staff role signs themselves out too. A sign-in
 * that read the roles just before the grant commits and inserts its session
 * just after the delete survives it (a window of milliseconds; accepted).
 */

export const adminGrantHumanRoleInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    targetHumanId: z.string().uuid(),
    role: humanRoleSchema,
  })
  .strict();

export const adminGrantHumanRoleOutputSchema = z
  .object({
    targetHumanId: z.string().uuid(),
    role: humanRoleSchema,
    granted: z.boolean(),
    sessionsInvalidated: z.number().int().nonnegative(),
  })
  .strict();

export type AdminGrantHumanRoleInput = z.infer<
  typeof adminGrantHumanRoleInputSchema
>;
export type AdminGrantHumanRoleOutput = z.infer<
  typeof adminGrantHumanRoleOutputSchema
>;

export type AdminGrantHumanRoleDeps = {
  repos: Pick<Repos, "humans" | "audit" | "tx">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function adminGrantHumanRole(
  deps: AdminGrantHumanRoleDeps,
  rawInput: unknown,
): Promise<AdminGrantHumanRoleOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "adminGrantHumanRole" });

  const execute = async (): Promise<AdminGrantHumanRoleOutput> => {
    const input = parseInput(adminGrantHumanRoleInputSchema, rawInput);

    // RBAC: platform ADMIN only (roles are the highest-leverage grant in the
    // system — unlike setHumanStatus, no other staff tier gets this action).
    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: ["ADMIN"],
    });

    const { granted, sessionsInvalidated } = await deps.repos.tx(async (tx) => {
      const now = deps.clock.now();

      const target = await tx.humans.getById(input.targetHumanId);
      if (!target) {
        throw fail("HUMAN_NOT_FOUND", {
          meta: { humanId: input.targetHumanId },
        });
      }

      const grantResult = await tx.authz.grantHumanRole({
        humanId: input.targetHumanId,
        role: input.role,
      });

      // Only a NEW staff grant: an already-held role changes nothing a
      // session can do.
      let sessionsInvalidated = 0;
      if (grantResult.granted && isSecondFactorStaffRole(input.role)) {
        const withIdentity = await tx.humans.getByIdWithIdentity(
          input.targetHumanId,
        );
        const authUserId = withIdentity?.identity?.authUserId;
        if (authUserId) {
          sessionsInvalidated = (
            await tx.humans.invalidateSessionsForAuthUsers([authUserId])
          ).count;
        }
      }

      await tx.audit.log({
        entity: "human_role",
        entityId: input.targetHumanId,
        action: "role.granted",
        data: {
          actorHumanId: input.actorHumanId,
          targetHumanId: input.targetHumanId,
          role: input.role,
          granted: grantResult.granted,
          sessionsInvalidated,
        },
        at: now,
      });

      return { granted: grantResult.granted, sessionsInvalidated };
    });

    return adminGrantHumanRoleOutputSchema.parse({
      targetHumanId: input.targetHumanId,
      role: input.role,
      granted,
      sessionsInvalidated,
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("adminGrantHumanRole", execute);
  }

  return execute();
}
