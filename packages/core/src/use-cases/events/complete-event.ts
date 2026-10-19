import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { callOffRemainingDates } from "../community/_shared/call-off-remaining-dates";
import { appendBookingEventCompletedEntry } from "./_shared/booking-event-ledger";
import {
  requireOrgMembership,
  requirePlatformStaff,
  ORG_ADMIN_ROLES,
} from "../../lib/rbac";
import { fail } from "@th/errors";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";

export const completeEventInputSchema = z.object({
  actorHumanId: z.uuid(),
  eventId: z.uuid(),
});

export const completeEventOutputSchema = z.object({
  eventId: z.uuid(),
  status: z.literal("COMPLETED"),
});

export type CompleteEventInput = z.infer<typeof completeEventInputSchema>;
export type CompleteEventOutput = z.infer<typeof completeEventOutputSchema>;

export type CompleteEventDeps = {
  repos: Repos;
  /** Needed for the platform-ADMIN override that may act on ANY event. */
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Moves a PUBLISHED event to COMPLETED — the terminal "this already happened"
 * state used to retire finished events from public discovery surfaces without
 * cancelling/refunding anyone.
 *
 * **Access:** the event owner (org admin / personal owner) OR a platform ADMIN.
 * The platform ADMIN override applies to ANY event (owned or ownerless
 * COMMUNITY); admin-path completions are audited via `via: "platform_admin"`.
 *
 * **Guards:** only PUBLISHED events are completable. An already-COMPLETED event
 * throws `EVENT_ALREADY_COMPLETED`; any other non-PUBLISHED status throws
 * `EVENT_NOT_COMPLETABLE`. There is no date guard — the caller decides when a
 * run is finished.
 *
 * **Remaining nights (COMMUNITY):** a recurring community listing completed
 * before its last night calls off every night still ahead and tells each
 * per-night RSVPer once (`callOffRemainingDates`), as cancel and archive do
 * (owner ruling 2026-10-16). Past nights stay as history. OWNED events keep
 * their dates as they are.
 *
 * **Booking timeline:** an event finalized from a booking agreement also
 * logs `booking_event.completed` on its thread and moves the ACCEPTED
 * agreement to FULFILLED (guarded CAS). If that agreement moved concurrently
 * the CAS throws `conflict` and the WHOLE completion rolls back — deliberate:
 * the caller re-reads and retries rather than committing a COMPLETED event
 * whose ledger contradicts its agreement.
 */
export async function completeEvent(
  deps: CompleteEventDeps,
  rawInput: unknown,
): Promise<CompleteEventOutput> {
  const input = parseInput(completeEventInputSchema, rawInput);

  const { event, via } = await ensureEventAccessible(
    deps,
    input.eventId,
    input.actorHumanId,
  );
  ensureEventCompletable(event);

  const result = await deps.repos.tx(async (tx) => {
    // The event row FOR UPDATE, re-read and re-checked under it: a second
    // completion racing this one waits, then refuses with
    // EVENT_ALREADY_COMPLETED, so the remaining nights are called off (and
    // their people told) by one transaction. Stewardship is read from here.
    await tx.events.lockRows({ ids: [event.id], mode: "update" });
    const current = await tx.events.getById(event.id);
    if (!current) throw fail("EVENT_NOT_FOUND");
    ensureEventCompletable(current);

    const now = deps.clock.now();

    const completed = await tx.events.complete({ eventId: event.id });

    // Booking timeline: a show minted from an agreement logs "completed" on
    // its booking thread, and its ACCEPTED agreement becomes FULFILLED (this
    // is the only writer of that status — see the emitter's doc for why
    // "the event happened" is the trigger). Silent for every other event.
    await appendBookingEventCompletedEntry(tx, {
      eventId: event.id,
      actorHumanId: input.actorHumanId,
      now,
    });

    // A recurring COMMUNITY listing completed with nights still ahead (owner
    // ruling 2026-10-16, Q5): those nights are called off in this tx and each
    // per-night RSVPer gets ONE DATE_CANCELLED notice, as cancel and archive
    // do. No skip: complete writes no event-level change notice, so the
    // per-night notice is the only message those people get. OWNED events
    // are not touched.
    const communityCallOff =
      current.stewardship === "COMMUNITY"
        ? await callOffRemainingDates(tx, { eventId: event.id, now })
        : null;

    await tx.audit.log({
      entity: "event",
      entityId: event.id,
      action: "completed",
      data: {
        actorHumanId: input.actorHumanId,
        // Admin-override attribution: platform-admin mutations MUST be traceable
        // back to the operator (mirrors cancel-event's takedown precedent).
        ...(via === "platform_admin" ? { via } : {}),
        // Server-side only: `notifiedCount` is a going-count (FR-004).
        ...(communityCallOff
          ? {
              datesCalledOff: communityCallOff.datesCalledOff,
              notifiedCount: communityCallOff.notifiedCount,
            }
          : {}),
      },
      at: now,
    });

    return completeEventOutputSchema.parse({
      eventId: completed.id,
      status: "COMPLETED",
    });
  });

  deps.logger?.info("Event completed", {
    eventId: input.eventId,
    actorHumanId: input.actorHumanId,
    via,
  });

  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type EventAccessVia = "owner" | "platform_admin";

/**
 * Owner-or-platform-ADMIN access check for lifecycle transitions. A platform
 * ADMIN may act on ANY event (owned or ownerless COMMUNITY) — checked first so
 * the override works even when the admin isn't an org member. Otherwise the
 * normal owner rules apply: org events need ORG_ADMIN_ROLES membership;
 * personal events need the humanId owner or an OWNER/ADMIN delegate of them;
 * ownerless COMMUNITY rows require a
 * platform ADMIN. Callers must audit `via === "platform_admin"`.
 */
async function ensureEventAccessible(
  deps: Pick<CompleteEventDeps, "repos" | "authz">,
  eventId: string,
  actorHumanId: string,
): Promise<{ event: EventRecord; via: EventAccessVia }> {
  const event = await deps.repos.events.getById(eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  // Platform-ADMIN override: may act on ANY event, including OWNED ones.
  const staff = await deps.authz.hasStaffRole({
    actorHumanId,
    requiredRoles: ["ADMIN"],
  });
  if (staff.allowed) {
    return { event, via: "platform_admin" };
  }

  if (event.orgId) {
    await requireOrgMembership({
      repos: deps.repos,
      orgId: event.orgId,
      actorHumanId,
      roles: ORG_ADMIN_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
    return { event, via: "owner" };
  }

  if (event.humanId) {
    // The owner, or an OWNER/ADMIN delegate — the same role set the org arm
    // asks (see `lib/event-edit-rights.ts`).
    await ensureActorHoldsHumanEventRole(
      deps.repos.authz,
      event.humanId,
      actorHumanId,
      ORG_ADMIN_ROLES,
    );
    return { event, via: "owner" };
  }

  // Ownerless row: only COMMUNITY listings are legitimately ownerless, and only
  // platform ADMIN may act on one. requirePlatformStaff throws STAFF_ONLY for
  // everyone else (incl. COMMUNITY_MODERATORs).
  if (event.stewardship === "COMMUNITY") {
    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId,
      roles: ["ADMIN"],
    });
    return { event, via: "platform_admin" };
  }

  // Orphaned OWNED row (e.g. deleted human) — nobody can act through this path.
  throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "event" } });
}

function ensureEventCompletable(event: EventRecord): void {
  if (event.status === "COMPLETED") {
    throw fail("EVENT_ALREADY_COMPLETED");
  }

  if (event.status !== "PUBLISHED") {
    throw fail("EVENT_NOT_COMPLETABLE");
  }
}
