import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { EntityPageRecord } from "@th/ports/repos/entity-pages";
import type { EventRecord } from "@th/ports/repos/events";
import type {
  PlaceBookingGrantee,
  PlaceBookingGrantRecord,
} from "@th/ports/repos/place-booking-grants";
import type { PlaceRecord } from "@th/ports/repos/places";
import { fail } from "@th/errors";

import {
  auditActionsWithLegacy,
  normalizeAuditAction,
  type PlaceAuditAction,
} from "../../../lib/legacy-place-values";
import { ORG_ADMIN_ROLES } from "../../../lib/rbac";
import { hasActiveVenueConfirmationStamp } from "../../../lib/venue-confirmation";
import {
  requirePlaceOwnership,
  type PlaceOwnershipResult,
} from "../../booking-requests/_shared/place-access";
import { placeBookingGranteeSchema } from "./grant-intents";

// ─────────────────────────────────────────────────────────────────────────────
// Shared load + authorize for the booking grant lifecycle
// (holds-without-a-request FR-003, H4).
//
// WHO MANAGES GRANTS (H4): the place's direct human owner, or an OWNER /
// ADMIN of an owning org. Never an EDITOR (acceptance: "An editor at the
// place gets no Outside bookers controls; the server refuses them too"),
// and never a grantee: this gate reads no grant. Give, edit, preview-revoke
// and revoke all go through `requireGrantManager`.
//
// ORDER: the place gate runs BEFORE the grant is read, so a stranger never
// learns whether a grant id exists, and a grant id from another place reads
// PLACE_BOOKING_GRANT_NOT_FOUND exactly like a missing one (the repo's
// `getForPlace` is place-scoped).
// ─────────────────────────────────────────────────────────────────────────────

export type PlaceBookingGrantDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function requireGrantPlace(
  repos: Pick<Repos, "places">,
  placeId: string,
): Promise<PlaceRecord> {
  const place = await repos.places.getById(placeId);
  if (!place) throw fail("PLACE_NOT_FOUND");
  return place;
}

/**
 * The grant MANAGER gate (H4): direct owner, or owning-org OWNER / ADMIN.
 *
 * @throws PLACE_NOT_FOUND for an unknown place.
 * @throws INSUFFICIENT_ROLE for an owning-org member below ADMIN (an EDITOR).
 * @throws NOT_RESOURCE_OWNER for anyone else (grantees included).
 */
export async function requireGrantManager(
  repos: Pick<Repos, "places" | "authz">,
  placeId: string,
  actorHumanId: string,
): Promise<{ place: PlaceRecord; ownership: PlaceOwnershipResult }> {
  const place = await requireGrantPlace(repos, placeId);
  const ownership = await requirePlaceOwnership(repos, place, actorHumanId, {
    requiredOrgRoles: ORG_ADMIN_ROLES,
  });
  return { place, ownership };
}

/** A grant AT this place, any state; another place's id reads as missing. */
export async function requireGrantAtPlace(
  repos: Pick<Repos, "placeBookingGrants">,
  placeId: string,
  grantId: string,
): Promise<PlaceBookingGrantRecord> {
  const grant = await repos.placeBookingGrants.getForPlace({
    id: grantId,
    placeId,
  });
  if (!grant || grant.placeId !== placeId) {
    throw fail("PLACE_BOOKING_GRANT_NOT_FOUND");
  }
  return grant;
}

/**
 * A party picked by its PUBLIC page (NFR-002): the grantee of a grant, the
 * named party of a place hold. Only a PUBLIC page qualifies; a missing,
 * PRIVATE or UNLISTED page, and the page of a banned owner (a BANNED human,
 * an org whose every OWNER is banned: the public page read's rule), all read
 * PAGE_NOT_FOUND, so the picker is no oracle for pages the public cannot
 * see. The caller decides what an owner type other than org / person means.
 */
