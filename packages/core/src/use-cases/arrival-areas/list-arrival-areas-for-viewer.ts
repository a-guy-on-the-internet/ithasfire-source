import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { ArrivalAreaRow } from "@th/types/repos/arrival-areas";

import {
  arrivalAreaCostSchema,
  arrivalAreaGeometrySchema,
  arrivalAreaKindSchema,
  validateArrivalAreaShape,
} from "../../lib/arrival-areas/geometry";
import { directionsPointForValidShape } from "../../lib/arrival-areas/directions-point";
import { parseInput } from "../../lib/io";
import { eventIsGated } from "../../lib/location/project-public-event-location";
import {
  redactPlaceLocation,
  type PlaceLocationSource,
} from "../../lib/location/redact-place-location";
import {
  canViewerReadEvent,
  isEventPubliclyReadable,
  type EventStaffReadProbe,
} from "../events/_shared/event-public-readability";
import {
  kindAllowedBy,
  resolveEventAreaAccess,
  sameGrant,
  type AreaGrant,
  type SourceGrants,
  type SourcedRow,
} from "./_shared/event-area-access";

// ─────────────────────────────────────────────────────────────────────────────
// THE visibility projection for arrival areas (arrival-areas spec FR-004,
// FR-007, FR-008, FR-009, NFR-001, NFR-002).
//
// ALL OR NOTHING per parent: a viewer gets a parent's areas only when that
// viewer may see its EXACT address, decided by the SAME functions the
// address uses, never a parallel rule:
//   · place page  — `redactPlaceLocation(place, { viewerCanSeeExact })`, with
//                   `viewerCanSeeExact` = `canManagePlace` (the bar every
//                   withheld-place read uses);
//   · event page  — `resolveHolderAddress`: public when nothing is withheld
//                   (`activeHolder: false, actOnBill: false` unlocks only for
//                   an effective EXACT mode, the place floor applied), else
//                   for this viewer as a holder (a live ticket or a live
//                   RSVP, owner ruling Q4) and/or an act on the bill;
//                   plus the place's managers (`canManagePlace`), and the
//                   event's editors only for an address that is their own
//                   (an event with no place; editing an event AT a place does
//                   not entitle anyone to that place's address, see
//                   get-event-for-edit).
// An obscured or hidden place shows NO areas to the public: never clipped to
// its circle, never "just the parking".
//
// LOAD_IN, split by whose row it is. The PLACE's load-in: the place's
// managers, the event's editors at a show the place vouched for (owner or
// stamp arm; owner ruling Q3), and acts on the bill of such a show until it
// has ended (`isEventPast`). The EVENT's own load-in rows: also the event's
// editors. Ticket holders and RSVP-ers never get load-in. On a place page
// LOAD_IN goes only to the place's managers.
//
// Fails closed everywhere: an unreadable parent, a malformed mode, or any
// repo / authz failure returns NO areas, reported (a deliberate swallow) and
// marked not cacheable. Geometry and Directions points are never logged.
// ─────────────────────────────────────────────────────────────────────────────

export const listArrivalAreasForViewerInputObjectSchema = z
  .object({
    placeId: z.string().uuid().optional(),
    eventId: z.string().uuid().optional(),
    /** Server-injected (ctx), never client-supplied. */
    viewerHumanId: z.string().uuid().optional(),
    /**
     * Server-injected: TRUE only when the transport has already passed this
     * viewer through the event's password / application gate
     * (`ensureFullEventReadAccessByEventId`). Absent = not granted: a gated
     * event shows its areas to no one but its acts and managing staff.
     * The transport must `.omit()` this key from its client-facing input,
     * as it does `viewerHumanId`.
     */
    gateAccessGranted: z.boolean().optional(),
  })
  .strict();

/** Exactly one of placeId / eventId (exported for `.omit(...).refine(...)` at the transport). */
export const listArrivalAreasForViewerParentRefinement = (v: { placeId?: string; eventId?: string }) =>
  (v.placeId === undefined) !== (v.eventId === undefined);

export const listArrivalAreasForViewerInputSchema = listArrivalAreasForViewerInputObjectSchema.refine(
  listArrivalAreasForViewerParentRefinement,
  { message: "exactly one of placeId or eventId" },
);

export type ListArrivalAreasForViewerInput = z.infer<
  typeof listArrivalAreasForViewerInputSchema
>;

const directionsPointSchema = z
  .object({ lat: z.number(), lng: z.number() })
  .strict();

export const visibleArrivalAreaSchema = z
  .object({
    id: z.string(),
    /** `PLACE` = the place's area (shown on its events); `EVENT` = event-only. */
    source: z.enum(["PLACE", "EVENT"]),
    kind: arrivalAreaKindSchema,
    label: z.string(),
    cost: arrivalAreaCostSchema,
    priceText: z.string().nullable(),
    note: z.string().nullable(),
    accessibleSpots: z.boolean(),
    /** Null when the stored shape is malformed: listed, not drawn. */
    geometry: arrivalAreaGeometrySchema.nullable(),
    /** Null when no point inside can be promised: no Directions link. */
    directions: directionsPointSchema.nullable(),
  })
  .strict();

