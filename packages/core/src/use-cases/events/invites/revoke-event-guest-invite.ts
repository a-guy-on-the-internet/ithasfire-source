import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../../lib/io";
import { ensureActorCanEditEvent } from "../_shared/ensure-actor-can-edit-event";
import { rescindInviteApprovals } from "./rescind-invite-approvals";

const USE_CASE = "revokeEventGuestInvite";

/**
 * Revoke one PERSONAL invite and remove everyone it let in
 * (gated-event invite links FR-006, R9).
 *
 *  1. One transaction: stamp `revokedAt` (an already-revoked row keeps its
 *     first one) and revoke every EventUnlock carrying this `inviteId`. That
 *     is the whole job on a PASSWORD event. Signed-out `th_ei_` holders are
 *     cut off by the gate state's per-read `revokedAt` check.
 *     Invite-approved unlocks carry the inviteId too, so signed-in holders
 *     on an application event are removed here as well.
 *  2. Every still-APPROVED submission the invite approved goes through the
 *     EXISTING rescind path, which moves it back to PENDING and revokes its
 *     unlocks by submission. `th_ea_` grants die with the APPROVED status.
 *     This runs whatever the gate type is now (`rescindInviteApprovals`,
 *     shared with the shared link's "Reset and remove everyone").
 *
 * Idempotent. Step 2 runs one rescind per submission (each its own
 * transaction, as the rescind use case is), after step 1 has already
 * stopped new redemptions.
 *
 * Step 2 is best-effort; step 1 is what removes people. Once step 1 commits,
 * an approval step 2 never reached stops opening the gate anyway: the
 * application grant and the claim link both refuse an approval from a revoked
 * PERSONAL invite (`inviteApprovalRevoked`), and a signed-in holder's unlock
 * carries the inviteId, so step 1 already revoked it. A failed rescind is
 * therefore reported and skipped, and the loop goes on to the rest. It is
 * not rethrown: the organizer's revoked row offers "Invite again", not
 * another revoke, so a thrown error would only show a failure next to a row
 * that already reads Revoked. Stopping at MAX_RESCIND_PAGES with rows left
 * is reported too (`invite_rescind_truncated`). Revoking an already-revoked
 * invite runs step 2 again (step 1 is a no-op then), so a stranded approval
 * can be repaired by revoking again.
 *
 * Each rescind is guarded: it only lands while the row is still APPROVED and
 * still carries this invite. A decision or withdraw committing between the
 * list and the rescind wins; that row counts as moved on, not as a failure.
 *
 * Rescinding here sends no "back in review" notice: the guest never applied,
 * so that message would be wrong. The rescind deps get no notifier.
 */

export const revokeEventGuestInviteInputSchema = z
  .object({
    eventId: z.string().uuid(),
    inviteId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
  })
  .strict();

export const revokeEventGuestInviteOutputSchema = z
  .object({
    inviteId: z.string().uuid(),
    revoked: z.literal(true),
    revokedAt: z.date(),
    unlocksRevoked: z.number().int().nonnegative(),
    submissionsRescinded: z.number().int().nonnegative(),
  })
  .strict();

export type RevokeEventGuestInviteInput = z.infer<
  typeof revokeEventGuestInviteInputSchema
>;
export type RevokeEventGuestInviteOutput = z.infer<
  typeof revokeEventGuestInviteOutputSchema
>;

export type RevokeEventGuestInviteDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

export async function revokeEventGuestInvite(
  deps: RevokeEventGuestInviteDeps,
  rawInput: unknown,
): Promise<RevokeEventGuestInviteOutput> {
  const input = parseInput(revokeEventGuestInviteInputSchema, rawInput);
  const event = await ensureActorCanEditEvent(
    deps.repos,
    input.eventId,
    input.actorHumanId,
  );

  const invite = await deps.repos.eventInvites.getById(input.inviteId);
  if (!invite || invite.eventId !== event.id || invite.kind !== "PERSONAL") {
    throw fail("MAGIC_LINK_NOT_FOUND");
  }

  const now = deps.clock.now();
  const { revokedAt, unlocksRevoked } = await deps.repos.tx(async (tx) => {
    const row = await tx.eventInvites.revoke(invite.id, now);
    if (!row) throw fail("MAGIC_LINK_NOT_FOUND");
    const count = await tx.eventUnlocks.revokeByInvite(invite.id, now);
    await tx.audit.log({
      entity: "event",
      entityId: event.id,
      action: "event_guest_invite_revoked",
      data: {
        actorHumanId: input.actorHumanId,
        inviteId: invite.id,
        alreadyRevoked: invite.revokedAt !== null,
        unlocksRevoked: count,
      },
      at: now,
    });
    return { revokedAt: row.revokedAt ?? now, unlocksRevoked: count };
  });

  // Phase 2 (shared with RESET_AND_REMOVE): rescind every approval this
  // invite gave, whatever the gate type is now. Best-effort and reported;
  // phase 1 above already removed everyone (see the header).
  const { submissionsRescinded } = await rescindInviteApprovals(deps, {
    eventId: event.id,
    inviteId: invite.id,
    actorHumanId: input.actorHumanId,
    useCase: USE_CASE,
    auditData: { viaInviteRevoke: invite.id },
  });

  deps.logger?.info("event_gate", {
    category: "event_gate",
    eventId: event.id,
    action: "guest_invite_revoked",
    result: "success",
    actorHumanId: input.actorHumanId,
    metadata: { inviteId: invite.id, unlocksRevoked, submissionsRescinded },
  });

  return revokeEventGuestInviteOutputSchema.parse({
    inviteId: invite.id,
    revoked: true,
    revokedAt,
    unlocksRevoked,
    submissionsRescinded,
  });
}
