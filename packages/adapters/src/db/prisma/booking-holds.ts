import { Prisma, type $Enums } from "@prisma/client";
import type {
  BookerBookingHoldRecord,
  BookingHoldHolder,
  BookingHoldOwnerKind,
  BookingHoldReleaseReason,
  BookingHoldRecord,
  BookingHoldStatus,
  BookingHoldsRepo,
  PlaceBookingHoldRecord,
  RequestBookingHoldRecord,
} from "@th/ports/repos/booking-holds";
import { LIVE_BOOKING_HOLD_STATUSES } from "@th/ports/repos/booking-holds";

import { NOTE_SELECT, writeNote } from "./note-columns";
import type { PrismaClientOrTx } from "./types";

// Compile-time parity guard (same posture as entity-reports.ts): the port's
// string unions and the Prisma enums must stay literal-for-literal identical
// in BOTH directions, so the `as` casts in mapRecord are shape-preserving.
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;
const _statusParity: MutuallyAssignable<
  BookingHoldStatus,
  $Enums.BookingHoldStatus
> = true;
const _reasonParity: MutuallyAssignable<
  BookingHoldReleaseReason,
  $Enums.BookingHoldReleaseReason
> = true;
const _ownerKindParity: MutuallyAssignable<
  BookingHoldOwnerKind,
  $Enums.BookingHoldOwnerKind
> = true;
void _statusParity;
void _reasonParity;
void _ownerKindParity;

export const BOOKING_HOLD_SELECT = {
  id: true,
  ownerKind: true,
  bookingRequestId: true,
  calendarId: true,
  spaceId: true,
  date: true,
  position: true,
  status: true,
  placedByHumanId: true,
  challengedAt: true,
  respondBy: true,
  releasedAt: true,
  releasedReason: true,
  confirmedAt: true,
  grantId: true,
  holderOrgId: true,
  holderHumanId: true,
  eventId: true,
  ...NOTE_SELECT,
  createdAt: true,
  updatedAt: true,
  // A BOOKER hold's grant end facts (FR-004 lazy lapse, GRANT_ENDED): read
  // with the hold so every surface sees a revoked / expired grant without a
  // second query. Null on REQUEST / PLACE rows (no grant).
  grant: { select: { revokedAt: true, expiresAt: true } },
} as const;

/**
 * Live-line ordering: position asc, then createdAt/id as deterministic
 * tiebreakers (positions are unique per live line by construction, but a
 * half-renumbered line under a crashed tx must still list stably).
 */
const LINE_ORDER = [
  { position: "asc" },
  { createdAt: "asc" },
  { id: "asc" },
] as const satisfies Prisma.BookingHoldOrderByWithRelationInput[];

const LIVE = [...LIVE_BOOKING_HOLD_STATUSES];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `date` is a Postgres DATE (no time, no zone). Prisma surfaces it as a JS
 * Date at UTC midnight and, on write, stores the UTC calendar day of the Date
 * it is given — so the ONLY safe round trip is ISO `YYYY-MM-DD` ↔ UTC
 * midnight. A local-midnight Date west of Greenwich would land as the
 * previous day; these two helpers are the single choke point.
 */
export function isoDateToDb(iso: string): Date {
  if (!ISO_DATE.test(iso)) {
    throw new Error(
      `booking_hold_date_invalid: expected YYYY-MM-DD, got "${iso}"`,
    );
  }
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  // Round-trip check rejects impossible days ("2026-02-30" parses as Mar 2;
  // "2026-13-01" is NaN) so a typo never lands on a neighbouring date.
  if (Number.isNaN(parsed.getTime()) || dbDateToIso(parsed) !== iso) {
    throw new Error(
      `booking_hold_date_invalid: not a real calendar day "${iso}"`,
    );
  }
  return parsed;
}

