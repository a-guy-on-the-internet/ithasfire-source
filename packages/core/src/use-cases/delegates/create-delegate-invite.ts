import { z } from "zod";

import { authZRoleSchema } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import {
  isUsableDelegateInviteSecret,
  newDelegateInviteNonce,
  signDelegateInviteToken,
} from "../../lib/delegate-invite-token";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/** OWNER is excluded — only the principal "owns" their account. */
const delegateRoleSchema = authZRoleSchema.exclude(["OWNER"]);

export const DELEGATE_INVITE_TTL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export const createDelegateInviteInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    principalId: z.string().uuid(),
    email: z.string().trim().max(254).email().toLowerCase(),
    role: delegateRoleSchema,
  })
  .strict();

export const createDelegateInviteOutputSchema = z
  .object({
    /** Opaque signed token; the client builds `/delegate/accept?token=…`. */
    token: z.string(),
    expiresAt: z.date(),
  })
  .strict();

export type CreateDelegateInviteInput = z.infer<
  typeof createDelegateInviteInputSchema
>;
export type CreateDelegateInviteOutput = z.infer<
  typeof createDelegateInviteOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type CreateDelegateInviteDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Server secret the invite is signed with; null → NOT_CONFIGURED. */
  inviteSecret: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mint a delegate invitation link. Replaces the old `addHumanDelegate`, which
 * granted a delegation to any humanId with no consent — and let the principal
 * read the target's email back from `listDelegates` (security review F3).
 *
 * Nothing is written to `HumanDelegate` here. The principal shares the link;
 * the invited person accepts it (`acceptDelegateInvite`) while signed in with
 * the invited email, and only then does the delegation exist.
 *
 * The response is identical whether or not the email has an account — it is
 * never looked up — so this is not an existence oracle, and no email is sent
 * (so it can't be used as a mail relay either).
 *
 * KNOWN LIMITATION — an unused link cannot be revoked. Links are stateless
 * (signed, nothing stored until accepted), so there is no row to cancel and
 * no pending list to show. Mitigations: the link only works for the invited
 * email (verified), works once, and expires after DELEGATE_INVITE_TTL_DAYS;
 * a grant made by mistake is undone with `removeDelegate`. Real revocation
 * needs a pending-invite table (a migration) — deliberately not built yet.
 */
export async function createDelegateInvite(
  deps: CreateDelegateInviteDeps,
  rawInput: unknown,
): Promise<CreateDelegateInviteOutput> {
  const input = parseInput(createDelegateInviteInputSchema, rawInput);

  // Only the principal can invite delegates to their own account.
  if (input.actorHumanId !== input.principalId) {
    throw fail("INSUFFICIENT_ROLE", { meta: { action: "add" } });
  }

  if (!isUsableDelegateInviteSecret(deps.inviteSecret)) {
    throw fail("NOT_CONFIGURED", {
      message: "Delegate invitations are not configured.",
    });
  }

  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + DELEGATE_INVITE_TTL_DAYS * DAY_MS);

  const token = signDelegateInviteToken(deps.inviteSecret, {
    principalId: input.principalId,
    email: input.email,
    role: input.role,
    exp: expiresAt.getTime(),
    nonce: newDelegateInviteNonce(),
  });

  await deps.repos.tx(async (tx) => {
    await tx.audit.log({
      entity: "human",
      entityId: input.principalId,
      action: "human.delegate_invite_created",
      data: {
        actorHumanId: input.actorHumanId,
        email: input.email,
        role: input.role,
        expiresAt: expiresAt.toISOString(),
      },
      at: now,
    });
  });

  deps.logger?.info("delegates.invite_created", {
    principalId: input.principalId,
    role: input.role,
  });

  return createDelegateInviteOutputSchema.parse({ token, expiresAt });
}
