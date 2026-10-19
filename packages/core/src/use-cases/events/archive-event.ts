import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import {
  requireOrgMembership,
  requirePlatformStaff,
  ORG_ADMIN_ROLES,
} from "../../lib/rbac";
import { fail } from "@th/errors";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";
import { callOffRemainingDates } from "../community/_shared/call-off-remaining-dates";

export const archiveEventInputSchema = z.object({
  actorHumanId: z.uuid(),
  eventId: z.uuid(),
});

export const archiveEventOutputSchema = z.object({
  eventId: z.uuid(),
  status: z.literal("ARCHIVED"),
});

export type ArchiveEventInput = z.infer<typeof archiveEventInputSchema>;
export type ArchiveEventOutput = z.infer<typeof archiveEventOutputSchema>;

export type ArchiveEventDeps = {
  repos: Repos;
  /** Needed for the platform-ADMIN override that may act on ANY event. */
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Moves an event to ARCHIVED — the terminal "put this away" state that hides
 * it from all public + owner-facing listing surfaces without cancelling or
 * refunding anyone.
 *
 * **Access:** the event owner (org admin / personal owner) OR a platform ADMIN.
 * The platform ADMIN override applies to ANY event (owned or ownerless
 * COMMUNITY); admin-path archives are audited via `via: "platform_admin"`.
 *
 * **Guards:** archivable from PUBLISHED, COMPLETED, or CANCELLED. An
 * already-ARCHIVED event throws `EVENT_ALREADY_ARCHIVED`; a DRAFT (delete it
 * instead) throws `EVENT_NOT_ARCHIVABLE`.
 *
 * **Who is told (owner ruling 2026-10-16: "they should be notified that
 * everything is cancelled if archived"):**
 *  - PUBLISHED COMMUNITY listing (archived without a cancel first): every
 *    remaining night is called off, and everyone hears it is CANCELLED. The
 *    event-level notice is the CANCELLED kind cancel-event writes
 *    (`event.cancelled` to savers ∪ event-level RSVPers), and the call-off
 *    skips that audience so each person gets exactly one message.
 *  - PUBLISHED OWNED event: `event.unlisted` (ARCHIVED notice), as before.
 *  - CANCELLED (either stewardship): no event-level notice; cancel-event told
 *    them. A COMMUNITY one still runs the call-off without the skip, for
 *    legacy nights a pre-call-off cancel left SCHEDULED.
 *  - COMPLETED: no event-level notice (it is past). A COMMUNITY one runs the
 *    call-off without the skip, so any night still ahead tells its RSVPers.
 */
export async function archiveEvent(
  deps: ArchiveEventDeps,
  rawInput: unknown,
): Promise<ArchiveEventOutput> {
  const input = parseInput(archiveEventInputSchema, rawInput);

  const { event, via } = await ensureEventAccessible(
    deps,
    input.eventId,
    input.actorHumanId,
  );
  ensureEventArchivable(event);

  const result = await deps.repos.tx(async (tx) => {
    // The listing row FOR UPDATE before any night is called off, and the
    // archivable guard re-run on the row as it stands under it. A restore of
    // a single night (`restoreEventDate`) takes this lock before it reads the
    // listing's status: held here, it waits for the archive to commit and then
    // sees ARCHIVED, instead of putting back the night that carries each
    // person's one "the listing is off" notice and deleting that notice.
    await tx.events.lockRows({ ids: [event.id], mode: "update" });
    const current = await tx.events.getById(event.id);
    if (!current) throw fail("EVENT_NOT_FOUND");
    ensureEventArchivable(current);
    // Who is told below is decided from the status loaded before this tx. A
    // cancel or complete that committed in between has already told them
    // (or makes "cancelled" the wrong message), so refuse rather than send a
    // second notice; the caller reloads and sees the listing as it now is.
    if (current.status !== event.status) {
      throw fail("EVENT_NOT_ARCHIVABLE");
    }

    const now = deps.clock.now();

    const archived = await tx.events.archive({ eventId: event.id });

    // A live COMMUNITY listing archived without a cancel first is CANCELLED
    // as far as anyone is concerned (owner ruling 2026-10-16): see the doc
    // comment above.
    const isCommunity = event.stewardship === "COMMUNITY";
    const cancelsLiveListing = isCommunity && event.status === "PUBLISHED";

    // A recurring COMMUNITY listing's per-night RSVPers are not in the
    // event-level notice's audience: call off its remaining nights in this
    // tx so each of them gets a DATE_CANCELLED notice. A live listing skips
    // the savers ∪ event-level RSVPers: the CANCELLED notice below reaches
    // them, so each person hears it once. A CANCELLED listing runs it too,
    // without the skip: one cancelled before cancel learned to call nights
    // off still has SCHEDULED nights whose people were never told, and one
    // cancelled since has none left, so the CAS makes the re-run a no-op.
    // OWNED events are not touched.
    const communityCallOff = isCommunity
      ? await callOffRemainingDates(tx, {
          eventId: event.id,
          now,
          ...(cancelsLiveListing ? { skipHumansInEventAudience: true } : {}),
        })
      : null;

    await tx.audit.log({
      entity: "event",
      entityId: event.id,
      action: "archived",
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

    // Transactional change-notice outbox row. Only a PUBLISHED event had real
    // public visibility → a genuine RSVPer/saver audience worth telling. A
    // COMMUNITY listing gets the CANCELLED notice, in the exact shape
    // cancel-event writes (no buyers: a community listing takes RSVPs, and
    // archive moves no money), so the drain sends `event.cancelled`, with no
    // link: the drain links a cancellation only while the event is CANCELLED,
    // and an ARCHIVED event's page says "No longer available", not
    // "cancelled". An OWNED event gets the ARCHIVED notice
    // (`event.unlisted`). COMPLETED is already past, and CANCELLED was already
    // notified by cancel-event, so those transitions write no notice.
    // Committed atomically with the archive + audit so the intent is
    // crash-safe; a separate drain job fans it out to savers ∪ RSVPers.
    if (cancelsLiveListing) {
      await tx.eventChangeNotices.create({
        eventId: event.id,
        changeType: "CANCELLED",
        payload: {
          eventTitle: event.title,
          startsAt: event.startsAt ? event.startsAt.toISOString() : null,
          buyers: [],
          pendingRefundBuyerHumanIds: [],
        },
      });
    } else if (event.status === "PUBLISHED") {
      await tx.eventChangeNotices.create({
        eventId: event.id,
        changeType: "ARCHIVED",
        payload: { eventTitle: event.title },
      });
    }

    return archiveEventOutputSchema.parse({
      eventId: archived.id,
      status: "ARCHIVED",
    });
  });

  deps.logger?.info("Event archived", {
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
  deps: Pick<ArchiveEventDeps, "repos" | "authz">,
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

function ensureEventArchivable(event: EventRecord): void {
  if (event.status === "ARCHIVED") {
    throw fail("EVENT_ALREADY_ARCHIVED");
  }

  const archivableStatuses = new Set(["PUBLISHED", "COMPLETED", "CANCELLED"]);
  if (!archivableStatuses.has(event.status)) {
    throw fail("EVENT_NOT_ARCHIVABLE");
  }
}
