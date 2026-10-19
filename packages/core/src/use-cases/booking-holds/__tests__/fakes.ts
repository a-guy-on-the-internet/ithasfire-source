import { vi } from "vitest";

import type {
  BookerBookingHoldRecord,
  BookingHoldHolder,
  BookingHoldLineTerms,
  BookingHoldRecord,
  BookingHoldsRepo,
  ClearPlaceHoldHolderInput,
  ConvertBookerHoldToPlaceInput,
  CreateBookingHoldInput,
  CreateRequestlessBookingHoldInput,
  PlaceBookingHoldRecord,
  RenumberBookingHoldLineInput,
  RequestBookingHoldRecord,
  SetBookingHoldRespondByInput,
  SetNoteInput,
  SetNoteResult,
  UpdateBookingHoldStatusInput,
} from "@th/ports/repos/booking-holds";
import { LIVE_BOOKING_HOLD_STATUSES } from "@th/ports/repos/booking-holds";
import type {
  BookingRequestTagRow,
  BookingTagRecord,
  BookingTagsRepo,
  CreateBookingTagInput,
  DeleteBookingTagInput,
  SetBookingRequestTagsInput,
  UpdateBookingTagInput,
} from "@th/ports/repos/booking-tags";
import {
  bookingHoldsRepoPrototype,
  bookingTagsRepoPrototype,
} from "@th/test-utils/fakes/prototypes/repos";

// ─────────────────────────────────────────────────────────────────────────────
// In-memory BookingHoldsRepo / BookingTagsRepo — built ON the test-utils
// prototypes (so a port method added later without a fake here still exists
// as a vi.fn stub) and mirroring the adapter CONTRACTS the use cases rely on:
//   - `create` rejects a second LIVE hold for the same (request, calendar,
//     date) with `booking_hold_exists` (the partial unique on live statuses);
//   - `updateStatus` is a CAS on `expectedFrom` (`booking_hold_status_changed`
//     on a loser), nulls state-coupled columns, and refuses a second
//     CONFIRMED in one line (`booking_hold_line_confirmed`);
//   - `renumberLine` requires exactly the live set (`booking_hold_line_changed`);
//   - `setRespondBy` is guarded on CHALLENGED;
//   - holds are a union on `ownerKind` (holds-without-a-request FR-001):
//     request-scoped reads return REQUEST holds only, line and range reads
//     every kind; `createRequestless` refuses a second LIVE hold for the
//     same holder on one line (`booking_hold_holder_exists`);
//   - `setNote` checks the edited-at stamp like the adapter (FR-012);
//   - a BOOKER row's `grantRevokedAt` / `grantExpiresAt` are the adapter's
//     grant JOIN: refreshed from `grantFor` (the grants fake) whenever a repo
//     read returns the row, so a revoke or expiry is seen by the next read
//     exactly as in Postgres;
//   - `clearPlaceHolder` CASes on a live PLACE hold naming that holder.
// ─────────────────────────────────────────────────────────────────────────────

