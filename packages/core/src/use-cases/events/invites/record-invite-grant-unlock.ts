import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../../lib/io";
import { inviteGrantHolds, inviteGrantSchema } from "./invite-grant";
import {
  grantInviteToSignedInViewer,
  isInviteRevokedDuringGrant,
} from "./redeem-event-invite";

/**
 * Turns a verified invite grant cookie (`th_ei_<eventId>`) into the durable
 * grant a SIGNED-IN viewer would have got by redeeming the link while signed
 * in (gated-event invite links R3, orchestrator ruling 2026-10-05). The
 * invite twin of `recordApplicationGrantUnlock`.
 *
 * Why this exists: checkout is signed-in only, and the buyer's API calls
 * never carry the web-host cookie. The web syncs the grant first
 * (`sync-unlock` → `events.recordSignedInviteUnlock` → here) and the orders
 * router does the same on a shared host, so `ensureEventAccessible` finds a
 * durable row.
 *
 * The authority is the cookie, not the token, so the cookie's rule applies
 * (`inviteGrantHolds`): a SHARED invite counts even after a reset or turn
 * off (R5, R14) until "Reset and remove everyone" (`grantsRevokedAt`), a
 * PERSONAL one only while unrevoked (FR-006), and neither once the event has
 * ended or was cancelled (FR-008). A draft or archived
 * event converts nothing either, as redeem refuses those (EVENT_UNAVAILABLE).
 *
 * Then exactly the signed-in redeem path (`grantInviteToSignedInViewer`):
 * PASSWORD → EventUnlock (MAGIC_LINK, inviteId); APPLICATION → the viewer's
 * open ATTEND submission approved, or a new APPROVED one carrying inviteId.
 * A live unlock the viewer already holds is never written over. A SHARED
 * conversion is not counted again (the cookie's redeem was); see
 * `SignedInInviteGrantMode` for why a PERSONAL one still takes the count.
 *
 * Denials are an OUTCOME, not an error: checkout's own gate refuses cleanly
 * when no row exists, and the orders-router caller needs no catch.
 */

export const recordInviteGrantUnlockInputSchema = z
  .object({
    eventId: z.string().uuid(),
    viewerHumanId: z.string().uuid(),
    /** From the HMAC-verified `th_ei_` cookie: server-injected, never client input. */
    inviteGrant: inviteGrantSchema,
  })
  .strict();

export const recordInviteGrantUnlockOutcomeSchema = z.enum([
  /** A new durable grant was written. */
  "persisted",
  /** The viewer already held a live unlock; nothing was written. */
  "already_unlocked",
  /** The grant no longer opens this event (or names another event's invite). */
  "grant_invalid",
  /**
   * A PERSONAL invite was revoked, or a SHARED one's grants removed, while
   * this ran.
   */
  "revoked",
]);

export const recordInviteGrantUnlockOutputSchema = z
  .object({
    eventId: z.string().uuid(),
    /** True when the viewer holds a live durable grant after the call. */
    persisted: z.boolean(),
    outcome: recordInviteGrantUnlockOutcomeSchema,
    /** APPLICATION events: the approved submission, when known. */
    submissionId: z.string().uuid().nullable(),
  })
  .strict();

export type RecordInviteGrantUnlockInput = z.infer<
  typeof recordInviteGrantUnlockInputSchema
>;
export type RecordInviteGrantUnlockOutput = z.infer<
  typeof recordInviteGrantUnlockOutputSchema
>;

export type RecordInviteGrantUnlockDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function recordInviteGrantUnlock(
  deps: RecordInviteGrantUnlockDeps,
  rawInput: unknown,
): Promise<RecordInviteGrantUnlockOutput> {
  const input = parseInput(recordInviteGrantUnlockInputSchema, rawInput);
  const now = deps.clock.now();

  const result = (
    outcome: RecordInviteGrantUnlockOutput["outcome"],
    submissionId: string | null = null,
  ): RecordInviteGrantUnlockOutput => {
    deps.logger?.info("event_gate", {
      category: "event_gate",
      eventId: input.eventId,
      action: "invite_grant_convert",
      result: outcome,
      viewerHumanId: input.viewerHumanId,
      metadata: { inviteId: input.inviteGrant.inviteId },
    });
    return recordInviteGrantUnlockOutputSchema.parse({
      eventId: input.eventId,
      persisted: outcome === "persisted" || outcome === "already_unlocked",
      outcome,
      submissionId,
    });
  };

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) return result("grant_invalid");
  if (event.status === "DRAFT" || event.status === "ARCHIVED") {
    return result("grant_invalid");
  }
  if (
    !(await inviteGrantHolds(deps.repos.eventInvites, event, input.inviteGrant, now))
  ) {
    return result("grant_invalid");
  }
  // inviteGrantHolds just read it; re-read for the full row (kind, email).
  const invite = await deps.repos.eventInvites.getById(input.inviteGrant.inviteId);
  if (!invite || invite.eventId !== event.id) return result("grant_invalid");

  try {
    const granted = await grantInviteToSignedInViewer(deps, {
      invite,
      event,
      viewer: input.viewerHumanId,
      now,
      mode: "CONVERT",
    });
    return result(
      granted.created ? "persisted" : "already_unlocked",
      granted.submission?.id ?? null,
    );
  } catch (error) {
    if (isInviteRevokedDuringGrant(error)) return result("revoked");
    throw error;
  }
}
