import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const adminUnlinkAuthAccountInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    humanId: z.string().uuid(),
    providerId: z.string().min(1),
  })
  .strict();

export const adminUnlinkAuthAccountOutputSchema = z
  .object({
    humanId: z.string().uuid(),
    unlinkedProviderId: z.string(),
    sessionsInvalidated: z.number().int(),
  })
  .strict();

export type AdminUnlinkAuthAccountInput = z.infer<
  typeof adminUnlinkAuthAccountInputSchema
>;
export type AdminUnlinkAuthAccountOutput = z.infer<
  typeof adminUnlinkAuthAccountOutputSchema
>;

export type AdminUnlinkAuthAccountDeps = {
  repos: Pick<Repos, "humans" | "audit" | "tx">;
  authz: AuthZPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function adminUnlinkAuthAccount(
  deps: AdminUnlinkAuthAccountDeps,
  rawInput: unknown,
): Promise<AdminUnlinkAuthAccountOutput> {
  const logger = deps.logger?.child({ useCase: "adminUnlinkAuthAccount" });

  const execute = async () => {
    const input = parseInput(adminUnlinkAuthAccountInputSchema, rawInput);

    // RBAC: ADMIN only
    const check = await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: ["ADMIN"],
    });
    if (!check.allowed) {
      throw fail("STAFF_ONLY");
    }

    // Verify target exists
    const target = await deps.repos.humans.getByIdWithIdentity(input.humanId);
    if (!target) {
      throw fail("HUMAN_NOT_FOUND");
    }

    // Wrap mutation + audit in a single transaction
    const result = await deps.repos.tx(async (tx) => {
      // A two-factor account must keep a password or a passkey. Removing the
      // password from one that has no passkey leaves a Google / Apple sign-in
      // as its only way in, and that sign-in cannot be asked for the second
      // factor (apps/api/src/auth/second-factor-bypass.ts,
      // `providerIsOnlyWayIn`). Turn two-factor off first, or have the human
      // add a passkey.
      if (input.providerId === "credential") {
        const footprint = await tx.humans.getSignInFootprint(input.humanId);
        if (footprint?.twoFactorEnabled && footprint.passkeys === 0) {
          throw fail("CONFLICT", {
            message: "two_factor_needs_password_or_passkey",
          });
        }
      }

      // Unlink the auth account (adapter guards against removing the last one)
      await tx.humans.unlinkAuthAccount({
        humanId: input.humanId,
        providerId: input.providerId,
      });

      // Force re-auth by invalidating all sessions
      const sessionResult = await tx.humans.invalidateAllSessions(
        input.humanId,
      );

      // Audit log
      await tx.audit.log({
        entity: "Human",
        entityId: input.humanId,
        action: "admin.unlinkAuthAccount",
        data: {
          actorHumanId: input.actorHumanId,
          providerId: input.providerId,
          sessionsInvalidated: sessionResult.count,
        },
      });

      return { sessionsInvalidated: sessionResult.count };
    });

    return adminUnlinkAuthAccountOutputSchema.parse({
      humanId: input.humanId,
      unlinkedProviderId: input.providerId,
      sessionsInvalidated: result.sessionsInvalidated,
    });
  };

  if (logger) {
    return logger.withTime("adminUnlinkAuthAccount", execute);
  }

  return execute();
}
