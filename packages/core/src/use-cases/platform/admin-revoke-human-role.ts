import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import { humanRoleSchema } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";

/**
 * ADMIN-only platform action: revoke a {@link HumanRole} from a target human.
 * The revoke counterpart to `adminGrantHumanRole` — see that module's doc
 * comment for the /platform/roles UI context and the seed-platform-admin
 * bootstrap note (unchanged, still the only path to mint the first ADMIN).
 *
 * `revokeHumanRole` returns `{revoked:false}` AMBIGUOUSLY for both "role not
 * currently held" and "human does not exist" (see its port doc comment), so
 * the target human is verified to exist FIRST, same as the grant path. After
 * that check, `revoked:false` can only mean the role was never held, which is
 * a benign idempotent outcome (no error).
 *
 * Last-ADMIN lockout guard: revoking `ADMIN` from the only remaining ADMIN
 * would brick every subsequent `grantHumanRole`/`revokeHumanRole` call behind
 * `STAFF_ONLY` (the CLI `pnpm seed:admin` / raw psql would then be the only
 * recovery). Mirrors the "last OWNER" precedent in
 * `update-member-role.ts`/`remove-org-member.ts` — count-based, not a literal
 * self-action check, so it also catches an ADMIN revoking a *different*
 * human's role when that human happens to be the last ADMIN. Reuses
 * `CANNOT_DEMOTE_LAST_OWNER` (rather than minting a new `AppErrorCode`) since
 * a brand-new user-facing code would require paired en/es catalog entries in
 * `apps/web/src/i18n/messages/{en,es}.ts`, which is out of scope here; that
 * code's "you can't change this role" copy fits a role revoke better than
 * `CANNOT_REMOVE_LAST_OWNER`'s "remove this member" framing.
 *
 * Concurrency: the count-read and the revoke are two statements, so a
 * Postgres advisory lock (`tx.authz.lockAdminRoleGuard()`) closes the window
 * — see the inline comment at its call site below for the exact race it
 * prevents.
 */

export const adminRevokeHumanRoleInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    targetHumanId: z.string().uuid(),
    role: humanRoleSchema,
  })
  .strict();

export const adminRevokeHumanRoleOutputSchema = z
  .object({
    targetHumanId: z.string().uuid(),
    role: humanRoleSchema,
    revoked: z.boolean(),
  })
  .strict();

export type AdminRevokeHumanRoleInput = z.infer<
  typeof adminRevokeHumanRoleInputSchema
>;
export type AdminRevokeHumanRoleOutput = z.infer<
  typeof adminRevokeHumanRoleOutputSchema
>;

export type AdminRevokeHumanRoleDeps = {
  repos: Pick<Repos, "humans" | "audit" | "tx">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function adminRevokeHumanRole(
  deps: AdminRevokeHumanRoleDeps,
  rawInput: unknown,
): Promise<AdminRevokeHumanRoleOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "adminRevokeHumanRole" });

  const execute = async (): Promise<AdminRevokeHumanRoleOutput> => {
    const input = parseInput(adminRevokeHumanRoleInputSchema, rawInput);

    // RBAC: platform ADMIN only (mirrors adminGrantHumanRole).
    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: ["ADMIN"],
    });

    const revoked = await deps.repos.tx(async (tx) => {
      const now = deps.clock.now();

      const target = await tx.humans.getById(input.targetHumanId);
      if (!target) {
        throw fail("HUMAN_NOT_FOUND", {
          meta: { humanId: input.targetHumanId },
        });
      }

      // Last-ADMIN lockout guard (see module doc comment). Only relevant when
      // revoking ADMIN itself, and only blocks when the target is currently
      // the sole ADMIN — revoking a role the target doesn't hold is still the
      // benign idempotent no-op handled below.
      //
      // Concurrency: count-then-act across two statements is unsafe on its
      // own — two concurrent revokes targeting two DIFFERENT ADMINs each take
      // their own READ COMMITTED snapshot before the other commits, so both
      // can see "2 ADMINs left" and both proceed, leaving zero. The two
      // writes land on two different `Human` rows, so there's no shared row
      // for Postgres to serialize on. `lockAdminRoleGuard` takes a
      // transaction-scoped Postgres advisory lock BEFORE the count-read so
      // every concurrent ADMIN-revoke transaction queues behind the same
      // lock and re-reads a fresh, post-commit count — closing that race.
      if (input.role === "ADMIN") {
        await tx.authz.lockAdminRoleGuard();
        const admins = await tx.authz.listHumanIdsByStaffRole("ADMIN");
        const isLastAdmin =
          admins.length <= 1 && admins.includes(input.targetHumanId);
        if (isLastAdmin) {
          throw fail("CANNOT_DEMOTE_LAST_OWNER", {
            meta: { humanId: input.targetHumanId },
          });
        }
      }

      const revokeResult = await tx.authz.revokeHumanRole({
        humanId: input.targetHumanId,
        role: input.role,
      });

      await tx.audit.log({
        entity: "human_role",
        entityId: input.targetHumanId,
        action: "role.revoked",
        data: {
          actorHumanId: input.actorHumanId,
          targetHumanId: input.targetHumanId,
          role: input.role,
          revoked: revokeResult.revoked,
        },
        at: now,
      });

      return revokeResult.revoked;
    });

    return adminRevokeHumanRoleOutputSchema.parse({
      targetHumanId: input.targetHumanId,
      role: input.role,
      revoked,
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("adminRevokeHumanRole", execute);
  }

  return execute();
}