export type VisibleArrivalArea = z.infer<typeof visibleArrivalAreaSchema>;

export const listArrivalAreasForViewerOutputSchema = z
  .object({
    areas: z.array(visibleArrivalAreaSchema),
    /**
     * NFR-001. TRUE only when `areas` is exactly what ANY anonymous visitor
     * gets and nothing viewer-specific went into it: the caller may serve it
     * from the ISR-cached page. FALSE when a viewer's grant (holder, act,
     * staff, a passed gate) added areas, and on every fail-closed path (a
     * failure-induced empty list must not be cached as the truth).
     */
    cacheablePublic: z.boolean(),
  })
  .strict();

export type ListArrivalAreasForViewerOutput = z.infer<
  typeof listArrivalAreasForViewerOutputSchema
>;

export type ListArrivalAreasForViewerDeps = {
  repos: Pick<
    Repos,
    | "arrivalAreas"
    | "events"
    | "places"
    | "eventHumans"
    | "tickets"
    | "eventRsvps"
    | "eventDateRsvps"
    | "humans"
    | "authz"
  >;
  authz: Pick<AuthZPort, "canEditEvent" | "canManagePlace"> &
    EventStaffReadProbe;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Deliberate swallow (CLAUDE.md "Error Reporting Convention"): any failure
   * here degrades to NO areas instead of failing the page, and is reported.
   */
  reportError?: ReporterPort;
};

const NOTHING: ListArrivalAreasForViewerOutput = {
  areas: [],
  cacheablePublic: false,
};

/** The ids in order: what "the same list" means for cacheability. */
const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/** Whether `grants` lets this row through (pure; no geometry work). */
function allowedBy(row: SourcedRow, grants: SourceGrants): boolean {
  // Switched-off areas (FR-014) are never shown here; editors see them in
  // the editor read.
  if (row.disabledAt !== null && row.disabledAt !== undefined) return false;
  return kindAllowedBy(row, grants);
}

/** The ids `grants` lets through, in order: the anonymous list's identity. */
function allowedIds(rows: readonly SourcedRow[], grants: SourceGrants): string[] {
  return rows.filter((row) => allowedBy(row, grants)).map((row) => row.id);
}

function project(
  rows: readonly SourcedRow[],
  grants: SourceGrants,
): VisibleArrivalArea[] {
  const out: VisibleArrivalArea[] = [];
  for (const row of rows) {
    if (!allowedBy(row, grants)) continue;
    // Validated ONCE per shown row; the Directions search takes the
    // validated shape and never re-validates.
    const shape = validateArrivalAreaShape(row.geometry);
    out.push({
      id: row.id,
      source: row.source,
      kind: row.kind,
      label: row.label,
      cost: row.cost,
      priceText: row.priceText ?? null,
      note: row.note ?? null,
      accessibleSpots: row.accessibleSpots === true,
      geometry: shape.ok ? shape.geometry : null,
      directions: shape.ok ? directionsPointForValidShape(shape.geometry) : null,
    });
  }
  return out;
}

function tagged(
  rows: readonly ArrivalAreaRow[],
  source: "PLACE" | "EVENT",
): Array<ArrivalAreaRow & { source: "PLACE" | "EVENT" }> {
  return rows.map((row) => ({ ...row, source }));
}

// ── Place page ──────────────────────────────────────────────────────────────

/**
 * Does `place`'s public page publish its exact address? Only a genuinely
 * EXACT, ACTIVE place does (a suspended or archived place has no public
 * page). The place page shows its areas to the public only then.
 */
export function placePagePublishesExact(
  place: PlaceLocationSource & { status: string },
): boolean {
  return place.status === "ACTIVE" && redactPlaceLocation(place).isExact;
}

/**
 * The ids of `rows` (the place's own areas) a signed-out visitor sees on
 * `place`'s page, in order: the switched-on parking and drop-off areas when
 * the page publishes the exact address, never load-in. The anonymous half of
 * the place-page read below, as a pure function for callers that must
 * predict it (the place-merge preview).
 */
export function anonymousPlacePageAreaIds(
  place: PlaceLocationSource & { status: string },
  rows: readonly ArrivalAreaRow[],
): string[] {
  const grant: AreaGrant = {
    publicKinds: placePagePublishesExact(place),
    loadIn: false,
  };
  return allowedIds(tagged(rows, "PLACE"), sameGrant(grant));
}