export async function requirePublicPartyPage(
  repos: Pick<Repos, "entityPages" | "bans">,
  pageId: string,
): Promise<EntityPageRecord> {
  const page = await repos.entityPages.getById(pageId);
  if (!page || page.visibility !== "PUBLIC") {
    throw fail("PAGE_NOT_FOUND", { meta: { pageId } });
  }
  if (page.ownerType === "HUMAN" || page.ownerType === "ORGANIZATION") {
    const human = page.ownerType === "HUMAN";
    const banned = await repos.bans.findBannedOwners({
      humanIds: human ? [page.ownerId] : [],
      orgIds: human ? [] : [page.ownerId],
    });
    if ((human ? banned.humanIds : banned.orgIds).includes(page.ownerId)) {
      throw fail("PAGE_NOT_FOUND", { meta: { pageId } });
    }
  }
  return page;
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

export const PLACE_BOOKING_GRANT_STATUSES = [
  "pending",
  "active",
  "declined",
  "expired",
  "revoked",
] as const;

export type PlaceBookingGrantStatus =
  (typeof PLACE_BOOKING_GRANT_STATUSES)[number];

/**
 * The grant's state at `now`, derived from its stamps (never stored).
 * Revoked wins over everything, then declined, then expired (a pending grant
 * past its expiry is expired too: it can no longer be accepted), then
 * accepted = active, else pending.
 */
export function grantStatusAt(
  grant: Pick<
    PlaceBookingGrantRecord,
    "revokedAt" | "declinedAt" | "acceptedAt" | "expiresAt"
  >,
  now: Date,
): PlaceBookingGrantStatus {
  if (grant.revokedAt !== null) return "revoked";
  if (grant.declinedAt !== null) return "declined";
  if (grant.expiresAt !== null && grant.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  return grant.acceptedAt !== null ? "active" : "pending";
}

/** Pending or active: the grant still stands (or may still be accepted). */
export function isGrantLive(
  grant: Parameters<typeof grantStatusAt>[0],
  now: Date,
): boolean {
  const status = grantStatusAt(grant, now);
  return status === "pending" || status === "active";
}

export function sameGrantee(
  a: PlaceBookingGrantee,
  b: PlaceBookingGrantee,
): boolean {
  return a.kind === "org"
    ? b.kind === "org" && a.orgId === b.orgId
    : b.kind === "person" && a.humanId === b.humanId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The grant as place STAFF see it: its own row, nothing else of the place's.
 * The grantee side reads {@link granteeGrantOutputSchema}.
 */
export const placeBookingGrantOutputSchema = z
  .object({
    id: z.uuid(),
    placeId: z.uuid(),
    /** Null = the whole place. */
    calendarId: z.uuid().nullable(),
    grantee: placeBookingGranteeSchema,
    grantedByHumanId: z.uuid(),
    expiresAt: z.date().nullable(),
    acceptedAt: z.date().nullable(),
    declinedAt: z.date().nullable(),
    revokedAt: z.date().nullable(),
    createdAt: z.date(),
    status: z.enum(PLACE_BOOKING_GRANT_STATUSES),
  })
  .strict();

export type PlaceBookingGrantOutput = z.infer<
  typeof placeBookingGrantOutputSchema
>;

export function toPlaceBookingGrantOutput(
  grant: PlaceBookingGrantRecord,
  now: Date,
): PlaceBookingGrantOutput {
  return {
    id: grant.id,
    placeId: grant.placeId,
    calendarId: grant.calendarId,
    grantee: grant.grantee,
    grantedByHumanId: grant.grantedByHumanId,
    expiresAt: grant.expiresAt,
    acceptedAt: grant.acceptedAt,
    declinedAt: grant.declinedAt,
    revokedAt: grant.revokedAt,
    createdAt: grant.createdAt,
    status: grantStatusAt(grant, now),
  };
}

/**
 * The grant as its GRANTEE sees it (list-mine, respond): the staff output
 * without `grantedByHumanId`. Which manager gave it is the place's internal
 * detail; the grantee is told by the place, not by a person's id.
 */
export const granteeGrantOutputSchema = placeBookingGrantOutputSchema
  .omit({ grantedByHumanId: true })
  .strict();

export type GranteeGrantOutput = z.infer<typeof granteeGrantOutputSchema>;

export function toGranteeGrantOutput(
  grant: PlaceBookingGrantRecord,
  now: Date,
): GranteeGrantOutput {
  return {
    id: grant.id,
    placeId: grant.placeId,
    calendarId: grant.calendarId,
    grantee: grant.grantee,
    expiresAt: grant.expiresAt,
    acceptedAt: grant.acceptedAt,
    declinedAt: grant.declinedAt,
    revokedAt: grant.revokedAt,
    createdAt: grant.createdAt,
    status: grantStatusAt(grant, now),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Events confirmed under a grant (FR-003 revoke preview, H15)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The audit actions that stamp an event's place confirmation. The NEWEST of
 * them says how the current stamp got there; only a `_by_grant` row naming
 * this grant makes the event the grant's.
 *
 * Rows written before 2026-10-18 carry the old spelling of each action, so
 * the filter asks for both (`auditActionsWithLegacy`) and the comparison
 * reads the normalised action: a stamp is the grant's whichever build wrote
 * its row.
 */
export const VENUE_STAMP_ACTIONS = auditActionsWithLegacy([
  "event.place_confirmed",
  "event.place_confirmed_by_grant",
  "event.place_confirmed_by_manager",
] satisfies PlaceAuditAction[]);

/** How far ahead "upcoming" looks for the grantee's events at the place. */
const UPCOMING_WINDOW_MS = 5 * 365 * 24 * 60 * 60 * 1000;

const ENDED_EVENT_STATUSES: readonly EventRecord["status"][] = [
  "CANCELLED",
  "COMPLETED",
  "ARCHIVED",
];

function ownedByGrantee(
  event: Pick<EventRecord, "orgId" | "humanId">,
  grantee: PlaceBookingGrantee,
): boolean {
  return grantee.kind === "org"
    ? event.orgId === grantee.orgId
    : event.orgId === null && event.humanId === grantee.humanId;
}

/**
 * The grantee's UPCOMING events at the place whose CURRENT venue
 * confirmation came from THIS grant (H15: "each upcoming event defaults to
 * staying, the alternative being to withdraw the place's confirmation").
 *
 * An event qualifies when it is owned by the grantee (the org, or the person
 * with no org), is not cancelled / completed / archived, starts (or has a
 * scheduled occurrence) after `now`, carries an active stamp for THIS place,
 * and the newest stamping audit row is `event.place_confirmed_by_grant` (or
 * its pre-2026-10-18 spelling) with
 * `data.grantId` = this grant (the save records it:
 * `venue-manager-stamp.ts`). An event the place confirmed itself, or that a
 * manager's save stamped, is not the grant's and is not listed.
 *
 * One place read for the window, then one audit read per candidate (the
 * grantee's own confirmed events at this place: a short list).
 */
export async function listEventsConfirmedUnderGrant(
  repos: Pick<Repos, "events" | "audit">,
  args: { grant: PlaceBookingGrantRecord; now: Date },
): Promise<EventRecord[]> {
  const { grant, now } = args;
  const window = await repos.events.listAllByPlace({
    placeId: grant.placeId,
    from: now,
    to: new Date(now.getTime() + UPCOMING_WINDOW_MS),
    includeDateOccurrences: true,
  });
  const candidates = window.filter(
    (event) =>
      ownedByGrantee(event, grant.grantee) &&
      !ENDED_EVENT_STATUSES.includes(event.status) &&
      (event.placeId ?? null) === grant.placeId &&
      hasActiveVenueConfirmationStamp(event),
  );
  const out: EventRecord[] = [];
  for (const event of candidates) {
    const [newest] = await repos.audit.listForEntity({
      entity: "event",
      entityId: event.id,
      actions: VENUE_STAMP_ACTIONS,
      limit: 1,
    });
    if (
      newest !== undefined &&
      normalizeAuditAction(newest.action) === "event.place_confirmed_by_grant" &&
      typeof newest.data === "object" &&
      newest.data !== null &&
      (newest.data as { grantId?: unknown }).grantId === grant.id
    ) {
      out.push(event);
    }
  }
  return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

export const grantEventOutputSchema = z
  .object({
    eventId: z.uuid(),
    title: z.string(),
    startsAt: z.date(),
    status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED", "CANCELLED", "COMPLETED"]),
    calendarId: z.uuid().nullable(),
  })
  .strict();

export type GrantEventOutput = z.infer<typeof grantEventOutputSchema>;

export function toGrantEventOutput(event: EventRecord): GrantEventOutput {
  return {
    eventId: event.id,
    title: event.title,
    startsAt: event.startsAt,
    status: event.status,
    calendarId: event.calendarId ?? null,
  };
}
