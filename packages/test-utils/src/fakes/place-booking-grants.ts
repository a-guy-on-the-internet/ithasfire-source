import { vi } from "vitest";

import type {
  CreatePlaceBookingGrantInput,
  FindActivePlaceBookingGrantForActorInput,
  GetPlaceBookingGrantForGranteeInput,
  GetPlaceBookingGrantForPlaceInput,
  ListExpiringPlaceBookingGrantsInput,
  ListPlaceBookingGrantsForGranteeInput,
  ListPlaceBookingGrantsForPlaceInput,
  MarkPlaceBookingGrantExpiryWarnedInput,
  PlaceBookingGrantee,
  PlaceBookingGrantRecord,
  PlaceBookingGrantsRepo,
  RespondToPlaceBookingGrantInput,
  RevokePlaceBookingGrantInput,
  UpdatePlaceBookingGrantInput,
} from "@th/ports/repos/place-booking-grants";

import { placeBookingGrantsRepoPrototype } from "./prototypes/repos";

// ─────────────────────────────────────────────────────────────────────────────
// In-memory PlaceBookingGrantsRepo (holds-without-a-request FR-002 / FR-003).
// Mirrors the adapter's contracts:
//   - ACTIVE = accepted AND not declined AND not revoked AND not expired, in
//     the MATCH of every active read (never a post-filter on a preferred row);
//   - scope: a calendar action matches whole-place grants and that calendar's,
//     a place-level action whole-place grants only; whole-place wins, then
//     the oldest;
//   - `findActiveForActor` / `listActiveForActor` match grantee IN the given
//     sets (find = the list's first row);
//   - accept / decline are grantee-scoped (someone else's grant →
//     not_found, unchanged) and CAS on pending and unexpired
//     (`place_booking_grant_not_pending`);
//   - `lockPlace` is a no-op spy (no concurrency in memory);
//   - getForPlace (and its FOR SHARE twin lockSharedAtPlace) is place-scoped, getForGrantee grantee-scoped (any state); markExpiryWarned CASes on the expiresAt read;
//     revoke is scoped to the place and to unrevoked grants, update also to
//     undeclined, unexpired-at-`now` ones (null otherwise); moving `expiresAt` clears `expiryWarnedAt`.
// Empty by default: the booker gate refuses (NOT_RESOURCE_OWNER) unless a
// suite seeds a grant. The staff gate never reads grants.
// ─────────────────────────────────────────────────────────────────────────────

let seq = 0;
function nextUuid(): string {
  seq += 1;
  return `9a000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`;
}

const DEFAULT_GRANTOR = "11111111-1111-4111-8111-111111111111";

/**
 * Seed shape: the record's fields, with the grantee given either as
 * `grantee` or (the common case, and every pre-FR-002 suite) as `humanId`
 * for a person grantee. Seeds are ACCEPTED by default (`acceptedAt` =
 * `createdAt`), like the backfilled fixture rows; pass `acceptedAt: null`
 * for a pending grant.
 */
export type FakePlaceBookingGrantSeed = Partial<
  Omit<PlaceBookingGrantRecord, "grantee">
> & {
  placeId: string;
  grantee?: PlaceBookingGrantee;
  humanId?: string;
};

export type FakePlaceBookingGrantsRepo = PlaceBookingGrantsRepo & {
  rows: Map<string, PlaceBookingGrantRecord>;
  seed(row: FakePlaceBookingGrantSeed): PlaceBookingGrantRecord;
};

function isActive(g: PlaceBookingGrantRecord, now: Date): boolean {
  return (
    g.acceptedAt !== null &&
    g.declinedAt === null &&
    g.revokedAt === null &&
    (g.expiresAt === null || g.expiresAt.getTime() > now.getTime())
  );
}

function inScope(g: PlaceBookingGrantRecord, calendarId: string | null): boolean {
  return g.calendarId === null || g.calendarId === calendarId;
}

function preferWholePlace(
  a: PlaceBookingGrantRecord,
  b: PlaceBookingGrantRecord,
): number {
  return (
    Number(a.calendarId !== null) - Number(b.calendarId !== null) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id)
  );
}

function newestFirst(
  a: PlaceBookingGrantRecord,
  b: PlaceBookingGrantRecord,
): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);
}

