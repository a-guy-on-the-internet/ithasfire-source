import { z } from "zod";

import { authZRoleSchema } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import {
  delegateInviteNonceKey,
  verifyDelegateInviteForActor,
} from "./accept-delegate-invite";

export const previewDelegateInviteInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    token: z.string().min(1).max(2048),
  })
  .strict();

export const previewDelegateInviteOutputSchema = z
  .object({
    principalName: z.string().nullable(),
    role: authZRoleSchema,
  })
  .strict();

export type PreviewDelegateInviteInput = z.infer<
  typeof previewDelegateInviteInputSchema
>;
export type PreviewDelegateInviteOutput = z.infer<
  typeof previewDelegateInviteOutputSchema
>;

export type PreviewDelegateInviteDeps = {
  repos: Pick<Repos, "humans">;
  clock: ClockPort;
  idempotency: Pick<IdempotencyPort, "get" | "status">;
  inviteSecret: string | null;
};

/**
 * Read-only look at a delegate link so the accept page can say WHO is asking
 * and for WHICH role before the invitee presses Accept. Runs the same checks
 * as `acceptDelegateInvite` (signature, expiry, signed-in email matches and is
 * verified, not self) plus "not already used", and claims nothing. The
 * principal's name is only returned to the account the link was made for.
 */
export async function previewDelegateInvite(
  deps: PreviewDelegateInviteDeps,
  rawInput: unknown,
): Promise<PreviewDelegateInviteOutput> {
  const input = parseInput(previewDelegateInviteInputSchema, rawInput);
  const { payload, role } = await verifyDelegateInviteForActor(
    deps,
    input.actorHumanId,
    input.token,
  );

  // "Used" = committed OR an in-progress claim. `acceptDelegateInvite` holds
  // the claim for the token's whole life, so an in-progress record means a
  // grant happened (or is happening) and accept would refuse too — the
  // preview must agree. `get` only sees committed records; `status` (when the
  // adapter has it) also sees the claim, without taking it.
  const nonceKey = delegateInviteNonceKey(payload.nonce);
  let used: boolean;
  if (deps.idempotency.status) {
    const state = await deps.idempotency.status(nonceKey);
    used = state === "in_progress" || state === "succeeded";
  } else {
    used = Boolean(await deps.idempotency.get(nonceKey));
  }
  if (used) {
    throw fail("INVITATION_NOT_PENDING", {
      message: "This invitation has already been accepted.",
      meta: { status: "ACCEPTED" },
    });
  }

  const principal = await deps.repos.humans.getById(payload.principalId);
  if (!principal) {
    throw fail("HUMAN_NOT_FOUND");
  }

  return previewDelegateInviteOutputSchema.parse({
    principalName: principal.name,
    role,
  });
}
