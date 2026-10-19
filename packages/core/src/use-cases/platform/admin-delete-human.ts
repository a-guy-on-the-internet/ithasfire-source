import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { executeHumanDeletionTx } from "./_shared/delete-human-shared";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const adminDeleteHumanInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    humanId: z.string().uuid(),
    confirmationPhrase: z.string().min(1),
  })
  .strict();

export const adminDeleteHumanOutputSchema = z
  .object({
    deleted: z.literal(true),
    humanId: z.string().uuid(),
  })
  .strict();

export type AdminDeleteHumanInput = z.infer<typeof adminDeleteHumanInputSchema>;
export type AdminDeleteHumanOutput = z.infer<
  typeof adminDeleteHumanOutputSchema
>;

export type AdminDeleteHumanDeps = {
  repos: Pick<
    Repos,
    | "humans"
    | "audit"
    | "tx"
    | "supportThreads"
    | "organizations"
    | "entityPages"
    | "pendingObjectDeletions"
    | "resourceQuotas"
    | "savedSnippets"
  >;
  authz: AuthZPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function adminDeleteHuman(
  deps: AdminDeleteHumanDeps,
  rawInput: unknown,
): Promise<AdminDeleteHumanOutput> {
  const logger = deps.logger?.child({ useCase: "adminDeleteHuman" });

  const execute = async () => {
    const input = parseInput(adminDeleteHumanInputSchema, rawInput);

    // RBAC: ADMIN only
    const check = await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: ["ADMIN"],
    });
    if (!check.allowed) {
      throw fail("STAFF_ONLY");
    }

    // Prevent self-deletion
    if (input.actorHumanId === input.humanId) {
      throw fail("CANNOT_DELETE_OWN_ACCOUNT");
    }

    // Verify target exists and get identity for confirmation check
    const target = await deps.repos.humans.getByIdWithIdentity(input.humanId);
    if (!target) {
      throw fail("HUMAN_NOT_FOUND");
    }

    // Confirmation phrase must match the human's email (case-insensitive)
    if (
      input.confirmationPhrase.toLowerCase() !==
      target.identity.email.toLowerCase()
    ) {
      throw fail("CONFIRMATION_PHRASE_MISMATCH");
    }

    // Audit + scrub + hard-delete, shared with the self-serve delete flow.
    await executeHumanDeletionTx(
      { repos: deps.repos, logger },
      {
        humanId: input.humanId,
        actorHumanId: input.actorHumanId,
        actorKind: "staff",
        deletedEmail: target.identity.email,
        deletedName: target.human.name,
      },
    );

    return adminDeleteHumanOutputSchema.parse({
      deleted: true,
      humanId: input.humanId,
    });
  };

  if (logger) {
    return logger.withTime("adminDeleteHuman", execute);
  }

  return execute();
}