function granteeMatches(
  g: PlaceBookingGrantRecord,
  humanIds: readonly string[],
  orgIds: readonly string[],
): boolean {
  return g.grantee.kind === "person"
    ? humanIds.includes(g.grantee.humanId)
    : orgIds.includes(g.grantee.orgId);
}

export function createFakePlaceBookingGrantsRepo(
  opts: {
    /** calendarId → placeId, for the create/update calendar check. Omitted = no check. */
    calendarPlace?: (calendarId: string) => string | null;
  } = {},
): FakePlaceBookingGrantsRepo {
  const rows = new Map<string, PlaceBookingGrantRecord>();

  const seed: FakePlaceBookingGrantsRepo["seed"] = (row) => {
    const grantee: PlaceBookingGrantee | undefined =
      row.grantee ??
      (row.humanId !== undefined ? { kind: "person", humanId: row.humanId } : undefined);
    if (!grantee) throw new Error("fake grant seed needs grantee or humanId");
    const createdAt = row.createdAt ?? new Date();
    const record: PlaceBookingGrantRecord = {
      id: row.id ?? nextUuid(),
      placeId: row.placeId,
      calendarId: row.calendarId ?? null,
      grantee,
      grantedByHumanId: row.grantedByHumanId ?? DEFAULT_GRANTOR,
      expiresAt: row.expiresAt ?? null,
      revokedAt: row.revokedAt ?? null,
      acceptedAt: row.acceptedAt === undefined ? createdAt : row.acceptedAt,
      declinedAt: row.declinedAt ?? null,
      expiryWarnedAt: row.expiryWarnedAt ?? null,
      createdAt,
    };
    rows.set(record.id, record);
    return record;
  };

  const assertCalendarAtPlace = (placeId: string, calendarId: string) => {
    if (!opts.calendarPlace) return;
    if (opts.calendarPlace(calendarId) !== placeId) {
      throw {
        code: "grant_calendar_place_mismatch",
        message: "grant_calendar_place_mismatch",
      } as const;
    }
  };

  /** The shared match of `findActiveForActor` / `listActiveForActor`. */
  const activeForActor = (
    input: FindActivePlaceBookingGrantForActorInput,
  ): PlaceBookingGrantRecord[] => {
    const calendarId = input.calendarId ?? null;
    return [...rows.values()]
      .filter(
        (g) =>
          g.placeId === input.placeId &&
          granteeMatches(g, input.humanIds, input.orgIds) &&
          isActive(g, input.now) &&
          inScope(g, calendarId),
      )
      .sort(preferWholePlace);
  };

  const respond = (
    input: RespondToPlaceBookingGrantInput,
    field: "acceptedAt" | "declinedAt",
  ): PlaceBookingGrantRecord => {
    const current = rows.get(input.id);
    // Grantee-scoped like the adapter: someone else's grant reads as missing.
    if (!current || !granteeMatches(current, input.humanIds, input.orgIds)) {
      throw { code: "not_found", message: "place_booking_grant_not_found" } as const;
    }
    if (
      current.acceptedAt !== null ||
      current.declinedAt !== null ||
      current.revokedAt !== null ||
      // Past its expiry: the adapter's CAS refuses it too.
      (current.expiresAt !== null && current.expiresAt.getTime() <= input.now.getTime())
    ) {
      throw { code: "conflict", message: "place_booking_grant_not_pending" } as const;
    }
    const next = { ...current, [field]: input.now };
    rows.set(next.id, next);
    return next;
  };

  return {
    ...(placeBookingGrantsRepoPrototype as unknown as PlaceBookingGrantsRepo),
    rows,
    seed,
    findActiveForActor: vi.fn(
      async (input: FindActivePlaceBookingGrantForActorInput) =>
        activeForActor(input)[0] ?? null,
    ),
    listActiveForActor: vi.fn(
      async (input: FindActivePlaceBookingGrantForActorInput) =>
        activeForActor(input),
    ),
    getForPlace: vi.fn(async (input: GetPlaceBookingGrantForPlaceInput) => {
      const row = rows.get(input.id);
      return row && row.placeId === input.placeId ? row : null;
    }),
    getForGrantee: vi.fn(async (input: GetPlaceBookingGrantForGranteeInput) => {
      const row = rows.get(input.id);
      return row && granteeMatches(row, input.humanIds, input.orgIds) ? row : null;
    }),
    // The adapter's FOR SHARE read: getForPlace's answer (no concurrency in
    // memory). A suite that needs the lock order hooks the spy.
    lockSharedAtPlace: vi.fn(async (input: GetPlaceBookingGrantForPlaceInput) => {
      const row = rows.get(input.id);
      return row && row.placeId === input.placeId ? row : null;
    }),
    create: vi.fn(async (input: CreatePlaceBookingGrantInput) => {
      if (input.calendarId) assertCalendarAtPlace(input.placeId, input.calendarId);
      return seed({
        placeId: input.placeId,
        calendarId: input.calendarId ?? null,
        grantee: input.grantee,
        grantedByHumanId: input.grantedByHumanId,
        expiresAt: input.expiresAt ?? null,
        // Pending unless the caller says otherwise (unlike `seed`).
        acceptedAt: input.acceptedAt ?? null,
      });
    }),
    // The adapter's advisory lock; a suite simulating a racing writer hooks it.
    lockPlace: vi.fn(async (_placeId: string) => {}),
    accept: vi.fn(async (input: RespondToPlaceBookingGrantInput) =>
      respond(input, "acceptedAt"),
    ),
    decline: vi.fn(async (input: RespondToPlaceBookingGrantInput) =>
      respond(input, "declinedAt"),
    ),
    update: vi.fn(async (input: UpdatePlaceBookingGrantInput) => {
      if (input.calendarId) assertCalendarAtPlace(input.placeId, input.calendarId);
      const current = rows.get(input.id);
      if (
        !current ||
        current.placeId !== input.placeId ||
        current.revokedAt !== null ||
        current.declinedAt !== null ||
        (current.expiresAt !== null && current.expiresAt.getTime() <= input.now.getTime())
      ) {
        return null;
      }
      const next: PlaceBookingGrantRecord = {
        ...current,
        ...(input.calendarId !== undefined ? { calendarId: input.calendarId } : {}),
        ...(input.expiresAt !== undefined
          ? { expiresAt: input.expiresAt, expiryWarnedAt: null }
          : {}),
      };
      rows.set(next.id, next);
      return next;
    }),
    revoke: vi.fn(async (input: RevokePlaceBookingGrantInput) => {
      const current = rows.get(input.id);
      if (!current || current.placeId !== input.placeId || current.revokedAt !== null) {
        return null;
      }
      const next = { ...current, revokedAt: input.now };
      rows.set(next.id, next);
      return next;
    }),
    listForPlace: vi.fn(async (input: ListPlaceBookingGrantsForPlaceInput) =>
      [...rows.values()]
        .filter(
          (g) =>
            g.placeId === input.placeId &&
            (input.includeEnded || (g.revokedAt === null && g.declinedAt === null)),
        )
        .sort(newestFirst),
    ),
    listForGrantee: vi.fn(async (input: ListPlaceBookingGrantsForGranteeInput) =>
      [...rows.values()]
        .filter(
          (g) =>
            granteeMatches(g, input.humanIds, input.orgIds) &&
            g.declinedAt === null &&
            g.revokedAt === null &&
            (g.expiresAt === null || g.expiresAt.getTime() > input.now.getTime()),
        )
        .sort(newestFirst),
    ),
    listExpiring: vi.fn(async (input: ListExpiringPlaceBookingGrantsInput) =>
      [...rows.values()]
        .filter(
          (g) =>
            g.acceptedAt !== null &&
            g.declinedAt === null &&
            g.revokedAt === null &&
            g.expiresAt !== null &&
            g.expiresAt.getTime() <= input.expiresBefore.getTime() &&
            (!input.unwarnedOnly || g.expiryWarnedAt === null),
        )
        .sort(
          (a, b) =>
            a.expiresAt!.getTime() - b.expiresAt!.getTime() || a.id.localeCompare(b.id),
        )
        .slice(0, input.limit),
    ),
    markExpiryWarned: vi.fn(async (input: MarkPlaceBookingGrantExpiryWarnedInput) => {
      const current = rows.get(input.id);
      if (
        !current ||
        current.expiryWarnedAt !== null ||
        current.expiresAt?.getTime() !== input.expiresAt.getTime()
      ) {
        return false;
      }
      rows.set(current.id, { ...current, expiryWarnedAt: input.now });
      return true;
    }),
  };
}
