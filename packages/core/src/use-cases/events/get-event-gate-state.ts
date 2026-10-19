import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  EventGateType,
  EventVisibility,
  WaitlistStatus,
} from "@th/ports/repos/events";
import {
  eventGateTypeSchema,
  eventVisibilitySchema,
  waitlistStatusSchema,
} from "@th/schema";

import { parseInput } from "../../lib/io";
import { isEventPasswordSet } from "../../lib/security/event-password";
import {
  applicationGrantSchema,
  loadApprovedApplicationGrantSubmission,
} from "./_shared/application-gate-grant";
import { canViewerBypassEventGate } from "./_shared/ensure-actor-can-edit-event";
import {
  canViewerReadEvent,
  type EventStaffReadProbe,
} from "./_shared/event-public-readability";
import {
  inviteGrantHolds,
  inviteGrantSchema,
  removedByInviteReset,
} from "./invites/invite-grant";
import { computeWaitlistState } from "./_shared/waitlist-state";
import { fail } from "@th/errors";

export const getEventGateStateInputSchema = z
  .object({
    eventId: z.uuid(),
    viewerHumanId: z.string().uuid().nullable().optional(),
    /**
     * SERVER-INJECTED, never client-suppliable (the transport omits it from
     * its public input): the `{ submissionId, approvedAtMs }` carried by the
     * HMAC-verified application grant cookie (`th_ea_<eventId>`). It counts
     * only while that submission is APPROVED for this APPLICATION-gated event
     * under the same approval — see `_shared/application-gate-grant.ts`.
     */
    applicationGrant: applicationGrantSchema.nullable().optional(),
    /**
     * SERVER-INJECTED, never client-suppliable: the `{ inviteId, expMs }`
     * carried by the HMAC-verified invite grant cookie (`th_ei_<eventId>`).
     * See `invites/invite-grant.ts` for when it counts.
     */
    inviteGrant: inviteGrantSchema.nullable().optional(),
    /**
     * SERVER-INJECTED, never client-suppliable: compute
     * `viewerRemovedByInviteReset` (up to two extra point reads). Only the
     * `getGateState` procedure, whose answer the gated page shows, asks for
     * it; access checks leave it off and always get `false`.
     */
    explainRemoval: z.boolean().optional(),
  })
  .strict();

export const getEventGateStateOutputSchema = z.object({
  eventId: z.uuid(),
  visibility: eventVisibilitySchema,
  gateType: eventGateTypeSchema,
  passwordRequired: z.boolean(),
  passwordSet: z.boolean(),
  applicationRequired: z.boolean(),
  waitlistStatus: waitlistStatusSchema,
  waitlistOpen: z.boolean(),
  waitlistOpensAt: z.date().nullable(),
  waitlistDescription: z.string().nullable(),
  waitlistCap: z.number().int().nullable(),
  viewerCanBypass: z.boolean(),
  /** True if the viewer has an active (non-revoked, non-expired) unlock for this event */
  viewerIsUnlocked: z.boolean(),
  /**
   * True when it is the viewer's application grant cookie (not a durable
   * unlock, not a bypass) that lets them through an APPLICATION gate. Only
   * evaluated when nothing else already does, so it is `false` for a viewer
   * who is unlocked or can bypass. Already folded into `applicationRequired`;
   * exposed separately because the web checkout must sync it into a durable
   * unlock (subject only) before the buyer's own API calls, which cannot
   * carry the web-host cookie.
   */
  viewerHasApplicationGrant: z.boolean(),
  /**
   * True when it is the viewer's invite grant cookie (gated-event invite
   * links) that lets them through a PASSWORD or APPLICATION gate. Like
   * `viewerHasApplicationGrant`, only evaluated when nothing else already
   * opens the gate, and already folded into `passwordRequired` /
   * `applicationRequired`.
   */
  viewerHasInviteGrant: z.boolean(),
  /**
   * True only when the input asked for it (`explainRemoval`), the gate is
   * shut for this viewer (`passwordRequired || applicationRequired`), AND
   * what used to let them in was ended by the organiser's "Reset and remove
   * everyone": their own signed `th_ei_` grant or their own revoked unlock
   * names a SHARED invite of this event whose grants that action ended.
   * Lets the gate say why. Never true for a plain reset, an ended or
   * cancelled event, or a viewer who never held access. See
   * `invites/invite-grant.ts`.
   */
  viewerRemovedByInviteReset: z.boolean(),
});

export type GetEventGateStateInput = z.infer<
  typeof getEventGateStateInputSchema
>;
export type GetEventGateStateOutput = z.infer<
  typeof getEventGateStateOutputSchema
>;

export type GetEventGateStateDeps = {
  repos: Pick<Repos, "events" | "authz" | "eventUnlocks" | "eventApplications"> &
    Partial<Pick<Repos, "tickets">> &
    Pick<Repos, "eventInvites">;
  /**
   * The staff probe behind a community moderator's read of a hidden
   * COMMUNITY listing.
   */
  authz: EventStaffReadProbe;
  clock: ClockPort;
  logger?: LoggerPort;
  /** A failed `viewerRemovedByInviteReset` lookup is swallowed and reported. */
  reportError?: ReporterPort;
};

