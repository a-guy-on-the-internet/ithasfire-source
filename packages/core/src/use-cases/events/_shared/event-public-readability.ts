import { AppError } from "@th/errors";
import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";

import { actorHoldsEventEditRole } from "../../../lib/event-edit-rights";
import { COMMUNITY_MODERATION_ROLES } from "../../community/_shared/suggestion-validation";

/**
 * WHO MAY READ AN EVENT'S PAGE BY SLUG OR ID (place-address-withholding N3,
 * 2026-09-25).
 *
 * A slug is guessable (it is built from the title) and the anonymous page
 * reads resolved any slug to the full event whatever its status. So a DRAFT
 * — which has never been public, and which a quick-create mints with an
 * EXACT address before its organizer has decided to hide it — was readable
 * by anyone who could guess its title.
 *
 * The rule: an event is PUBLICLY readable when it is PUBLISHED or COMPLETED
 * (`completeEvent` only moves a PUBLISHED event, so COMPLETED was always
 * live — even on a legacy row with no `publishedAt`), or when it was
 * CANCELLED / ARCHIVED AFTER having been live (`publishedAt` set; a DRAFT
 * can be cancelled without ever going live). The end-state pages are the ones the product
 * links to after the fact — a venue's track record and lineup history, a
 * holder's my-tickets row, the cancelled / completed banner a shared link
 * lands on — and everything on them was public while the event was live.
 * A DRAFT is never publicly readable, and neither is an event that was
 * cancelled or archived without ever going live.
 *
 * BANNED OWNERS (ban-that-sticks, 2026-09-29): while the owner is withheld
 * because of a ban — the owning human is BANNED, or every OWNER of the
 * owning org is — the event is not publicly readable either, whatever its
 * status. `ownerBanned` is derived by the events adapter at read time
 * (`getById` / `findManyByIds`) and never stored, so reactivating the owner
 * brings the page straight back. Edit-rights holders still read it below.
 *
 * Everyone else needs edit rights on the event, on the SAME bar as
 * `authz.canEditEvent` (`actorHoldsEventEditRole`, which both call): an
 * edit-role member of the owning org, the owning human, or an edit-role
 * delegate of the owning human — or, for an ownerless COMMUNITY listing, a
 * community moderator (the only people who author those drafts). Never read
 * a hidden event on a wider bar than the one that may edit it.
 *
 * The moderator read is a staff grant, so it is asked of the authz PORT
 * (`hasStaffRole`), which counts a staff role only with a second factor
 * enrolled — the same answer `getEventForEdit` gets.
 */
export function isEventPubliclyReadable(
  event: Pick<EventRecord, "status" | "publishedAt" | "ownerBanned">,
): boolean {
  if (event.ownerBanned === true) return false;
  if (event.status === "PUBLISHED" || event.status === "COMPLETED") return true;
  if (event.status === "DRAFT") return false;
  return (event.publishedAt ?? null) !== null;
}

type ReadabilityAuthz = Pick<
  Repos["authz"],
  "getOrgMembership" | "getHumanDelegation"
>;

/** The authz port's staff probe, for the community-moderator read. */
export type EventStaffReadProbe = Pick<AuthZPort, "hasStaffRole">;

/**
 * Whether `viewerHumanId` may read an event that is NOT publicly readable.
 * Anonymous viewers never may.
 */
export async function canViewerReadUnpublishedEvent(
  authz: ReadabilityAuthz,
  event: EventRecord,
  viewerHumanId: string | null | undefined,
  staffAuthz: EventStaffReadProbe,
): Promise<boolean> {
  if (!viewerHumanId) return false;
  if (event.stewardship === "COMMUNITY") {
    const staff = await staffAuthz.hasStaffRole({
      actorHumanId: viewerHumanId,
      requiredRoles: [...COMMUNITY_MODERATION_ROLES],
    });
    return staff.allowed;
  }
  return actorHoldsEventEditRole(authz, event, viewerHumanId);
}