let seq = 0;
function nextUuid(): string {
  seq += 1;
  const hex = seq.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

function isLive(status: BookingHoldRecord["status"]): boolean {
  return (LIVE_BOOKING_HOLD_STATUSES as readonly string[]).includes(status);
}

/** Fields every kind shares, all optional on a seed except the line key. */
type FakeHoldSeedBase = Partial<
  Omit<RequestBookingHoldRecord, "ownerKind" | "bookingRequestId">
> &
  Pick<BookingHoldRecord, "calendarId" | "date">;

/**
 * A seed is a REQUEST hold unless it says otherwise, so every pre-FR-001
 * suite (`seed({ bookingRequestId, calendarId, date })`) is unchanged.
 */
export type FakeHoldSeed = FakeHoldSeedBase &
  (
    | { ownerKind?: "REQUEST"; bookingRequestId: string }
    | {
        ownerKind: "BOOKER";
        grantId: string;
        holder: BookingHoldHolder;
        grantRevokedAt?: Date | null;
        grantExpiresAt?: Date | null;
      }
    | { ownerKind: "PLACE"; holder?: BookingHoldHolder | null }
  );

export type FakeBookingHoldsRepo = BookingHoldsRepo & {
  rows: Map<string, BookingHoldRecord>;
  seed(row: FakeHoldSeed): BookingHoldRecord;
  /** Force the next `updateStatus` call(s) to lose the CAS. */
  failNextUpdateStatus(times?: number): void;
};

/**
 * What the adapter's `listForRequester` JOIN would see for one request —
 * the fake mirrors the SQL scope (owner pair + TO_VENUE direction) so the
 * requester-side tenant-isolation tests exercise the same predicate.
 */
export type FakeRequesterContext = {
  ownerType: "human" | "organization" | null;
  ownerId: string | null;
  direction: "TO_VENUE" | "TO_PERFORMER";
  placeId: string;
  placeName: string;
  placeTimezone: string | null;
  actName: string | null;
};

export function createFakeBookingHoldsRepo(
  opts: {
    /** Request id → its owner pair + venue; null = unknown request. */
    requesterContext?: (bookingRequestId: string) => FakeRequesterContext | null;
    /**
     * Request id → its terms, for `listLineWithTerms` (the adapter's
     * BookingRequest → Agreement join). Omitted / null = no agreement.
     */
    termsFor?: (bookingRequestId: string) => BookingHoldLineTerms | null;
    /**
     * Grant id → its end facts (the adapter's BookingHold → PlaceBookingGrant
     * join). Omitted, or null for a grant = the seed's own values.
     */
    grantFor?: (
      grantId: string,
    ) => { revokedAt: Date | null; expiresAt: Date | null } | null;
  } = {},
): FakeBookingHoldsRepo {
  const rows = new Map<string, BookingHoldRecord>();
  let casFailures = 0;

  /**
   * The adapter's grant JOIN, applied when a repo read returns a row: a
   * BOOKER row carries its grant's end facts as of NOW, and the refreshed row
   * is stored back (so a suite's later `rows.get` sees what the last read saw).
   */
  const read = <T extends BookingHoldRecord>(h: T): T => {
    if (h.ownerKind !== "BOOKER") return h;
    const grant = opts.grantFor?.(h.grantId) ?? null;
    if (
      !grant ||
      (h.grantRevokedAt?.getTime() ?? null) === (grant.revokedAt?.getTime() ?? null) &&
        (h.grantExpiresAt?.getTime() ?? null) === (grant.expiresAt?.getTime() ?? null)
    ) {
      return h;
    }
    const next = { ...h, grantRevokedAt: grant.revokedAt, grantExpiresAt: grant.expiresAt };
    rows.set(next.id, next);
    return next;
  };

  const line = (calendarId: string, date: string) =>
    [...rows.values()]
      .filter((h) => h.calendarId === calendarId && h.date === date && isLive(h.status))
      .map(read)
      .sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime());

  /** `listLine`'s read: LIVE by default, `statuses` widens it. */
  const readLine = ({
    calendarId,
    date,
    statuses,
  }: {
    calendarId: string;
    date: string;
    statuses?: readonly BookingHoldRecord["status"][];
  }): BookingHoldRecord[] =>
    statuses
      ? [...rows.values()]
          .filter(
            (h) =>
              h.calendarId === calendarId &&
              h.date === date &&
              (statuses as readonly string[]).includes(h.status),
          )
          .map(read)
          .sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime())
      : line(calendarId, date);

  const seed: FakeBookingHoldsRepo["seed"] = (row) => {
    const now = new Date();
    const base = {
      id: row.id ?? nextUuid(),
      calendarId: row.calendarId,
      spaceId: row.spaceId ?? null,
      date: row.date,
      position: row.position ?? line(row.calendarId, row.date).length + 1,
      status: row.status ?? "ACTIVE",
      placedByHumanId: row.placedByHumanId ?? "11111111-1111-4111-8111-111111111111",
      challengedAt: row.challengedAt ?? null,
      respondBy: row.respondBy ?? null,
      releasedAt: row.releasedAt ?? null,
      releasedReason: row.releasedReason ?? null,
      confirmedAt: row.confirmedAt ?? null,
      eventId: row.eventId ?? null,
      note: row.note ?? null,
      noteUpdatedByHumanId: row.noteUpdatedByHumanId ?? null,
      noteUpdatedAt: row.noteUpdatedAt ?? null,
      createdAt: row.createdAt ?? now,
      updatedAt: row.updatedAt ?? now,
    };
    let record: BookingHoldRecord;
    if (row.ownerKind === "BOOKER") {
      record = {
        ...base,
        ownerKind: "BOOKER",
        grantId: row.grantId,
        holder: row.holder,
        grantRevokedAt: row.grantRevokedAt ?? null,
        grantExpiresAt: row.grantExpiresAt ?? null,
      };
    } else if (row.ownerKind === "PLACE") {
      record = { ...base, ownerKind: "PLACE", holder: row.holder ?? null };
    } else {
      record = { ...base, ownerKind: "REQUEST", bookingRequestId: row.bookingRequestId };
    }
    rows.set(record.id, record);
    return read(record);
  };

  const requestHolds = (): RequestBookingHoldRecord[] =>
    [...rows.values()].filter(
      (h): h is RequestBookingHoldRecord => h.ownerKind === "REQUEST",
    );

  const sameHolder = (a: BookingHoldHolder | null, b: BookingHoldHolder | null) =>
    a !== null &&
    b !== null &&
    (a.kind === "org"
      ? b.kind === "org" && a.orgId === b.orgId
      : b.kind === "person" && a.humanId === b.humanId);

  const holderOf = (h: BookingHoldRecord): BookingHoldHolder | null =>
    h.ownerKind === "REQUEST" ? null : h.holder;

  const repo: FakeBookingHoldsRepo = {
    ...(bookingHoldsRepoPrototype as unknown as BookingHoldsRepo),
    rows,
    seed,
    failNextUpdateStatus: (times = 1) => {
      casFailures = times;
    },
    create: vi.fn(async (input: CreateBookingHoldInput) => {
      const dup = requestHolds().some(
        (h) =>
          h.bookingRequestId === input.bookingRequestId &&
          h.calendarId === input.calendarId &&
          h.date === input.date &&
          isLive(h.status),
      );
      if (dup) {
        throw { code: "conflict", message: "booking_hold_exists" } as const;
      }
      return seed({
        bookingRequestId: input.bookingRequestId,
        calendarId: input.calendarId,
        spaceId: input.spaceId ?? null,
        date: input.date,
        position: input.position,
        placedByHumanId: input.placedByHumanId,
      }) as RequestBookingHoldRecord;
    }),
    createRequestless: vi.fn(async (input: CreateRequestlessBookingHoldInput) => {
      // The holder partial uniques: one LIVE hold per holder per line; an
      // unassigned PLACE hold is never limited.
      if (
        input.holder !== null &&
        line(input.calendarId, input.date).some((h) => sameHolder(holderOf(h), input.holder))
      ) {
        throw { code: "conflict", message: "booking_hold_holder_exists" } as const;
      }
      const common = {
        calendarId: input.calendarId,
        spaceId: input.spaceId ?? null,
        date: input.date,
        position: input.position,
        placedByHumanId: input.placedByHumanId,
        ...(input.note
          ? { note: input.note, noteUpdatedByHumanId: input.placedByHumanId, noteUpdatedAt: input.now }
          : {}),
      };
      return (
        input.ownerKind === "BOOKER"
          ? seed({ ...common, ownerKind: "BOOKER", grantId: input.grantId, holder: input.holder })
          : seed({ ...common, ownerKind: "PLACE", holder: input.holder })
      ) as BookerBookingHoldRecord | PlaceBookingHoldRecord;
    }),
    getById: vi.fn(async (id: string) => {
      const row = rows.get(id);
      return row ? read(row) : null;
    }),
    listForRequest: vi.fn(async (bookingRequestId: string) =>
      requestHolds()
        .filter((h) => h.bookingRequestId === bookingRequestId)
        .sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime()),
    ),
    listLiveForRequests: vi.fn(async (ids: readonly string[]) =>
      ids.length === 0
        ? []
        : requestHolds().filter((h) => ids.includes(h.bookingRequestId) && isLive(h.status)),
    ),
    listRequestIdsWithConfirmedHold: vi.fn(async (ids: readonly string[]) => [
      ...new Set(
        requestHolds()
          .filter((h) => ids.includes(h.bookingRequestId) && h.status === "CONFIRMED")
          .map((h) => h.bookingRequestId),
      ),
    ]),
    lockLine: vi.fn(async () => {}),
    // Its own instance: the prototype's stub is shared by every fake, so
    // calls (and a test's staged implementation) would leak across tests.
    lockRequestBooking: vi.fn(async () => {}),
    listLine: vi.fn(async (input) => readLine(input)),
    // Same rows as `listLine` (shared helper, so this does not record a
    // `listLine` call), plus the request's terms from `termsFor`.
    listLineWithTerms: vi.fn(async (input) =>
      readLine(input).map((h) => ({
        ...h,
        // A request-less hold has no request, so no terms.
        terms: h.ownerKind === "REQUEST" ? (opts.termsFor?.(h.bookingRequestId) ?? null) : null,
      })),
    ),
    listLiveForPlaceRange: vi.fn(async () => []),
    listForRequester: vi.fn(async ({ ownerType, ownerId, statuses }) =>
      requestHolds()
        .filter((h) =>
          statuses ? (statuses as readonly string[]).includes(h.status) : isLive(h.status),
        )
        .flatMap((h) => {
          const ctx = opts.requesterContext?.(h.bookingRequestId) ?? null;
          // The adapter's WHERE: owner pair AND direction, on the request row.
          if (
            !ctx ||
            ctx.direction !== "TO_VENUE" ||
            ctx.ownerType !== ownerType ||
            ctx.ownerId !== ownerId
          ) {
            return [];
          }
          return [
            {
              ...h,
              placeId: ctx.placeId,
              placeName: ctx.placeName,
              placeTimezone: ctx.placeTimezone,
              requestActName: ctx.actName,
            },
          ];
        })
        .sort(
          (a, b) =>
            a.date.localeCompare(b.date) ||
            a.calendarId.localeCompare(b.calendarId) ||
            a.position - b.position,
        ),
    ),
    listLiveForCalendarRange: vi.fn(async ({ calendarId, from, to, statuses }) =>
      [...rows.values()].filter(
        (h) =>
          h.calendarId === calendarId &&
          (statuses
            ? (statuses as readonly string[]).includes(h.status)
            : isLive(h.status)) &&
          h.date >= from &&
          h.date <= to,
      ).map(read),
    ),
    updateStatus: vi.fn(async (input: UpdateBookingHoldStatusInput) => {
      const current = rows.get(input.id);
      if (casFailures > 0 || !current || !input.expectedFrom.includes(current.status)) {
        if (casFailures > 0) casFailures -= 1;
        throw { code: "conflict", message: "booking_hold_status_changed" } as const;
      }
      if (
        input.status === "CONFIRMED" &&
        [...rows.values()].some(
          (h) =>
            h.id !== current.id &&
            h.calendarId === current.calendarId &&
            h.date === current.date &&
            h.status === "CONFIRMED",
        )
      ) {
        throw { code: "conflict", message: "booking_hold_line_confirmed" } as const;
      }
      const next: BookingHoldRecord = {
        ...current,
        status: input.status,
        challengedAt: input.challengedAt !== undefined ? input.challengedAt : current.challengedAt,
        respondBy:
          input.status === "CHALLENGED"
            ? (input.respondBy !== undefined ? input.respondBy : current.respondBy)
            : null,
        releasedAt: input.status === "RELEASED" ? (input.releasedAt ?? current.releasedAt) : null,
        releasedReason:
          input.status === "RELEASED" ? (input.releasedReason ?? current.releasedReason) : null,
        confirmedAt: input.status === "CONFIRMED" ? (input.confirmedAt ?? current.confirmedAt) : null,
        updatedAt: new Date(),
      };
      rows.set(next.id, next);
      return next;
    }),
    renumberLine: vi.fn(async (input: RenumberBookingHoldLineInput) => {
      const live = line(input.calendarId, input.date);
      const liveIds = new Set(live.map((h) => h.id));
      const unique = new Set(input.orderedIds);
      if (
        unique.size !== input.orderedIds.length ||
        unique.size !== liveIds.size ||
        [...unique].some((id) => !liveIds.has(id))
      ) {
        throw { code: "conflict", message: "booking_hold_line_changed" } as const;
      }
      const out: BookingHoldRecord[] = [];
      input.orderedIds.forEach((id, index) => {
        const next = { ...rows.get(id)!, position: index + 1 };
        rows.set(id, next);
        out.push(next);
      });
      return out;
    }),
    setRespondBy: vi.fn(async (input: SetBookingHoldRespondByInput) => {
      const current = rows.get(input.id);
      if (!current || current.status !== input.expectedStatus) {
        throw { code: "conflict", message: "booking_hold_status_changed" } as const;
      }
      const next = { ...current, respondBy: input.respondBy, updatedAt: new Date() };
      rows.set(next.id, next);
      return next;
    }),
    listLiveForGrant: vi.fn(async (grantId: string) =>
      [...rows.values()]
        .filter(
          (h): h is BookerBookingHoldRecord =>
            h.ownerKind === "BOOKER" && h.grantId === grantId && isLive(h.status),
        )
        .map(read)
        .sort(
          (a, b) =>
            a.date.localeCompare(b.date) ||
            a.calendarId.localeCompare(b.calendarId) ||
            a.position - b.position,
        ),
    ),
    // The adapter's CAS: still a LIVE BOOKER hold on this grant; the holder,
    // position, status and note stay, the grant goes (PLACE has none).
    convertBookerHoldToPlace: vi.fn(async (input: ConvertBookerHoldToPlaceInput) => {
      const current = rows.get(input.id);
      if (
        !current ||
        current.ownerKind !== "BOOKER" ||
        current.grantId !== input.grantId ||
        !isLive(current.status)
      ) {
        return null;
      }
      const {
        grantId: _grantId,
        grantRevokedAt: _revokedAt,
        grantExpiresAt: _expiresAt,
        ...rest
      } = current;
      const next: PlaceBookingHoldRecord = { ...rest, ownerKind: "PLACE", updatedAt: new Date() };
      rows.set(next.id, next);
      return next;
    }),
    // The adapter's CAS: still a LIVE PLACE hold naming exactly `holder`;
    // position, status, challenge and note stay, the holder goes.
    clearPlaceHolder: vi.fn(async (input: ClearPlaceHoldHolderInput) => {
      const current = rows.get(input.id);
      if (
        !current ||
        current.ownerKind !== "PLACE" ||
        !isLive(current.status) ||
        !sameHolder(current.holder, input.holder)
      ) {
        return null;
      }
      const next: PlaceBookingHoldRecord = { ...current, holder: null, updatedAt: new Date() };
      rows.set(next.id, next);
      return next;
    }),
    setNote: vi.fn(async (input: SetNoteInput): Promise<SetNoteResult> => {
      const current = rows.get(input.id);
      if (!current) return { status: "not_found" };
      if (
        input.expectedUpdatedAt !== undefined &&
        (current.noteUpdatedAt?.getTime() ?? null) !== (input.expectedUpdatedAt?.getTime() ?? null)
      ) {
        return {
          status: "conflict",
          current: {
            note: current.note,
            noteUpdatedByHumanId: current.noteUpdatedByHumanId,
            noteUpdatedAt: current.noteUpdatedAt,
          },
        };
      }
      const note = {
        note: input.note === "" ? null : input.note,
        noteUpdatedByHumanId: input.updatedByHumanId,
        noteUpdatedAt: input.now,
      };
      rows.set(current.id, { ...current, ...note, updatedAt: input.now });
      return { status: "saved", note };
    }),
  };
  return repo;
}