export function dbDateToIso(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** The row shape `BOOKING_HOLD_SELECT` returns. */
export type BookingHoldRow = {
  id: string;
  ownerKind: string;
  bookingRequestId: string | null;
  calendarId: string;
  spaceId: string | null;
  date: Date;
  position: number;
  status: string;
  placedByHumanId: string;
  challengedAt: Date | null;
  respondBy: Date | null;
  releasedAt: Date | null;
  releasedReason: string | null;
  confirmedAt: Date | null;
  grantId: string | null;
  holderOrgId: string | null;
  holderHumanId: string | null;
  eventId: string | null;
  note: string | null;
  noteUpdatedByHumanId: string | null;
  noteUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  grant: { revokedAt: Date | null; expiresAt: Date | null } | null;
};

function shapeBreach(row: BookingHoldRow, why: string): Error {
  return new Error(
    `booking_hold_owner_kind_shape: hold ${row.id} (${row.ownerKind}) ${why}`,
  );
}

/** The holder pair → the holder union; both null → null. */
function holderOf(row: BookingHoldRow): BookingHoldHolder | null {
  if (row.holderOrgId !== null && row.holderHumanId !== null) {
    throw shapeBreach(row, "names both an org and a person");
  }
  if (row.holderOrgId !== null) return { kind: "org", orgId: row.holderOrgId };
  if (row.holderHumanId !== null) {
    return { kind: "person", humanId: row.holderHumanId };
  }
  return null;
}

/**
 * Row → the owner-kind union (FR-001). The CHECK
 * "BookingHold_owner_kind_shape" makes every branch's columns certain; a row
 * that breaks it anyway (a hand-written UPDATE, a dropped CHECK) throws
 * rather than reach core as a hold of the wrong kind.
 */
export const mapBookingHoldRecord = (row: BookingHoldRow): BookingHoldRecord => {
  const base = {
    id: row.id,
    calendarId: row.calendarId,
    spaceId: row.spaceId ?? null,
    date: dbDateToIso(row.date),
    position: row.position,
    status: row.status as BookingHoldStatus,
    placedByHumanId: row.placedByHumanId,
    challengedAt: row.challengedAt ?? null,
    respondBy: row.respondBy ?? null,
    releasedAt: row.releasedAt ?? null,
    releasedReason:
      (row.releasedReason as BookingHoldReleaseReason | null) ?? null,
    confirmedAt: row.confirmedAt ?? null,
    eventId: row.eventId ?? null,
    note: row.note ?? null,
    noteUpdatedByHumanId: row.noteUpdatedByHumanId ?? null,
    noteUpdatedAt: row.noteUpdatedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  switch (row.ownerKind) {
    case "REQUEST": {
      if (row.bookingRequestId === null) {
        throw shapeBreach(row, "has no request");
      }
      if (row.grantId !== null || holderOf(row) !== null) {
        throw shapeBreach(row, "carries a grant or holder");
      }
      return {
        ...base,
        ownerKind: "REQUEST",
        bookingRequestId: row.bookingRequestId,
      } satisfies RequestBookingHoldRecord;
    }
    case "BOOKER": {
      const holder = holderOf(row);
      if (row.grantId === null || holder === null || row.grant === null) {
        throw shapeBreach(row, "has no grant or no holder");
      }
      if (row.bookingRequestId !== null) {
        throw shapeBreach(row, "has a request");
      }
      return {
        ...base,
        ownerKind: "BOOKER",
        grantId: row.grantId,
        holder,
        grantRevokedAt: row.grant.revokedAt ?? null,
        grantExpiresAt: row.grant.expiresAt ?? null,
      } satisfies BookerBookingHoldRecord;
    }
    case "PLACE": {
      if (row.bookingRequestId !== null || row.grantId !== null) {
        throw shapeBreach(row, "has a request or a grant");
      }
      return {
        ...base,
        ownerKind: "PLACE",
        holder: holderOf(row),
      } satisfies PlaceBookingHoldRecord;
    }
    default:
      throw new Error(
        `booking_hold_owner_kind_unsupported: hold ${row.id} is ${row.ownerKind}`,
      );
  }
};

/**
 * For request-scoped reads (their WHERE has `ownerKind: "REQUEST"`): map and
 * assert the kind, so the read's narrower return type is checked, not cast.
 */
function mapRequestHold(row: BookingHoldRow): RequestBookingHoldRecord {
  const record = mapBookingHoldRecord(row);
  if (record.ownerKind !== "REQUEST") {
    throw new Error(
      `booking_hold_owner_kind_unexpected: hold ${row.id} is ${record.ownerKind} in a request read`,
    );
  }
  return record;
}

const STATUS_CHANGED = {
  code: "conflict",
  message: "booking_hold_status_changed",
} as const;

/**
 * A Postgres deadlock (40P01) or serialization failure (40001) — Prisma
 * surfaces the interactive-tx form as P2034 and the raw-query form as an
 * unknown request error carrying the SQLSTATE. Core treats both like a line
 * that changed under it: roll back, re-read, retry (HOLD_LINE_CHANGED).
 * Sorted advisory locking in core makes the hold code itself cycle-free;
 * this covers cycles with locks the hold code does not own.
 */
function isDeadlockOrSerializationFailure(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === "P2034";
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    // Prisma's unknown-request message carries the SQLSTATE as "Code: `40P01`".
    return /Code: `(40P01|40001)`/.test(error.message);
  }
  return false;
}

const LINE_CHANGED = {
  code: "conflict",
  message: "booking_hold_line_changed",
} as const;

function rethrowMapped(error: unknown): never {
  if (isDeadlockOrSerializationFailure(error)) {
    throw { ...LINE_CHANGED, cause: error } as const;
  }
  throw error;
}

async function refetch(
  p: PrismaClientOrTx,
  id: string,
): Promise<BookingHoldRecord> {
  const row = await p.bookingHold.findUniqueOrThrow({
    where: { id },
    select: BOOKING_HOLD_SELECT,
  });
  return mapBookingHoldRecord(row);
}

/**
 * Line-scoped TRANSACTION advisory lock, taken by `create` and `renumberLine`
 * (precedent: tickets.lockAndCountCapacityForTicketType). Row locks (`FOR
 * UPDATE`) can't block an INSERT, so without this a create racing a renumber
 * leaves the line at {1,3} or with a duplicate 3; and a transition that
 * row-locks one hold before renumbering the whole line would form a lock
 * cycle with a concurrent renumber (raw 40P01). Keyed on the VALIDATED ISO
 * day string, namespaced so it cannot collide with another feature hashing
 * the same uuid. Released on commit — meaningless outside repos.tx().
 */
async function lockLine(
  p: PrismaClientOrTx,
  calendarId: string,
  isoDate: string,
): Promise<void> {
  await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking_hold_line:${calendarId}|${isoDate}`}))`;
}

export function makeBookingHoldsRepo(p: PrismaClientOrTx): BookingHoldsRepo {
  return {
    async create(input) {
      // Validate before locking so a bad date never reaches the lock key.
      const dbDate = isoDateToDb(input.date);
      await lockLine(p, input.calendarId, input.date);
      try {
        const row = await p.bookingHold.create({
          data: {
            bookingRequestId: input.bookingRequestId,
            calendarId: input.calendarId,
            spaceId: input.spaceId ?? null,
            date: dbDate,
            position: input.position,
            placedByHumanId: input.placedByHumanId,
          },
          select: BOOKING_HOLD_SELECT,
        });
        return mapRequestHold(row);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          // P2002 on create can only come from the SQL-only partial unique
          // "BookingHold_live_request_date_key" ON (bookingRequestId,
          // calendarId, date) WHERE status IN ('ACTIVE','CHALLENGED')
          // (migration 20260825130000): `id` is a fresh uuid and a fresh row
          // is never CONFIRMED, so the confirmed-line unique can't fire here.
          // One LIVE hold per request per calendar-day; a released date can
          // be re-held. Map the race loser to a domain error so a raw P2002
          // never leaks through the port.
          if (error.code === "P2002") {
            throw {
              code: "conflict",
              message: "booking_hold_exists",
              cause: error,
            } as const;
          }
          // FK violation (P2003): the request / calendar / space vanished
          // between the caller's check and this insert (precedent:
          // agreements.setDraftEvent → draft_event_missing).
          if (error.code === "P2003") {
            throw {
              code: "conflict",
              message: "booking_hold_target_missing",
              cause: error,
            } as const;
          }
        }
        rethrowMapped(error);
      }
    },

    async createRequestless(input) {
      // Same order as `create`: validate, then the line lock, then insert.
      const dbDate = isoDateToDb(input.date);
      await lockLine(p, input.calendarId, input.date);
      const holder = input.holder;
      try {
        const row = await p.bookingHold.create({
          data: {
            ownerKind: input.ownerKind,
            grantId: input.ownerKind === "BOOKER" ? input.grantId : null,
            holderOrgId: holder?.kind === "org" ? holder.orgId : null,
            holderHumanId: holder?.kind === "person" ? holder.humanId : null,
            calendarId: input.calendarId,
            spaceId: input.spaceId ?? null,
            date: dbDate,
            position: input.position,
            placedByHumanId: input.placedByHumanId,
            ...(input.note
              ? {
                  note: input.note,
                  noteUpdatedByHumanId: input.placedByHumanId,
                  noteUpdatedAt: input.now,
                }
              : {}),
          },
          select: BOOKING_HOLD_SELECT,
        });
        const record = mapBookingHoldRecord(row);
        if (record.ownerKind === "REQUEST") {
          throw new Error(
            `booking_hold_owner_kind_unexpected: hold ${row.id} is REQUEST from createRequestless`,
          );
        }
        return record;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          // P2002 on this insert can only come from the holder partial
          // uniques "BookingHold_live_holder_org_line_key" /
          // "BookingHold_live_holder_human_line_key" (migration
          // 20261015140000): `id` is fresh, the row is not CONFIRMED (so not
          // the confirmed-line key) and has no request (so not the live
          // request key). One LIVE hold per holder per line.
          if (error.code === "P2002") {
            throw {
              code: "conflict",
              message: "booking_hold_holder_exists",
              cause: error,
            } as const;
          }
          // The calendar / space / grant / holder org vanished between the
          // caller's check and this insert.
          if (error.code === "P2003") {
            throw {
              code: "conflict",
              message: "booking_hold_target_missing",
              cause: error,
            } as const;
          }
        }
        rethrowMapped(error);
      }
    },

    async getById(id) {
      const row = await p.bookingHold.findUnique({
        where: { id },
        select: BOOKING_HOLD_SELECT,
      });
      return row ? mapBookingHoldRecord(row) : null;
    },

    async listForRequest(bookingRequestId) {
      const rows = await p.bookingHold.findMany({
        where: { ownerKind: "REQUEST", bookingRequestId },
        orderBy: LINE_ORDER,
        select: BOOKING_HOLD_SELECT,
      });
      return rows.map(mapRequestHold);
    },

    async listLiveForRequests(bookingRequestIds) {
      if (bookingRequestIds.length === 0) return [];
      const rows = await p.bookingHold.findMany({
        where: {
          ownerKind: "REQUEST",
          bookingRequestId: { in: [...bookingRequestIds] },
          status: { in: LIVE },
        },
        orderBy: [{ bookingRequestId: "asc" }, { date: "asc" }, ...LINE_ORDER],
        select: BOOKING_HOLD_SELECT,
      });
      return rows.map(mapRequestHold);
    },

    async listRequestIdsWithConfirmedHold(bookingRequestIds) {
      if (bookingRequestIds.length === 0) return [];
      const rows = await p.bookingHold.findMany({
        where: {
          ownerKind: "REQUEST",
          bookingRequestId: { in: [...bookingRequestIds] },
          status: "CONFIRMED",
        },
        distinct: ["bookingRequestId"],
        select: { bookingRequestId: true },
      });
      // The `in` filter already excludes NULL; this narrows the column type.
      return rows.flatMap((row) =>
        row.bookingRequestId === null ? [] : [row.bookingRequestId],
      );
    },

    async lockLine({ calendarId, date }) {
      // Validate before locking so a bad date never reaches the lock key
      // (same order as `create`).
      isoDateToDb(date);
      await lockLine(p, calendarId, date);
    },

    async lockRequestBooking(bookingRequestId) {
      // Transaction-scoped (port doc): only serializes when `p` is the tx
      // client. Its own key namespace, so it never collides with a line key
      // or the bill lock. The key is a bound parameter (tagged template).
      await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking_request_booking:${bookingRequestId}`}))`;
    },

    async listLine({ calendarId, date, statuses }) {
      const rows = await p.bookingHold.findMany({
        where: {
          calendarId,
          date: isoDateToDb(date),
          status: { in: statuses ? [...statuses] : LIVE },
        },
        orderBy: LINE_ORDER,
        select: BOOKING_HOLD_SELECT,
      });
      return rows.map(mapBookingHoldRecord);
    },

    async listLineWithTerms({ calendarId, date, statuses }) {
      // Same WHERE / ORDER as `listLine`; the terms ride the request's
      // one-to-one agreement link (BookingRequest.agreementId is unique).
      const rows = await p.bookingHold.findMany({
        where: {
          calendarId,
          date: isoDateToDb(date),
          status: { in: statuses ? [...statuses] : LIVE },
        },
        orderBy: LINE_ORDER,
        select: {
          ...BOOKING_HOLD_SELECT,
          bookingRequest: {
            select: {
              agreement: {
                select: { id: true, status: true, proposedDate: true },
              },
            },
          },
        },
      });
      return rows.map(({ bookingRequest, ...row }) => {
        const agreement = bookingRequest?.agreement ?? null;
        return {
          ...mapBookingHoldRecord(row),
          terms: agreement
            ? {
                agreementId: agreement.id,
                status: agreement.status,
                proposedDate: agreement.proposedDate ?? null,
              }
            : null,
        };
      });
    },

    async listLiveForPlaceRange({ placeId, from, to, statuses }) {
      const rows = await p.bookingHold.findMany({
        where: {
          // Joins through Calendar.placeId — holds carry no placeId of their
          // own, and a Calendar cascades its holds, so the relation filter is
          // exact (never stale).
          calendar: { placeId },
          date: { gte: isoDateToDb(from), lte: isoDateToDb(to) },
          status: { in: statuses ? [...statuses] : LIVE },
        },
        orderBy: [{ date: "asc" }, { calendarId: "asc" }, ...LINE_ORDER],
        select: BOOKING_HOLD_SELECT,
      });
      return rows.map(mapBookingHoldRecord);
    },

    async listLiveForCalendarRange({ calendarId, from, to, statuses }) {
      const rows = await p.bookingHold.findMany({
        where: {
          calendarId,
          date: { gte: isoDateToDb(from), lte: isoDateToDb(to) },
          status: { in: statuses ? [...statuses] : LIVE },
        },
        orderBy: [{ date: "asc" }, ...LINE_ORDER],
        select: BOOKING_HOLD_SELECT,
      });
      return rows.map(mapBookingHoldRecord);
    },

    async listForRequester({ ownerType, ownerId, statuses }) {
      const rows = await p.bookingHold.findMany({
        where: {
          ownerKind: "REQUEST",
          status: { in: statuses ? [...statuses] : LIVE },
          // THE TENANT BOUNDARY (event-calendar-redesign FR-004, spec risk
          // "scopes on the requester id at the SQL level, never filtered
          // client-side"): the hold's request must be owned by exactly this
          // performer pair. `direction: TO_VENUE` mirrors
          // booking-requests.listForPerformer — the pair also names the
          // TARGET act on TO_PERFORMER rows (which own no holds by
          // construction, but the scope is load-bearing, not incidental).
          bookingRequest: {
            direction: "TO_VENUE",
            performerOwnerType: ownerType,
            performerOwnerId: ownerId,
          },
        },
        orderBy: [{ date: "asc" }, { calendarId: "asc" }, ...LINE_ORDER],
        select: {
          ...BOOKING_HOLD_SELECT,
          bookingRequest: { select: { actName: true } },
          // Holds carry no placeId; the venue context rides the Calendar →
          // Place relation (same join listLiveForPlaceRange filters on).
          calendar: {
            select: {
              placeId: true,
              place: { select: { name: true, timezone: true } },
            },
          },
        },
      });
      return rows.map(({ bookingRequest, calendar, ...row }) => ({
        // The WHERE keeps REQUEST rows only, and a REQUEST row always has
        // its request (CHECK "BookingHold_owner_kind_shape"); `?.` only
        // satisfies the nullable relation type.
        ...mapRequestHold(row),
        placeId: calendar.placeId,
        placeName: calendar.place.name,
        placeTimezone: calendar.place.timezone ?? null,
        requestActName: bookingRequest?.actName ?? null,
      }));
    },

    async updateStatus(input) {
      // State-coupled fields (port doc): unless the caller passed a value,
      // each is NULL outside the status it belongs to. The CHECK
      // "BookingHold_respondBy_challenged_check" backstops respondBy.
      const data: Prisma.BookingHoldUncheckedUpdateManyInput = {
        status: input.status,
        // Discriminated union: CHALLENGED carries a mandatory respondBy,
        // every other target writes NULL (biconditional CHECK).
        respondBy: input.status === "CHALLENGED" ? input.respondBy : null,
        confirmedAt:
          input.confirmedAt !== undefined
            ? input.confirmedAt
            : input.status === "CONFIRMED"
              ? undefined
              : null,
        releasedAt:
          input.releasedAt !== undefined
            ? input.releasedAt
            : input.status === "RELEASED"
              ? undefined
              : null,
        releasedReason:
          input.releasedReason !== undefined
            ? input.releasedReason
            : input.status === "RELEASED"
              ? undefined
              : null,
      };
      if (input.challengedAt !== undefined)
        data.challengedAt = input.challengedAt;

      try {
        // Guarded compare-and-swap (mirrors agreements/booking-requests
        // `updateStatus`): under READ COMMITTED an in-tx re-read takes no
        // lock, so the status WHERE must travel with the write. Two
        // concurrent confirms on the SAME row → the second UPDATE waits on
        // the row lock, re-evaluates its WHERE against the committed
        // CONFIRMED status, matches zero rows, and surfaces as a conflict.
        // Two concurrent confirms on DIFFERENT rows of one line → the second
        // trips "BookingHold_confirmed_line_key" (P2002) below. Together:
        // NFR-002 at both row and line level.
        const result = await p.bookingHold.updateMany({
          where: { id: input.id, status: { in: [...input.expectedFrom] } },
          data,
        });
        if (result.count === 0) {
          throw STATUS_CHANGED;
        }
      } catch (error) {
        // Blanket P2002 → line_confirmed is safe today: besides the
        // confirmed-line key, every unique on the table (the LIVE request
        // key, the two LIVE holder keys of holds-without-a-request) is
        // partial on the live statuses, and no transition re-enters the
        // live predicate from outside it (RELEASED/CONFIRMED are terminal;
        // keep is CHALLENGED → ACTIVE, already live). If a resurrect
        // transition is ever added, branch on `error.meta.target` here.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw {
            code: "conflict",
            message: "booking_hold_line_confirmed",
            cause: error,
          } as const;
        }
        rethrowMapped(error);
      }
      return refetch(p, input.id);
    },

    async renumberLine({ calendarId, date, orderedIds }) {
      try {
        return await renumberLineUnmapped(p, { calendarId, date, orderedIds });
      } catch (error) {
        rethrowMapped(error);
      }
    },

    async setRespondBy(input) {
      try {
        const result = await p.bookingHold.updateMany({
          where: { id: input.id, status: input.expectedStatus },
          data: { respondBy: input.respondBy },
        });
        if (result.count === 0) {
          throw STATUS_CHANGED;
        }
      } catch (error) {
        // Same deadlock/serialization mapping as `updateStatus`, so core's
        // `casHoldRespondBy` sees one shape (STATUS_CHANGED passes through).
        rethrowMapped(error);
      }
      return refetch(p, input.id);
    },

    async listLiveForGrant(grantId) {
      const rows = await p.bookingHold.findMany({
        where: { ownerKind: "BOOKER", grantId, status: { in: LIVE } },
        orderBy: [{ date: "asc" }, { calendarId: "asc" }, { position: "asc" }],
        select: BOOKING_HOLD_SELECT,
      });
      return rows.map((row) => {
        const record = mapBookingHoldRecord(row);
        if (record.ownerKind !== "BOOKER") {
          throw shapeBreach(row, "listLiveForGrant read a non-BOOKER row");
        }
        return record;
      });
    },

    async convertBookerHoldToPlace({ id, grantId }) {
      try {
        // CAS: still a LIVE BOOKER hold on this grant. The holder columns
        // stay; PLACE carries no grant (CHECK "BookingHold_owner_kind_shape").
        const result = await p.bookingHold.updateMany({
          where: { id, ownerKind: "BOOKER", grantId, status: { in: LIVE } },
          data: { ownerKind: "PLACE", grantId: null },
        });
        if (result.count === 0) return null;
      } catch (error) {
        rethrowMapped(error);
      }
      const record = await refetch(p, id);
      if (record.ownerKind !== "PLACE") {
        throw new Error(
          `booking_hold_owner_kind_unexpected: hold ${id} is ${record.ownerKind} after convertBookerHoldToPlace`,
        );
      }
      return record;
    },

    async clearPlaceHolder({ id, holder }) {
      try {
        // CAS: still a LIVE PLACE hold naming exactly this holder. Only the
        // holder columns change; position, status, challenge and note stay
        // (an unassigned PLACE hold satisfies "BookingHold_owner_kind_shape").
        const result = await p.bookingHold.updateMany({
          where: {
            id,
            ownerKind: "PLACE",
            status: { in: LIVE },
            ...(holder.kind === "org"
              ? { holderOrgId: holder.orgId }
              : { holderHumanId: holder.humanId }),
          },
          data: { holderOrgId: null, holderHumanId: null },
        });
        if (result.count === 0) return null;
      } catch (error) {
        rethrowMapped(error);
      }
      const record = await refetch(p, id);
      if (record.ownerKind !== "PLACE") {
        throw new Error(
          `booking_hold_owner_kind_unexpected: hold ${id} is ${record.ownerKind} after clearPlaceHolder`,
        );
      }
      return record;
    },

    async setNote(input) {
      return writeNote(
        {
          update: async (where, data) =>
            (
              await p.bookingHold.updateMany({
                where: { id: input.id, ...where },
                data,
              })
            ).count,
          read: () =>
            p.bookingHold.findUnique({
              where: { id: input.id },
              select: NOTE_SELECT,
            }),
        },
        input,
      );
    },
  } satisfies BookingHoldsRepo;
}