export async function getEventGateState(
  deps: GetEventGateStateDeps,
  rawInput: unknown,
): Promise<GetEventGateStateOutput> {
  const input = parseInput(getEventGateStateInputSchema, rawInput);
  const event = await deps.repos.events.getById(input.eventId, {
    withOwnerStanding: true,
  });
  // N3 (`event-public-readability`): an event the viewer may not read — a
  // DRAFT, or cancelled / archived without ever going live, to anyone who
  // cannot edit it — answers exactly like an id that does not exist. This is
  // also the gate every id-keyed public read goes through
  // (`ensureFullEventReadAccessByEventId`: ticket types, fee rates, tax
  // estimate, seat availability, audio, suggestion base), so none of them can
  // answer a hidden event's id with its gate state or its data.
  if (
    !event ||
    !(await canViewerReadEvent(
      deps.repos.authz,
      event,
      input.viewerHumanId,
      deps.repos.tickets,
      deps.authz,
    ))
  ) {
    throw fail("EVENT_NOT_FOUND");
  }

  const viewerCanBypass = await canViewerBypassEventGate(
    deps.repos.authz,
    event,
    input.viewerHumanId ?? null,
  );

  // Check if the viewer has an active unlock (only if gated and we have a humanId).
  // NOTE: `EventUnlock` is gate-agnostic — `isUnlocked` does not check `source`,
  // so a PASSWORD-source grant lifts an APPLICATION gate and vice-versa. This is
  // deliberate (an unlock is an unlock). A consequence: switching an event's
  // gateType does NOT evict existing grants — rescind (revokeBySubmission),
  // guest invite revoke and "Reset and remove everyone" (revokeByInvite) are the
  // eviction paths; a password change revokes nothing.
  let viewerIsUnlocked = false;
  if (event.gateType !== "NONE" && input.viewerHumanId) {
    viewerIsUnlocked = await deps.repos.eventUnlocks.isUnlocked(
      event.id,
      input.viewerHumanId,
    );
  }

  const passwordSet = isEventPasswordSet(event.passwordHash);
  // Anonymous (or not-yet-synced) approved applicants: the application grant.
  // Looked up only when nothing else already opens the gate, so the common
  // paths cost no extra read. Re-checked against the submission on EVERY
  // call — that is the revocation mechanism.
  const viewerHasApplicationGrant =
    event.gateType === "APPLICATION" &&
    !viewerCanBypass &&
    !viewerIsUnlocked &&
    (await loadApprovedApplicationGrantSubmission(
      deps.repos,
      event,
      input.applicationGrant,
    )) !== null;

  // Signed-out invite link holders: the invite grant. Same shape as the
  // application grant: looked up only when nothing else opens the gate, and
  // re-checked on every call (PERSONAL revoke, event end, cancellation).
  const viewerHasInviteGrant =
    !viewerCanBypass &&
    !viewerIsUnlocked &&
    !viewerHasApplicationGrant &&
    (await inviteGrantHolds(
      deps.repos.eventInvites,
      event,
      input.inviteGrant,
      deps.clock.now(),
    ));

  // Password is only "required" if gated, password set, and viewer hasn't already unlocked/bypassed
  const passwordRequired =
    event.gateType === "PASSWORD" &&
    passwordSet &&
    !viewerCanBypass &&
    !viewerIsUnlocked &&
    !viewerHasInviteGrant;

  // Application is only "required" if gated and viewer hasn't already been approved/bypassed
  const applicationRequired =
    event.gateType === "APPLICATION" &&
    !viewerCanBypass &&
    !viewerIsUnlocked &&
    !viewerHasApplicationGrant &&
    !viewerHasInviteGrant;
  // Why the gate is shut, for a viewer the organiser's "Reset and remove
  // everyone" removed. Asked only when the caller wants the explanation
  // (`explainRemoval`) AND the gate is actually shut for this viewer: the
  // *Required flags already fold in bypass, unlock and both grants, and a
  // PASSWORD gate with no password set is not shut. An explanation, never
  // an access decision: a failed lookup reads as "no reason" and is
  // reported, so it can't turn a gate read into an error.
  let viewerRemovedByInviteReset = false;
  if (
    input.explainRemoval === true &&
    (passwordRequired || applicationRequired) &&
    (input.inviteGrant || input.viewerHumanId)
  ) {
    try {
      viewerRemovedByInviteReset = await removedByInviteReset(
        deps.repos,
        event,
        { grant: input.inviteGrant, humanId: input.viewerHumanId },
        deps.clock.now(),
      );
    } catch (err) {
      deps.logger?.error("events.getEventGateState.removed_reason_failed", {
        eventId: event.id,
        err,
      });
      try {
        deps.reportError?.(err, {
          tags: {
            useCase: "getEventGateState",
            channel: "removed_by_invite_reset_lookup_failed",
          },
          extra: { eventId: event.id },
        });
      } catch {
        // Reporting is best-effort.
      }
    }
  }

  const waitlistState = computeWaitlistState(
    event.waitlistStatus,
    event.waitlistPublishAt,
    deps.clock.now(),
  );

  return getEventGateStateOutputSchema.parse({
    eventId: event.id,
    visibility: event.visibility as EventVisibility,
    gateType: event.gateType as EventGateType,
    passwordRequired,
    passwordSet,
    applicationRequired,
    waitlistStatus: event.waitlistStatus as WaitlistStatus,
    waitlistOpen: waitlistState.open,
    waitlistOpensAt: waitlistState.opensAt,
    waitlistDescription: event.waitlistDescription ?? null,
    waitlistCap: event.waitlistCap ?? null,
    viewerCanBypass,
    viewerIsUnlocked,
    viewerHasApplicationGrant,
    viewerHasInviteGrant,
    viewerRemovedByInviteReset,
  });
}
