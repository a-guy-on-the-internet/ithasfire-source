import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  BookerBookingHoldRecord,
  BookingHoldRecord,
  PlaceBookingHoldRecord,
  RequestBookingHoldRecord,
} from "@th/ports/repos/booking-holds";
import type {
  BookingRequestRecord,
  ToVenueBookingRequestRecord,
} from "@th/ports/repos/booking-requests";
import type { PlaceRecord } from "@th/ports/repos/places";
import { fail } from "@th/errors";

import { resolveBookingTimezone } from "../../booking-agreements/_shared/pitch-seed";
import {
  findPlaceBookingAuthority,
  listPlaceBookerGrants,
  requirePlaceBookingAuthority,
  type PlaceBookerAuthorityResult,
  type PlaceBookingAuthorityResult,
} from "../../booking-requests/_shared/place-access";
import {
  ensureBookingThreadParticipant,
  ensureBookingThreadReader,
} from "../../booking-requests/messages/_shared/thread-access";
import type { BookingHoldStaffRecipientHint } from "./booking-hold-intents";
import { isHoldLapsed } from "./booking-hold-lapse";

// ─────────────────────────────────────────────────────────────────────────────
// Shared load + authorize for the hold use cases.
//
// Holds exist ONLY for TO_VENUE requests (a venue keeps a line for the acts
// asking to play its room); a TO_PERFORMER row has no place and therefore no
// calendar to hold on. Every entry point rejects the other direction with
// BOOKING_HOLDS_VENUE_ONLY before doing anything else.
//
// Two gates, mirroring the thread's:
//   - STAFF mutations: `requirePlaceBookingAuthority` (direct human owners
//     and ORG_EDIT_ROLES members pass; a booking grantee does NOT — FR-002,
//     the grant arm left the staff gate).
//   - ACT mutations:   `ensureBookingThreadParticipant(…, "PERFORMER")` —
//     the owned sender, self for a human act, edit roles for an org act.
//
// holds-without-a-request (FR-001): a hold may have no request (a BOOKER or
// PLACE hold). The staff context then resolves the place through the hold's
// calendar and carries `request: null`; callers narrow on it. A use case
// that only makes sense for a request hold loads
// `loadStaffRequestHoldContext`, which refuses the other kinds with
// BOOKING_HOLD_NEEDS_REQUEST — AFTER the staff gate, so a stranger never
// learns the hold's kind (the confirm-booking-hold.ts rule). The act context is request-only by definition: an act's hold is
// its request's, so a request-less hold id reads BOOKING_HOLD_NOT_FOUND
// there, like a missing one.
// ─────────────────────────────────────────────────────────────────────────────

export type BookingHoldDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export function requireToVenueRequest(
  request: BookingRequestRecord,
): ToVenueBookingRequestRecord {
  if (request.direction !== "TO_VENUE") {
    throw fail("BOOKING_HOLDS_VENUE_ONLY", {
      meta: { bookingRequestId: request.id, direction: request.direction },
    });
  }
  return request;
}

export async function requireHold(
  repos: Pick<Repos, "bookingHolds">,
  holdId: string,
): Promise<BookingHoldRecord> {
  const hold = await repos.bookingHolds.getById(holdId);
  if (!hold) {
    throw fail("BOOKING_HOLD_NOT_FOUND");
  }
  return hold;
}

/**
 * The hold must be a REQUEST hold: the action is request-only today (it
 * agrees terms, writes the request's thread, or answers as the act). A
 * BOOKER or PLACE hold is refused with BOOKING_HOLD_NEEDS_REQUEST rather
 * than read as if it had a request (holds-without-a-request FR-001).
 */
export function requireRequestHold(
  hold: BookingHoldRecord,
): RequestBookingHoldRecord {
  if (hold.ownerKind !== "REQUEST") {
    throw fail("BOOKING_HOLD_NEEDS_REQUEST", {
      meta: { holdId: hold.id, ownerKind: hold.ownerKind },
    });
  }
  return hold;
}

export async function requireRequest(
  repos: Pick<Repos, "bookingRequests">,
  bookingRequestId: string,
): Promise<BookingRequestRecord> {
  const request = await repos.bookingRequests.getById(bookingRequestId);
  if (!request) {
    throw fail("BOOKING_REQUEST_NOT_FOUND");
  }
  return request;
}