async function renumberLineUnmapped(
  p: PrismaClientOrTx,
  {
    calendarId,
    date,
    orderedIds,
  }: Parameters<BookingHoldsRepo["renumberLine"]>[0],
): Promise<BookingHoldRecord[]> {
  const dbDate = isoDateToDb(date);
  // 1. Line advisory lock (shared with `create`) — see lockLine.
  await lockLine(p, calendarId, date);
  // 2. Row locks on the line's live rows (port doc: MUST be inside
  // repos.tx()). A renumber racing a release/challenge on one of these
  // rows serialises here; the findMany below then sees the settled
  // membership. Parameterised — never string-built. The VALIDATED ISO
  // STRING is bound and cast (`::date`), not a JS Date: a Date binds as
  // timestamptz and its day depends on the session TZ, and a silent
  // mismatch would return zero rows and lock nothing.
  await p.$queryRaw`
        SELECT "id" FROM "BookingHold"
        WHERE "calendarId" = ${calendarId}
          AND "date" = ${date}::date
          AND "status" IN ('ACTIVE', 'CHALLENGED')
        ORDER BY "id"
        FOR UPDATE
      `;
  // Single ordered read of the live line INSIDE the caller's tx; positions
  // are rewritten wholesale from it (spec risk: "never arithmetic on
  // positions").
  const live = await p.bookingHold.findMany({
    where: { calendarId, date: dbDate, status: { in: LIVE } },
    select: { id: true },
  });
  const liveIds = new Set(live.map((row) => row.id));
  const requested = new Set(orderedIds);
  const sameSet =
    requested.size === orderedIds.length &&
    requested.size === liveIds.size &&
    [...requested].every((id) => liveIds.has(id));
  if (!sameSet) {
    throw {
      code: "conflict",
      message: "booking_hold_line_changed",
    } as const;
  }

  // Sequential (not Promise.all): `p` may be an interactive-tx client,
  // and each write is re-scoped to the line so a row that left the line
  // between the read above and this write is skipped, not renumbered.
  for (let i = 0; i < orderedIds.length; i += 1) {
    await p.bookingHold.updateMany({
      where: {
        id: orderedIds[i]!,
        calendarId,
        date: dbDate,
        status: { in: LIVE },
      },
      data: { position: i + 1 },
    });
  }

  const rows = await p.bookingHold.findMany({
    where: { calendarId, date: dbDate, status: { in: LIVE } },
    orderBy: LINE_ORDER,
    select: BOOKING_HOLD_SELECT,
  });
  return rows.map(mapBookingHoldRecord);
}