async function forPlace(
  deps: ListArrivalAreasForViewerDeps,
  placeId: string,
  viewerHumanId: string | undefined,
): Promise<ListArrivalAreasForViewerOutput> {
  const place = await deps.repos.places.getById(placeId);
  if (!place) return NOTHING;

  const placeStaff = viewerHumanId
    ? (
        await deps.authz.canManagePlace({
          actorHumanId: viewerHumanId,
          placeId: place.id,
        })
      ).allowed === true
    : false;

  // The public reading of the address (`placePagePublishesExact`).
  const publicExact = placePagePublishesExact(place);
  // The same function with the manager's unlock.
  const viewerExact = redactPlaceLocation(place, {
    viewerCanSeeExact: placeStaff,
  }).isExact;

  const anonymousGrant: AreaGrant = { publicKinds: publicExact, loadIn: false };
  const viewerGrant: AreaGrant = placeStaff
    ? { publicKinds: viewerExact, loadIn: viewerExact }
    : anonymousGrant;

  const placeRows = await deps.repos.arrivalAreas.listForPlace(place.id);
  const rows = tagged(placeRows, "PLACE");
  const areas = project(rows, sameGrant(viewerGrant));
  const anonymousIds = anonymousPlacePageAreaIds(place, placeRows);
  return {
    areas,
    cacheablePublic:
      place.status === "ACTIVE" &&
      sameIds(areas.map((a) => a.id), anonymousIds),
  };
}

// ── Event page ──────────────────────────────────────────────────────────────

async function forEvent(
  deps: ListArrivalAreasForViewerDeps,
  eventId: string,
  viewerHumanId: string | undefined,
  gateAccessGranted: boolean,
): Promise<ListArrivalAreasForViewerOutput> {
  const event: EventRecord | null = await deps.repos.events.getById(eventId, {
    withOwnerStanding: true,
  });
  if (!event) return NOTHING;

  // The event page's own readability (drafts, a banned owner's events): a
  // viewer who may not read the event gets none of its areas.
  if (
    !(await canViewerReadEvent(
      deps.repos.authz,
      event,
      viewerHumanId,
      deps.repos.tickets,
      deps.authz,
    ))
  ) {
    return NOTHING;
  }

  const place: PlaceRecord | null = event.placeId
    ? await deps.repos.places.getById(event.placeId)
    : null;

  // The one access decision (./_shared/event-area-access.ts): the address
  // rule, the place's load-in rule and the event's own load-in rule.
  const { grants: viewerGrants, anonymousGrant } = await resolveEventAreaAccess(
    deps,
    {
      event,
      place,
      viewerHumanId,
      gateAccessGranted,
      now: deps.clock.now(),
    },
  );

  // FR-004: the place's CURRENT areas (live), minus this event's hides, then
  // the event's own areas.
  const [placeRows, hides, eventRows] = await Promise.all([
    place ? deps.repos.arrivalAreas.listForPlace(place.id) : Promise.resolve([]),
    place ? deps.repos.arrivalAreas.listHidesForEvent(event.id) : Promise.resolve([]),
    deps.repos.arrivalAreas.listForEvent(event.id),
  ]);
  const hidden = new Set(hides);
  const rows = [
    ...tagged(
      placeRows.filter((row) => row.placeId === place?.id && !hidden.has(row.id)),
      "PLACE",
    ),
    ...tagged(
      eventRows.filter((row) => row.eventId === event.id),
      "EVENT",
    ),
  ];

  const areas = project(rows, viewerGrants);
  const anonymousIds = allowedIds(rows, sameGrant(anonymousGrant));
  return {
    areas,
    // Cacheable only for an event anyone may read (not a draft, not a banned
    // owner's, which an editor or holder can still read), with no gate (a
    // passed gate is itself per-viewer), and exactly the anonymous list.
    cacheablePublic:
      isEventPubliclyReadable(event) &&
      !eventIsGated(event) &&
      sameIds(areas.map((a) => a.id), anonymousIds),
  };
}

// ── Use case ────────────────────────────────────────────────────────────────

export async function listArrivalAreasForViewer(
  deps: ListArrivalAreasForViewerDeps,
  rawInput: unknown,
): Promise<ListArrivalAreasForViewerOutput> {
  const input = parseInput(listArrivalAreasForViewerInputSchema, rawInput);
  try {
    const result = input.placeId
      ? await forPlace(deps, input.placeId, input.viewerHumanId)
      : await forEvent(
          deps,
          input.eventId as string,
          input.viewerHumanId,
          input.gateAccessGranted === true,
        );
    return listArrivalAreasForViewerOutputSchema.parse(result);
  } catch (err) {
    // Ids only: never a geometry or a Directions point (NFR-002).
    const where = input.placeId
      ? { placeId: input.placeId }
      : { eventId: input.eventId };
    deps.logger?.error("arrival_areas.list_for_viewer_failed", { ...where, err });
    try {
      deps.reportError?.(err, {
        tags: { useCase: "listArrivalAreasForViewer" },
        extra: where,
      });
    } catch {
      // A throwing reporter must never change behaviour.
    }
    return NOTHING;
  }
}