export async function requirePlace(
  repos: Pick<Repos, "places">,
  placeId: string,
): Promise<PlaceRecord> {
  const place = await repos.places.getById(placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  return place;
}

/**
 * FR-016 routing hint for the request's staff side. `orgId` is the org the
 * actor's access came through, else the first owning org (a direct human
 * owner acting on an org-owned place), else null (directly human-owned venue
 * — the owner IS the assignee, and the field stays null per FR-015).
 */
export function staffRecipientHintFor(args: {
  hold: Pick<BookingHoldRecord, "placedByHumanId">;
  /** Null for a request-less hold: no request, so no assignee. */
  request: Pick<BookingRequestRecord, "assigneeHumanId"> | null;
  place: Pick<PlaceRecord, "id" | "orgIdsWithAccess">;
  /** Null when no staff actor is known: routing falls to the owners. */
  ownership: Pick<PlaceBookingAuthorityResult, "via" | "orgId"> | null;
}): BookingHoldStaffRecipientHint {
  const { hold, request, place, ownership } = args;
  return {
    assigneeHumanId: request?.assigneeHumanId ?? null,
    placedByHumanId: hold.placedByHumanId,
    orgId:
      (ownership?.via === "org" ? ownership.orgId : null) ??
      place.orgIdsWithAccess[0] ??
      null,
    placeId: place.id,
  };
}

/**
 * The hold's calendar MUST belong to the request's place. The schema does not
 * stop a calendar of place X being referenced from a request to place Y (no
 * composite FK), and every gate below is resolved from the REQUEST's place —
 * so a mismatched row would let place Y's staff act on place X's line. A
 * mismatch is data corruption, refused as a typed not-found.
 */
export async function requireHoldCalendarAtPlace(
  repos: Pick<Repos, "calendars">,
  hold: Pick<BookingHoldRecord, "id" | "calendarId">,
  request: Pick<ToVenueBookingRequestRecord, "id" | "placeId">,
  /**
   * A booker (not staff) is the actor: the refusal carries no meta, since
   * the request and place ids are another act's (H17).
   */
  options: { bareRefusal?: boolean } = {},
): Promise<void> {
  const calendar = await repos.calendars.findById(hold.calendarId);
  if (!calendar || calendar.placeId !== request.placeId) {
    if (options.bareRefusal) throw fail("CALENDAR_NOT_FOUND");
    throw fail("CALENDAR_NOT_FOUND", {
      meta: {
        reason: "hold_calendar_place_mismatch",
        holdId: hold.id,
        calendarId: hold.calendarId,
        bookingRequestId: request.id,
        placeId: request.placeId,
      },
    });
  }
}

type StaffHoldContextBase = {
  place: PlaceRecord;
  ownership: PlaceBookingAuthorityResult;
  placeTz: string;
  staffRecipientHint: BookingHoldStaffRecipientHint;
};

/** A staff action on a REQUEST hold: the request is loaded and checked. */
export type RequestStaffHoldContext = StaffHoldContextBase & {
  hold: RequestBookingHoldRecord;
  request: ToVenueBookingRequestRecord;
};

/**
 * A staff action on a request-less hold (holds-without-a-request): the place
 * comes from the hold's calendar; there is no request, thread or assignee.
 */
export type RequestlessStaffHoldContext = StaffHoldContextBase & {
  hold: BookerBookingHoldRecord | PlaceBookingHoldRecord;
  request: null;
};

export type StaffHoldContext =
  | RequestStaffHoldContext
  | RequestlessStaffHoldContext;

/**
 * Staff mutation entry: load hold → its place (through the request for a
 * REQUEST hold, through the calendar otherwise), then the STAFF gate
 * (owner / edit-role member). A booking grantee is refused here whatever
 * hold it names (FR-002); booker actions on its own holds get their own
 * entry points.
 */
export async function loadStaffHoldContext(
  repos: Repos,
  holdId: string,
  actorHumanId: string,
): Promise<StaffHoldContext> {
  const hold = await requireHold(repos, holdId);
  if (hold.ownerKind !== "REQUEST") {
    return loadRequestlessStaffHoldContext(repos, hold, actorHumanId);
  }
  return loadRequestStaffHoldContextFor(repos, hold, actorHumanId);
}

/**
 * {@link loadStaffHoldContext} for an action that only a REQUEST hold has
 * today. The staff gate runs FIRST, for every kind (a request-less hold's
 * place is read through its calendar); only an actor who passes it learns
 * that the hold is request-less, as BOOKING_HOLD_NEEDS_REQUEST. A stranger
 * gets the gate's own refusal whatever the hold's kind.
 */
export async function loadStaffRequestHoldContext(
  repos: Repos,
  holdId: string,
  actorHumanId: string,
): Promise<RequestStaffHoldContext> {
  const ctx = await loadStaffHoldContext(repos, holdId, actorHumanId);
  if (ctx.request === null) {
    // Past the gate: the actor has booking authority at this place.
    throw fail("BOOKING_HOLD_NEEDS_REQUEST", {
      meta: { holdId: ctx.hold.id, ownerKind: ctx.hold.ownerKind },
    });
  }
  return ctx;
}

/**
 * The place of a request-less hold, read through its calendar, never a
 * denormalised column (FR-001).
 */
export async function requireRequestlessHoldPlace(
  repos: Pick<Repos, "calendars" | "places">,
  hold: Pick<BookingHoldRecord, "id" | "calendarId">,
): Promise<PlaceRecord> {
  const calendar = await repos.calendars.findById(hold.calendarId);
  if (!calendar) {
    throw fail("CALENDAR_NOT_FOUND", {
      meta: { reason: "hold_calendar_missing", holdId: hold.id },
    });
  }
  return requirePlace(repos, calendar.placeId);
}

/**
 * Who OWNS a request-less hold, as the actor (holds-without-a-request H5):
 *  - a BOOKER hold → its booker: the actor acts for the hold's holder under an
 *    active grant covering the hold's calendar (`as` = the holder, item i);
 *  - a PLACE hold → the place: the STAFF gate (owner / edit-role member).
 * Null when the actor is not the owner. The owner answers a challenge on the
 * hold (release here; book is `bookRequestlessHold`, plan step 7, which reads
 * this same rule), so the two never drift.
 */
export type RequestlessHoldOwnerAuthority =
  | { kind: "booker"; booker: PlaceBookerAuthorityResult }
  | { kind: "staff"; ownership: PlaceBookingAuthorityResult };

export async function findRequestlessHoldOwnerAuthority(
  repos: Repos,
  hold: BookerBookingHoldRecord | PlaceBookingHoldRecord,
  place: PlaceRecord,
  actorHumanId: string,
  now: Date,
): Promise<RequestlessHoldOwnerAuthority | null> {
  if (hold.ownerKind === "BOOKER") {
    const own = await listPlaceBookerGrants(repos, place, actorHumanId, {
      calendarId: hold.calendarId,
      now,
      as: hold.holder,
    });
    return own[0] ? { kind: "booker", booker: own[0] } : null;
  }
  const ownership = await findPlaceBookingAuthority(repos, place, actorHumanId);
  return ownership ? { kind: "staff", ownership } : null;
}

async function loadRequestlessStaffHoldContext(
  repos: Repos,
  hold: BookerBookingHoldRecord | PlaceBookingHoldRecord,
  actorHumanId: string,
): Promise<RequestlessStaffHoldContext> {
  const place = await requireRequestlessHoldPlace(repos, hold);
  const ownership = await requirePlaceBookingAuthority(
    repos,
    place,
    actorHumanId,
  );
  return {
    hold,
    request: null,
    place,
    ownership,
    placeTz: resolveBookingTimezone(place.timezone),
    staffRecipientHint: staffRecipientHintFor({
      hold,
      request: null,
      place,
      ownership,
    }),
  };
}

async function loadRequestStaffHoldContextFor(
  repos: Repos,
  hold: RequestBookingHoldRecord,
  actorHumanId: string,
): Promise<RequestStaffHoldContext> {
  const request = requireToVenueRequest(
    await requireRequest(repos, hold.bookingRequestId),
  );
  const place = await requirePlace(repos, request.placeId);
  const ownership = await requirePlaceBookingAuthority(
    repos,
    place,
    actorHumanId,
  );
  await requireHoldCalendarAtPlace(repos, hold, request);
  return {
    hold,
    request,
    place,
    ownership,
    placeTz: resolveBookingTimezone(place.timezone),
    staffRecipientHint: staffRecipientHintFor({
      hold,
      request,
      place,
      ownership,
    }),
  };
}

export type ActHoldContext = {
  hold: RequestBookingHoldRecord;
  request: ToVenueBookingRequestRecord;
  place: PlaceRecord;
  placeTz: string;
  staffRecipientHint: BookingHoldStaffRecipientHint;
};

/** Act mutation entry: the hold must belong to a request the actor sent. */
export async function loadActHoldContext(
  repos: Repos,
  holdId: string,
  actorHumanId: string,
): Promise<ActHoldContext> {
  // An act's hold is its request's; a request-less hold has no act side.
  // There is no gate to run before knowing the request, so a request-less
  // hold reads exactly like a missing one: no existence or kind oracle.
  const found = await requireHold(repos, holdId);
  if (found.ownerKind !== "REQUEST") throw fail("BOOKING_HOLD_NOT_FOUND");
  const hold = found;
  const request = requireToVenueRequest(
    await requireRequest(repos, hold.bookingRequestId),
  );
  await ensureBookingThreadParticipant(
    repos,
    request,
    actorHumanId,
    "PERFORMER",
  );
  const place = await requirePlace(repos, request.placeId);
  await requireHoldCalendarAtPlace(repos, hold, request);
  return {
    hold,
    request,
    place,
    placeTz: resolveBookingTimezone(place.timezone),
    staffRecipientHint: staffRecipientHintFor({
      hold,
      request,
      place,
      ownership: null,
    }),
  };
}

/** Read gate for a request's holds, per viewer side (mirrors the thread). */
export async function ensureHoldReader(
  repos: Repos,
  request: BookingRequestRecord,
  actorHumanId: string,
  viewer: "staff" | "act",
): Promise<void> {
  await ensureBookingThreadReader(
    repos,
    request,
    actorHumanId,
    viewer === "staff" ? "VENUE" : "PERFORMER",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Output projections
// ─────────────────────────────────────────────────────────────────────────────

export const bookingHoldStatusSchema = z.enum([
  "ACTIVE",
  "CHALLENGED",
  "CONFIRMED",
  "RELEASED",
]);

export const isoCalendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "invalid_calendar_date");

/** The STAFF view of a hold — every column the inbox/thread/calendar needs. */
export const bookingHoldOutputSchema = z
  .object({
    id: z.uuid(),
    /**
     * holds-without-a-request FR-001: who owns the hold. A line can hold
     * every kind, so the staff view of a line carries them all.
     */
    ownerKind: z.enum(["REQUEST", "BOOKER", "PLACE"]),
    /** Null for a request-less (BOOKER / PLACE) hold. */
    bookingRequestId: z.uuid().nullable(),
    calendarId: z.uuid(),
    spaceId: z.uuid().nullable(),
    date: isoCalendarDateSchema,
    position: z.number().int().min(1),
    status: bookingHoldStatusSchema,
    respondBy: z.date().nullable(),
    placedByHumanId: z.uuid(),
    releasedReason: z
      .enum([
        "MANUAL",
        "EXPIRED",
        "CONFIRMED_OTHER",
        "REQUEST_CLOSED",
        "SIBLING_CONFIRMED",
        "PAST_DATE",
        "EVENT_SCHEDULED",
        // booking-the-night FR-009: a cancelled booking releases its
        // CONFIRMED hold. Listed so a read of such a row still parses.
        "BOOKING_CANCELLED",
        // holds-without-a-request FR-003 / FR-004: a BOOKER hold whose
        // grant was revoked or expired.
        "GRANT_ENDED",
      ])
      .nullable(),
    /**
     * Lazy-expiry projection (FR-007/FR-010): true when the pure predicate
     * says this live row is already dead (expired challenge / past date) but
     * no mutation has settled it yet. A consumer renders it as released.
     */
    lapsed: z.boolean(),
    createdAt: z.date(),
  })
  .strict();

export type BookingHoldOutput = z.infer<typeof bookingHoldOutputSchema>;

export function toBookingHoldOutput(
  hold: BookingHoldRecord,
  now: Date,
  placeTz: string,
): BookingHoldOutput {
  return {
    id: hold.id,
    ownerKind: hold.ownerKind,
    bookingRequestId: hold.ownerKind === "REQUEST" ? hold.bookingRequestId : null,
    calendarId: hold.calendarId,
    spaceId: hold.spaceId,
    date: hold.date,
    position: hold.position,
    status: hold.status,
    respondBy: hold.respondBy,
    placedByHumanId: hold.placedByHumanId,
    releasedReason: hold.releasedReason,
    lapsed: isHoldLapsed(hold, now, placeTz) !== null,
    createdAt: hold.createdAt,
  };
}

/**
 * The BOOKER view of a hold it acted on (holds-without-a-request H17): the
 * staff view without what describes the place's side or another party:
 *   - no `placedByHumanId` (a staff member, or another booker's member),
 *   - no `bookingRequestId` (another act's request).
 * A booker's reply never carries the line either: release and challenge
 * answer a booker with this one hold (`toReleaseBookingHoldWire`,
 * `toChallengeBookingHoldWire`).
 */
export const bookerBookingHoldOutputSchema = bookingHoldOutputSchema
  .omit({ placedByHumanId: true, bookingRequestId: true })
  .strict();

export type BookerBookingHoldOutput = z.infer<typeof bookerBookingHoldOutputSchema>;

/** Staff view → booker view (a projection, never a spread). */
export function toBookerBookingHoldOutput(
  hold: BookingHoldOutput,
): BookerBookingHoldOutput {
  return {
    id: hold.id,
    ownerKind: hold.ownerKind,
    calendarId: hold.calendarId,
    spaceId: hold.spaceId,
    date: hold.date,
    position: hold.position,
    status: hold.status,
    respondBy: hold.respondBy,
    releasedReason: hold.releasedReason,
    lapsed: hold.lapsed,
    createdAt: hold.createdAt,
  };
}

/**
 * What a booker may see of ANOTHER party's hold it acted on (a challenge of
 * the 1st hold, H17): where and when, its place in line, and how it stands.
 * Nothing about who placed it, when, on which space, or whose it is (no
 * `ownerKind`, `createdAt`, `spaceId`, placer, request or holder).
 */
export const bookerForeignHoldOutputSchema = z
  .object({
    id: z.uuid(),
    calendarId: z.uuid(),
    date: isoCalendarDateSchema,
    position: z.number().int().min(1),
    status: bookingHoldStatusSchema,
    respondBy: z.date().nullable(),
  })
  .strict();

export type BookerForeignHoldOutput = z.infer<typeof bookerForeignHoldOutputSchema>;

/** Staff view → a booker's view of another party's hold (a projection). */
export function toBookerForeignHoldOutput(
  hold: BookingHoldOutput,
): BookerForeignHoldOutput {
  return {
    id: hold.id,
    calendarId: hold.calendarId,
    date: hold.date,
    position: hold.position,
    status: hold.status,
    respondBy: hold.respondBy,
  };
}

/** Who acted on a hold: shapes the wire reply (H17). */
export const holdActorViewSchema = z.enum(["staff", "booker"]);

/**
 * The ACT view of ITS OWN hold (FR-013): date / position / status / deadline
 * / lapsed — and NOTHING that describes the venue's side of the line:
 *   - no `placedByHumanId` (a staff member),
 *   - no `calendarId` (the venue's calendar structure) — the same rule nulls
 *     `calendarId` on the inbox hold summary for PERFORMER scopes and keeps
 *     it off the `booking_hold.placed` ledger payload,
 *   - no sibling rows, no line length, no other act's id.
 * Every act-facing surface (the sent-request list, the performer thread
 * strip, the challenge answer's wire output) projects through this.
 *
 * booking-the-night P2d-2 (N19 / FR-014) — the act's panel says what Keep
 * will do BEFORE they tap it, from the act's OWN terms only:
 *   - `keepWill`: on a CHALLENGED hold, `book_now` (their terms for this
 *     night are sent: Keep agrees them and books) or `ask_for_terms` (Keep
 *     asks the venue for terms); null on any other status;
 *   - `kept`: they already kept THIS challenge and are waiting for terms
 *     (the deadline is `respondBy`).
 */
export const actBookingHoldOutputSchema = z
  .object({
    id: z.uuid(),
    date: isoCalendarDateSchema,
    position: z.number().int().min(1),
    status: bookingHoldStatusSchema,
    respondBy: z.date().nullable(),
    lapsed: z.boolean(),
    keepWill: z.enum(["book_now", "ask_for_terms"]).nullable(),
    kept: z.boolean(),
  })
  .strict();

export type ActBookingHoldOutput = z.infer<typeof actBookingHoldOutputSchema>;

/** The act-side challenge facts (see `resolveActChallengeView`). */
export type ActChallengeView = {
  keepWill: "book_now" | "ask_for_terms" | null;
  kept: boolean;
};

export const NO_ACT_CHALLENGE_VIEW: ActChallengeView = {
  keepWill: null,
  kept: false,
};

export function toActBookingHoldOutput(
  hold: BookingHoldRecord,
  now: Date,
  placeTz: string,
  challenge: ActChallengeView = NO_ACT_CHALLENGE_VIEW,
): ActBookingHoldOutput {
  const lapsed = isHoldLapsed(hold, now, placeTz) !== null;
  // Only a live, unlapsed challenge has a Keep to describe.
  const open = hold.status === "CHALLENGED" && !lapsed;
  return {
    id: hold.id,
    date: hold.date,
    position: hold.position,
    status: hold.status,
    respondBy: hold.respondBy,
    lapsed,
    keepWill: open ? challenge.keepWill : null,
    kept: open ? challenge.kept : false,
  };
}

/**
 * Zod-style `invalid_input` for a field-level rule the schema cannot express
 * statically (same shape `respond-to-booking-request` throws for its
 * direction-dependent decline reason).
 */
export function failInvalidField(path: string, message: string): never {
  throw {
    code: "invalid_input",
    message: "invalid_input",
    issues: [{ code: "custom", message, path: [path] }],
  } as const;
}