/**
 * The ONE answer every slug-keyed read gives for "no event you may read":
 * the unknown-slug error. A hidden event — reached by its current slug, an
 * old slug, or its id — must throw exactly this, byte for byte (`meta`
 * included, since the transport forwards it), or the response shape tells a
 * stranger that the slug belongs to a real event.
 */
export function eventNotFoundBySlug(): AppError {
  // RETURNS the error (callers `throw` it), unlike `fail`, which throws — so
  // a transport can hand it to `toTrpcError` inside a catch block.
  return new AppError("EVENT_NOT_FOUND", { meta: { via: "slug" } });
}

/** Who holds a ticket (for the banned-owner holder exception). */
export type EventTicketHolderLookup = Pick<
  Repos["tickets"],
  "viewerHoldsActiveTicketForEvent"
>;

/**
 * Owner ruling (ban-that-sticks review, 2026-09-29): people who ALREADY hold
 * an active ticket (VALID | SCANNED | LISTED) to an event keep its page while
 * the owner is banned — they may still be going. The exception covers ONLY
 * the ban: the event must otherwise be publicly readable. Nobody else gets
 * in. No `tickets` lookup → no exception (fails closed). A ticket on an
 * account whose email is unverified does not count (B2: guest checkout can
 * attach someone else's ticket to it by email).
 */
async function isTicketHolderOfBannedOwnersEvent(
  event: EventRecord,
  viewerHumanId: string | null | undefined,
  tickets: EventTicketHolderLookup | undefined,
): Promise<boolean> {
  if (event.ownerBanned !== true || !viewerHumanId || !tickets) return false;
  if (!isEventPubliclyReadable({ ...event, ownerBanned: false })) return false;
  return tickets.viewerHoldsActiveTicketForEvent(event.id, viewerHumanId);
}

/**
 * The N3 rule in one call: publicly readable, or the viewer may edit it, or
 * (banned owner only) the viewer already holds a ticket to it.
 */
export async function canViewerReadEvent(
  authz: ReadabilityAuthz,
  event: EventRecord,
  viewerHumanId: string | null | undefined,
  tickets: EventTicketHolderLookup | undefined,
  staffAuthz: EventStaffReadProbe,
): Promise<boolean> {
  return (
    isEventPubliclyReadable(event) ||
    (await isTicketHolderOfBannedOwnersEvent(event, viewerHumanId, tickets)) ||
    canViewerReadUnpublishedEvent(authz, event, viewerHumanId, staffAuthz)
  );
}

/**
 * The N3 check keyed by SLUG, for a caller that must answer it BEFORE any
 * other gate: the transport runs the password / application gate check
 * ahead of `getEventSeo` / `getPublicEventBody`, and a gated DRAFT would
 * otherwise answer `event_password_required` — confirming to a stranger that
 * the slug is a real event. Covers old slugs too: the target of a redirect is
 * the event being asked about. Throws {@link eventNotFoundBySlug} for an
 * event the viewer may not read; returns quietly for anything else (a
 * missing slug or a vanished event is the use case's own answer, which is
 * the same error).
 */
export async function ensureEventReadableBySlug(
  repos: Pick<Repos, "events" | "authz"> & Partial<Pick<Repos, "tickets">>,
  input: { slug: string; viewerHumanId: string | null | undefined },
  staffAuthz: EventStaffReadProbe,
): Promise<void> {
  const resolution = await repos.events.resolveBySlug(input.slug);
  if (!resolution) return;
  const event = await repos.events.getById(resolution.eventId, {
    withOwnerStanding: true,
  });
  if (!event) return;
  if (
    !(await canViewerReadEvent(
      repos.authz,
      event,
      input.viewerHumanId,
      repos.tickets,
      staffAuthz,
    ))
  ) {
    throw eventNotFoundBySlug();
  }
}
