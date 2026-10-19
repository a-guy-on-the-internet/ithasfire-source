import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { executeHumanDeletionTx } from "../platform/_shared/delete-human-shared";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const deleteMyAccountInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    confirmationPhrase: z.string().min(1),
    // Required only when the caller's account has a password credential
    // (step-up re-authentication before hard delete). Accounts that sign in
    // via OAuth/passkey only (no `credential` AuthAccount) proceed without
    // this field — see the hasPasswordCredential check below.
    currentPassword: z.string().optional(),
  })
  .strict();

export const deleteMyAccountOutputSchema = z
  .object({
    deleted: z.literal(true),
  })
  .strict();

export type DeleteMyAccountInput = z.infer<typeof deleteMyAccountInputSchema>;
export type DeleteMyAccountOutput = z.infer<
  typeof deleteMyAccountOutputSchema
>;

export type DeleteMyAccountDeps = {
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
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

// Self-serve hard delete — any authenticated human may delete their own
// account, gated only by the confirmation phrase (their email). No RBAC:
// authorization here is simply "you can only act on your own actorHumanId",
// enforced upstream by never letting the client supply it (see
// packages/transport/trpc/src/routers/humans.ts). No self-deletion guard
// either — self-deletion IS the point of this use case (contrast with
// admin-delete-human's CANNOT_DELETE_OWN_ACCOUNT check).
export async function deleteMyAccount(
  deps: DeleteMyAccountDeps,
  rawInput: unknown,
): Promise<DeleteMyAccountOutput> {
  const logger = deps.logger?.child({ useCase: "deleteMyAccount" });

  const execute = async () => {
    const input = parseInput(deleteMyAccountInputSchema, rawInput);

    // Verify the human exists and get identity for the confirmation check.
    const target = await deps.repos.humans.getByIdWithIdentity(
      input.actorHumanId,
    );
    if (!target) {
      throw fail("HUMAN_NOT_FOUND");
    }

    // Confirmation phrase must match the human's email (case-insensitive).
    if (
      input.confirmationPhrase.toLowerCase() !==
      target.identity.email.toLowerCase()
    ) {
      throw fail("CONFIRMATION_PHRASE_MISMATCH");
    }

    // Step-up re-authentication: accounts with a password credential must
    // re-enter it before deletion proceeds. OAuth/passkey-only accounts (no
    // `credential` AuthAccount) have no password to verify and proceed
    // unchanged with confirmation-phrase-only gating.
    const hasPassword = await deps.repos.humans.hasPasswordCredential(
      input.actorHumanId,
    );
    if (hasPassword) {
      if (!input.currentPassword) {
        throw fail("CURRENT_PASSWORD_REQUIRED");
      }
      const valid = await deps.repos.humans.verifyPassword(
        input.actorHumanId,
        input.currentPassword,
      );
      if (!valid) {
        throw fail("CURRENT_PASSWORD_INVALID");
      }
    }

    // Audit + scrub + hard-delete, shared with the staff-initiated delete flow.
    await executeHumanDeletionTx(
      { repos: deps.repos, logger },
      {
        humanId: input.actorHumanId,
        actorHumanId: input.actorHumanId,
        actorKind: "self",
        deletedEmail: target.identity.email,
        deletedName: target.human.name,
      },
    );

    return deleteMyAccountOutputSchema.parse({ deleted: true });
  };

  if (logger) {
    return logger.withTime("deleteMyAccount", execute);
  }

  return execute();
}
