import type { Prisma, PlaceBookingGrant } from "@prisma/client";
import type {
  PlaceBookingGrantee,
  PlaceBookingGrantRecord,
  PlaceBookingGrantsRepo,
  RespondToPlaceBookingGrantInput,
} from "@th/ports/repos/place-booking-grants";

import type { PrismaClientOrTx } from "./types";

/**
 * Per-place booking grants (holds-without-a-request spec 2026-09-30, FR-002
 * / FR-003 / FR-004). ACTIVE = accepted AND not declined AND not revoked AND
 * not expired; `activeWhere` is the one place that says so in SQL.
 */
function activeWhere(now: Date): Prisma.PlaceBookingGrantWhereInput {
  return {
    acceptedAt: { not: null },
    declinedAt: null,
    revokedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

/**
 * Calendar scope: an action on a calendar is covered by a whole-place grant
 * or a grant on that calendar; a place-level action (null) by whole-place
 * grants only. Wrapped in AND so it never collides with `activeWhere`'s OR.
 */
function scopeWhere(
  calendarId: string | null | undefined,
): Prisma.PlaceBookingGrantWhereInput {
  return calendarId
    ? { AND: [{ OR: [{ calendarId: null }, { calendarId }] }] }
    : { calendarId: null };
}

/** Whole-place first (broader authority), then the oldest grant: stable. */
const PREFER_WHOLE_PLACE = [
  { calendarId: { sort: "asc", nulls: "first" } },
  { createdAt: "asc" },
  { id: "asc" },
] as const satisfies Prisma.PlaceBookingGrantOrderByWithRelationInput[];

const NEWEST_FIRST = [
  { createdAt: "desc" },
  { id: "desc" },
] as const satisfies Prisma.PlaceBookingGrantOrderByWithRelationInput[];

/** Grantee IN the caller-resolved sets; null when both sets are empty. */
function granteeIn(
  humanIds: readonly string[],
  orgIds: readonly string[],
): Prisma.PlaceBookingGrantWhereInput | null {
  const arms: Prisma.PlaceBookingGrantWhereInput[] = [];
  if (humanIds.length > 0) arms.push({ granteeHumanId: { in: [...humanIds] } });
  if (orgIds.length > 0) arms.push({ granteeOrgId: { in: [...orgIds] } });
  if (arms.length === 0) return null;
  return { AND: [{ OR: arms }] };
}

const NOT_PENDING = {
  code: "conflict",
  message: "place_booking_grant_not_pending",
} as const;

const NOT_FOUND = {
  code: "not_found",
  message: "place_booking_grant_not_found",
} as const;

const CALENDAR_MISMATCH = {
  code: "grant_calendar_place_mismatch",
  message: "grant_calendar_place_mismatch",
} as const;

export function makePlaceBookingGrantsRepo(
  p: PrismaClientOrTx,
): PlaceBookingGrantsRepo {
  /**
   * A calendar-scoped grant must scope to one of THIS place's calendars —
   * the FK alone would happily bind another place's calendar.
   */
  async function assertCalendarAtPlace(
    placeId: string,
    calendarId: string,
  ): Promise<void> {
    const calendar = await p.calendar.findUnique({
      where: { id: calendarId },
      select: { placeId: true },
    });
    if (!calendar || calendar.placeId !== placeId) throw CALENDAR_MISMATCH;
  }

  /**
   * Pending → accepted | declined, CAS on still pending, scoped to the
   * grantee: a grant given to someone outside the caller-resolved sets
   * matches nothing in either query, so it reads as not_found (never
   * not_pending, which would confirm the id exists) and is left unchanged.
   */
  async function respond(
    input: RespondToPlaceBookingGrantInput,
    data: { acceptedAt: Date } | { declinedAt: Date },
  ): Promise<PlaceBookingGrantRecord> {
    const grantee = granteeIn(input.humanIds, input.orgIds);
    if (!grantee) throw NOT_FOUND;
    const result = await p.placeBookingGrant.updateMany({
      where: {
        id: input.id,
        acceptedAt: null,
        declinedAt: null,
        revokedAt: null,
        // A pending grant past its expiry can never become active: the CAS
        // refuses it (not_pending) even if the caller's read was earlier.
        OR: [{ expiresAt: null }, { expiresAt: { gt: input.now } }],
        // granteeIn already wraps its OR in AND, so it spreads safely.
        ...grantee,
      },
      data,
    });
    const row = await p.placeBookingGrant.findFirst({
      where: { id: input.id, ...grantee },
    });
    if (!row) throw NOT_FOUND;
    if (result.count === 0) throw NOT_PENDING;
    return toRecord(row);
  }

  return {
    async findActiveForActor({ placeId, calendarId, humanIds, orgIds, now }) {
      const grantee = granteeIn(humanIds, orgIds);
      if (!grantee) return null;
      // Three ANDed arms (grantee, scope, active) each wrap their OR, so
      // none overwrites another's.
      const row = await p.placeBookingGrant.findFirst({
        where: {
          placeId,
          ...activeWhere(now),
          AND: [grantee, scopeWhere(calendarId)],
        },
        orderBy: PREFER_WHOLE_PLACE,
      });
      return row ? toRecord(row) : null;
    },

    async listActiveForActor({ placeId, calendarId, humanIds, orgIds, now }) {
      const grantee = granteeIn(humanIds, orgIds);
      if (!grantee) return [];
      const rows = await p.placeBookingGrant.findMany({
        where: {
          placeId,
          ...activeWhere(now),
          AND: [grantee, scopeWhere(calendarId)],
        },
        orderBy: PREFER_WHOLE_PLACE,
      });
      return rows.map(toRecord);
    },

    async getForPlace({ id, placeId }) {
      const row = await p.placeBookingGrant.findFirst({ where: { id, placeId } });
      return row ? toRecord(row) : null;
    },

    async lockSharedAtPlace({ id, placeId }) {
      // Row lock first (bound parameters, tagged template; the lock outlives
      // the statement only on the tx client), then the ordinary mapped read
      // of the row it locked. FOR SHARE conflicts with the FOR NO KEY UPDATE
      // that revoke / update take, so they wait for this transaction.
      const locked = await p.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "PlaceBookingGrant"
        WHERE "id" = ${id} AND "placeId" = ${placeId}
        FOR SHARE`;
      if (locked.length === 0) return null;
      const row = await p.placeBookingGrant.findFirst({ where: { id, placeId } });
      return row ? toRecord(row) : null;
    },

    async getForGrantee({ id, humanIds, orgIds }) {
      const grantee = granteeIn(humanIds, orgIds);
      if (!grantee) return null;
      const row = await p.placeBookingGrant.findFirst({
        where: { id, ...grantee },
      });
      return row ? toRecord(row) : null;
    },

    async create(input) {
      if (input.calendarId) {
        await assertCalendarAtPlace(input.placeId, input.calendarId);
      }
      const personId =
        input.grantee.kind === "person" ? input.grantee.humanId : null;
      const row = await p.placeBookingGrant.create({
        data: {
          placeId: input.placeId,
          calendarId: input.calendarId ?? null,
          granteeOrgId: input.grantee.kind === "org" ? input.grantee.orgId : null,
          granteeHumanId: personId,
          // Dual-write through the expand (migration 20261015140000): the
          // running revision still reads humanId until the contract step
          // (plan step 18) drops it. Null for an org grantee.
          humanId: personId,
          grantedByHumanId: input.grantedByHumanId,
          expiresAt: input.expiresAt ?? null,
          acceptedAt: input.acceptedAt ?? null,
        },
      });
      return toRecord(row);
    },

    async lockPlace(placeId) {
      // Transaction-scoped (port doc): only serializes when `p` is the tx
      // client. Its own key namespace (never a line, request or claim key);
      // the key is a bound parameter (tagged template). `$executeRaw`: the
      // lock returns Postgres `void`, which `$queryRaw` cannot decode.
      await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`place_booking_grants:${placeId}`}))`;
    },

    async accept(input) {
      return respond(input, { acceptedAt: input.now });
    },

    async decline(input) {
      return respond(input, { declinedAt: input.now });
    },

    async update({ id, placeId, now, calendarId, expiresAt }) {
      if (calendarId) await assertCalendarAtPlace(placeId, calendarId);
      const data: Prisma.PlaceBookingGrantUncheckedUpdateManyInput = {};
      if (calendarId !== undefined) data.calendarId = calendarId;
      if (expiresAt !== undefined) {
        data.expiresAt = expiresAt;
        // A new date earns a new warning (FR-004 warns once per date).
        data.expiryWarnedAt = null;
      }
      const result = await p.placeBookingGrant.updateMany({
        where: {
          id,
          placeId,
          revokedAt: null,
          declinedAt: null,
          // Only a live grant is edited: an edit racing expiry must not
          // revive it by moving the date (as respond's CAS above).
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        data,
      });
      if (result.count === 0) return null;
      const row = await p.placeBookingGrant.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    async revoke({ id, placeId, now }) {
      const result = await p.placeBookingGrant.updateMany({
        where: { id, placeId, revokedAt: null },
        data: { revokedAt: now },
      });
      if (result.count === 0) return null;
      const row = await p.placeBookingGrant.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    async listForPlace({ placeId, includeEnded }) {
      const rows = await p.placeBookingGrant.findMany({
        where: {
          placeId,
          ...(includeEnded ? {} : { revokedAt: null, declinedAt: null }),
        },
        orderBy: NEWEST_FIRST,
      });
      return rows.map(toRecord);
    },

    async listForGrantee({ humanIds, orgIds, now }) {
      const grantee = granteeIn(humanIds, orgIds);
      if (!grantee) return [];
      // Pending or active: not declined, not revoked, not expired. Pending
      // rows are listed so the grantee can answer them (FR-014).
      const rows = await p.placeBookingGrant.findMany({
        where: {
          declinedAt: null,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          AND: [grantee],
        },
        orderBy: NEWEST_FIRST,
      });
      return rows.map(toRecord);
    },

    async listExpiring({ expiresBefore, unwarnedOnly, limit }) {
      const rows = await p.placeBookingGrant.findMany({
        where: {
          acceptedAt: { not: null },
          declinedAt: null,
          revokedAt: null,
          expiresAt: { not: null, lte: expiresBefore },
          ...(unwarnedOnly ? { expiryWarnedAt: null } : {}),
        },
        orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
        take: limit,
      });
      return rows.map(toRecord);
    },

    async markExpiryWarned({ id, expiresAt, now }) {
      // `expiresAt` in the CAS: a date moved since the job read it (which
      // also cleared expiryWarnedAt) is a new date, owed its own warning.
      const result = await p.placeBookingGrant.updateMany({
        where: { id, expiryWarnedAt: null, expiresAt },
        data: { expiryWarnedAt: now },
      });
      return result.count > 0;
    },
  };
}

/**
 * Prisma row → DTO (adapters never leak Prisma models). The grantee is read
 * from the grantee columns, falling back to the deprecated humanId only for
 * a row the backfill missed; the XOR CHECK makes "both" or "neither" an
 * invariant breach.
 */
function toRecord(row: PlaceBookingGrant): PlaceBookingGrantRecord {
  return {
    id: row.id,
    placeId: row.placeId,
    calendarId: row.calendarId ?? null,
    grantee: granteeOf(row),
    grantedByHumanId: row.grantedByHumanId,
    expiresAt: row.expiresAt ?? null,
    revokedAt: row.revokedAt ?? null,
    acceptedAt: row.acceptedAt ?? null,
    declinedAt: row.declinedAt ?? null,
    expiryWarnedAt: row.expiryWarnedAt ?? null,
    createdAt: row.createdAt,
  };
}

function granteeOf(row: PlaceBookingGrant): PlaceBookingGrantee {
  const humanId = row.granteeHumanId ?? row.humanId;
  if (row.granteeOrgId !== null && humanId !== null) {
    throw new Error(
      `place_booking_grant_grantee_shape: grant ${row.id} names both an org and a person`,
    );
  }
  if (row.granteeOrgId !== null) return { kind: "org", orgId: row.granteeOrgId };
  if (humanId !== null) return { kind: "person", humanId };
  throw new Error(
    `place_booking_grant_grantee_shape: grant ${row.id} has no grantee`,
  );
}