export type FakeBookingTagsRepo = BookingTagsRepo & {
  tags: Map<string, BookingTagRecord>;
  /** requestId → tagIds */
  joins: Map<string, string[]>;
  seedTag(row: Partial<BookingTagRecord> & Pick<BookingTagRecord, "orgId" | "name">): BookingTagRecord;
};

export function createFakeBookingTagsRepo(): FakeBookingTagsRepo {
  const tags = new Map<string, BookingTagRecord>();
  const joins = new Map<string, string[]>();

  const seedTag: FakeBookingTagsRepo["seedTag"] = (row) => {
    const now = new Date();
    const record: BookingTagRecord = {
      id: row.id ?? nextUuid(),
      orgId: row.orgId,
      name: row.name,
      slug: row.slug ?? row.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      color: row.color ?? "neutral",
      sortOrder: row.sortOrder ?? tags.size,
      createdAt: row.createdAt ?? now,
      updatedAt: row.updatedAt ?? now,
    };
    tags.set(record.id, record);
    return record;
  };

  const slugTaken = (orgId: string, slug: string, exceptId?: string) =>
    [...tags.values()].some((t) => t.orgId === orgId && t.slug === slug && t.id !== exceptId);

  const ordered = (list: BookingTagRecord[]) =>
    [...list].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  return {
    ...(bookingTagsRepoPrototype as unknown as BookingTagsRepo),
    tags,
    joins,
    seedTag,
    listForOrg: vi.fn(async (orgId: string) =>
      ordered([...tags.values()].filter((t) => t.orgId === orgId)),
    ),
    create: vi.fn(async (input: CreateBookingTagInput) => {
      if (slugTaken(input.orgId, input.slug)) {
        throw { code: "conflict", message: "booking_tag_slug_taken" } as const;
      }
      return seedTag(input);
    }),
    update: vi.fn(async (input: UpdateBookingTagInput) => {
      const current = tags.get(input.id);
      if (!current || current.orgId !== input.orgId) return null;
      if (input.slug && slugTaken(input.orgId, input.slug, input.id)) {
        throw { code: "conflict", message: "booking_tag_slug_taken" } as const;
      }
      const next: BookingTagRecord = {
        ...current,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        updatedAt: new Date(),
      };
      tags.set(next.id, next);
      return next;
    }),
    delete: vi.fn(async (input: DeleteBookingTagInput) => {
      const current = tags.get(input.id);
      if (!current || current.orgId !== input.orgId) return false;
      tags.delete(input.id);
      for (const [requestId, ids] of joins) {
        joins.set(requestId, ids.filter((id) => id !== input.id));
      }
      return true;
    }),
    setForRequest: vi.fn(async (input: SetBookingRequestTagsInput) => {
      const foreign = input.tagIds.filter((id) => tags.get(id)?.orgId !== input.orgId);
      if (foreign.length > 0) {
        throw { code: "invalid_input", message: "booking_tag_foreign_org" } as const;
      }
      joins.set(input.bookingRequestId, [...input.tagIds]);
      return ordered(input.tagIds.map((id) => tags.get(id)!));
    }),
    listForRequests: vi.fn(async (ids: readonly string[]) => {
      const out: BookingRequestTagRow[] = [];
      for (const requestId of ids) {
        for (const tag of ordered((joins.get(requestId) ?? []).map((id) => tags.get(id)!).filter(Boolean))) {
          out.push({ bookingRequestId: requestId, tag });
        }
      }
      return out;
    }),
  };
}

// The in-memory PlaceBookingGrantsRepo moved to test-utils
// (fakes/place-booking-grants.ts) with the grant lifecycle methods; re-exported
// here so the suites that import it from this file are unchanged.
export {
  createFakePlaceBookingGrantsRepo,
  type FakePlaceBookingGrantsRepo,
} from "@th/test-utils/fakes/place-booking-grants";
