import type {
  CreateSpaceInput,
  ListSpacesByPlaceInput,
  SpaceRow,
  SpacesRepo,
  SpaceStatus,
  UpdateSpaceInput,
} from "@th/ports/repos/spaces";
import type {
  CalendarAvailabilityRow,
  CalendarRow,
  CalendarsRepo,
  CalendarWithSpacesRow,
  CreateCalendarInput,
  DeleteCalendarAvailabilityInput,
  SetCalendarPrimarySpaceInput,
  SetCalendarSpacesInput,
  UpdateCalendarInput,
  UpsertCalendarAvailabilityInput,
} from "@th/ports/repos/calendars";
import type {
  BookingRequestMessageRow,
  BookingRequestMessagesRepo,
  CountUnreadByRequestInput,
  CreateBookingRequestMessageInput,
  HasBookingSystemEntryInput,
  ListBookingRequestMessagesInput,
  MarkBookingRequestMessagesReadInput,
} from "@th/ports/repos/booking-request-messages";

/**
 * Minimal in-memory fakes for the venue-hierarchy repos (SpacesRepo /
 * CalendarsRepo). House style: real Map-backed behaviour (not vi.fn stubs) so
 * use-case tests exercise actual list/find/count semantics; spy with
 * `vi.spyOn(fake, "method")` when call assertions are needed.
 *
 * Conflict backstops mirror what the Step-5 Prisma adapter maps from P2002
 * (documented on `CalendarsRepo.create`): a duplicate `(placeId, slug)` throws
 * `code: "CALENDAR_SLUG_TAKEN"` (as `Error & { code }` — no `@th/errors`
 * dependency needed here), and a second default calendar for a place throws
 * EXACTLY the adapter's plain object
 * `{ code: "conflict", message: "calendar_default_exists" }`.
 */

/**
 * Real UUIDs — the use-case input schemas validate `spaceId`/`calendarId`/`id`
 * as `.uuid()`, so prefix-counter ids would fail at the parse boundary.
 */
function nextId(_prefix: string): string {
  return crypto.randomUUID();
}

function conflict(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const FAKE_NOW = () => new Date();

// ── Spaces ───────────────────────────────────────────────────────────────────

export type FakeSpacesRepo = SpacesRepo & {
  /** Direct access for seeding/asserting. Keyed by space id. */
  rows: Map<string, SpaceRow>;
  seed(row: Partial<SpaceRow> & { placeId: string }): SpaceRow;
  /**
   * Back-reference used to MODEL the primary-space FK: retiring a space that is
   * some calendar's `primarySpaceId` must fail here exactly as it fails in
   * Postgres. `createFakeCalendarsRepo({ spaces })` wires this automatically,
   * so no test has to remember it; a spaces fake built alone simply has no
   * calendars to conflict with.
   */
  attachCalendars(calendars: ReadonlyMap<string, CalendarRow>): void;
};

export function createFakeSpacesRepo(): FakeSpacesRepo {
  const rows = new Map<string, SpaceRow>();
  let calendarRows: ReadonlyMap<string, CalendarRow> | undefined;

  const seed: FakeSpacesRepo["seed"] = (row) => {
    const record: SpaceRow = {
      id: row.id ?? nextId("space"),
      placeId: row.placeId,
      name: row.name ?? "Space",
      capacity: row.capacity ?? null,
      sortOrder: row.sortOrder ?? 0,
      status: row.status ?? "ACTIVE",
      createdAt: row.createdAt ?? FAKE_NOW(),
      updatedAt: row.updatedAt ?? FAKE_NOW(),
    };
    rows.set(record.id, record);
    return record;
  };

  const listByPlace = async (
    input: ListSpacesByPlaceInput,
  ): Promise<SpaceRow[]> =>
    [...rows.values()]
      .filter(
        (r) =>
          r.placeId === input.placeId &&
          (input.includeRetired ? true : r.status === "ACTIVE"),
      )
      .sort(
        (a, b) =>
          a.sortOrder - b.sortOrder ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      );

  return {
    rows,
    seed,
    attachCalendars: (rows) => {
      calendarRows = rows;
    },
    listByPlace,
    findById: async (id) => rows.get(id) ?? null,
    findByIds: async (ids) =>
      // Port semantics: rows for existing ids only, empty set short-circuits.
      ids.flatMap((id) => {
        const row = rows.get(id);
        return row ? [row] : [];
      }),
    create: async (input: CreateSpaceInput) =>
      seed({
        placeId: input.placeId,
        name: input.name,
        capacity: input.capacity ?? null,
        sortOrder: input.sortOrder ?? 0,
      }),
    update: async (input: UpdateSpaceInput) => {
      const existing = rows.get(input.id);
      if (!existing) throw conflict("NOT_FOUND", `space ${input.id} not found`);
      // Prisma patch semantics: a key that is present but `undefined` is
      // UNTOUCHED (only explicit `null` clears a nullable field) — the Step-5
      // adapter inherits this from Prisma, so the fake must match.
      const updated: SpaceRow = {
        ...existing,
        name: input.name ?? existing.name,
        capacity:
          input.capacity !== undefined ? input.capacity : existing.capacity,
        sortOrder: input.sortOrder ?? existing.sortOrder,
        updatedAt: FAKE_NOW(),
      };
      rows.set(updated.id, updated);
      return updated;
    },
    setStatus: async (input: { id: string; status: SpaceStatus }) => {
      const existing = rows.get(input.id);
      if (!existing) throw conflict("NOT_FOUND", `space ${input.id} not found`);
      // THE PRIMARY-SPACE FK, modelled. In Postgres the composite FK
      // Calendar(primarySpaceId, primarySpaceStatus) → Space(id, status)
      // refuses this from the referenced side, and the Prisma adapter maps that
      // P2003 to exactly this typed error (see `rethrowPrimarySpaceViolation`
      // in packages/adapters/src/db/prisma/spaces.ts). A fake that let the
      // retire through would let a use-case test prove the opposite of what
      // production does.
      if (input.status === "RETIRED" && calendarRows) {
        const blocked = [...calendarRows.values()].filter(
          (calendar) => calendar.primarySpaceId === input.id,
        );
        if (blocked.length > 0) {
          throw Object.assign(
            new Error("CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR"),
            {
              code: "CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR",
              meta: {
                spaceId: input.id,
                calendars: [],
                raced: true,
              },
            },
          );
        }
      }
      const updated: SpaceRow = {
        ...existing,
        status: input.status,
        updatedAt: FAKE_NOW(),
      };
      rows.set(updated.id, updated);
      return updated;
    },
    countActiveForPlace: async (placeId) =>
      [...rows.values()].filter(
        (r) => r.placeId === placeId && r.status === "ACTIVE",
      ).length,
  };
}

// ── Calendars ───────────────────────────────────────────────────────────────

export type FakeCalendarsRepo = CalendarsRepo & {
  /** Keyed by calendar id. */
  calendars: Map<string, CalendarRow>;
  /** calendarId → ordered spaceIds (the CalendarSpace join). */
  joins: Map<string, string[]>;
  /** Keyed by availability row id. */
  availability: Map<string, CalendarAvailabilityRow>;
  seedCalendar(row: Partial<CalendarRow> & { placeId: string }): CalendarRow;
  /**
   * FIXTURE SETUP for a calendar's join set — `seedCalendar`'s sibling, not a
   * port method. Sets the joins and points `primarySpaceId` at the first ACTIVE
   * member, the way the real `setSpaces` would, so arranging state does not
   * require restating the primary on every line. Tests that are ABOUT
   * `setSpaces` should call `setSpaces` directly.
   */
  seedJoins(calendarId: string, spaceIds: string[]): void;
  seedAvailability(
    row: Partial<CalendarAvailabilityRow> & { placeId: string },
  ): CalendarAvailabilityRow;
};

export function createFakeCalendarsRepo(options?: {
  /** Wire the spaces fake so `listByPlace` can hydrate joined spaces. */
  spaces?: FakeSpacesRepo;
}): FakeCalendarsRepo {
  const calendars = new Map<string, CalendarRow>();
  const joins = new Map<string, string[]>();
  const availability = new Map<string, CalendarAvailabilityRow>();
  const spacesFake = options?.spaces;

  const firstActiveSpaceOfPlace = (placeId: string): string | undefined =>
    spacesFake
      ? [...spacesFake.rows.values()]
          .filter((s) => s.placeId === placeId && s.status === "ACTIVE")
          .sort(
            (a, b) =>
              a.sortOrder - b.sortOrder ||
              a.createdAt.getTime() - b.createdAt.getTime(),
          )[0]?.id
      : undefined;

  /**
   * THE PRIMARY-SPACE FK, modelled. In Postgres the composite FK
   * Calendar(primarySpaceId, primarySpaceStatus) → Space(id, status) plus the
   * CHECK pinning the status to ACTIVE refuse a primary that is retired (or
   * absent), and the Prisma adapter maps that P2003 to exactly this typed error
   * (`rethrowPrimarySpaceViolation` in
   * packages/adapters/src/db/prisma/calendars.ts). Skipped entirely when no
   * spaces fake is wired — such a test is not modelling rooms at all.
   */
  const assertPrimaryActive = (
    primarySpaceId: string,
    meta: { calendarId: string | null },
  ): void => {
    if (!spacesFake) return;
    const space = spacesFake.rows.get(primarySpaceId);
    if (!space || space.status !== "ACTIVE") {
      throw Object.assign(new Error("CALENDAR_REQUIRES_ACTIVE_SPACE"), {
        code: "CALENDAR_REQUIRES_ACTIVE_SPACE",
        meta: { ...meta, primarySpaceId, raced: true },
      });
    }
  };

  /**
   * THE JOINED-NESS FK, modelled. In Postgres
   * "Calendar_primary_space_joined_fkey" (migration
   * 20260924160000_calendar_primary_space_joined) is a second composite FK
   * Calendar(id, primarySpaceId) → CalendarSpace(calendarId, spaceId): the
   * primary must be one of the calendar's OWN joins.
   *
   * THE ERROR SHAPE IS DELIBERATELY NOT A TYPED DOMAIN CODE, because the real
   * one is not either. The constraint is DEFERRABLE INITIALLY DEFERRED, so
   * Postgres raises it at COMMIT — after every repo method has returned, outside
   * every adapter try/catch — and Prisma surfaces it as a bare
   * `DriverAdapterError` with no `code` and no `meta` (MEASURED; see
   * `rethrowPrimarySpaceViolation` in
   * packages/adapters/src/db/prisma/calendars.ts). Nothing maps it, because no
   * sanctioned write path can reach it. A fake that handed back a friendly typed
   * error here would let a unit test assert a refusal production never produces.
   * So: a plain, loud Error naming the constraint. If a test sees it, the write
   * it just made is one the database would refuse.
   *
   * Asserted at the END of a write, which is the fake's analogue of COMMIT.
   * Skipped when no spaces fake is wired — such a test is not modelling rooms.
   */
  const assertPrimaryJoined = (calendarId: string): void => {
    if (!spacesFake) return;
    const calendar = calendars.get(calendarId);
    if (!calendar) return;
    const joined = joins.get(calendarId) ?? [];
    if (!joined.includes(calendar.primarySpaceId)) {
      throw new Error(
        `Calendar_primary_space_joined_fkey: calendar ${calendarId} has primarySpaceId ${calendar.primarySpaceId}, which is not one of its joined spaces [${joined.join(", ")}] — Postgres refuses this at COMMIT`,
      );
    }
  };

  // Let the spaces fake refuse a retire that would strand a primary — the
  // referenced side of the same FK. Wired here so no call site has to know.
  spacesFake?.attachCalendars(calendars);

  const seedCalendar: FakeCalendarsRepo["seedCalendar"] = (row) => {
    const record: CalendarRow = {
      id: row.id ?? nextId("calendar"),
      placeId: row.placeId,
      name: row.name ?? "Calendar",
      slug: row.slug ?? `slug-${crypto.randomUUID().slice(0, 8)}`,
      description: row.description ?? null,
      isDefault: row.isDefault ?? false,
      // NOT NULL in the schema. When a test does not care about rooms, fall
      // back to the place's first ACTIVE space and, failing that, a synthetic
      // id — mirroring the deliberate READ-side tolerance for calendars whose
      // rooms were never modelled (see `calendar-active-space.ts`). Every
      // WRITE path below enforces the constraint properly.
      primarySpaceId:
        row.primarySpaceId ?? firstActiveSpaceOfPlace(row.placeId) ?? nextId("space"),
      defaultStartTime: row.defaultStartTime ?? null,
      defaultCategoryId: row.defaultCategoryId ?? null,
      eventTemplate: row.eventTemplate ?? null,
      // Booking config (venue-confirmation spec): column defaults.
      acceptsPerform: row.acceptsPerform ?? true,
      acceptsRent: row.acceptsRent ?? false,
      acceptsUse: row.acceptsUse ?? false,
      rentalRateCents: row.rentalRateCents ?? null,
      rentalRateCurrency: row.rentalRateCurrency ?? null,
      rentalRateVisible: row.rentalRateVisible ?? false,
      rentalMode: row.rentalMode ?? "REQUEST",
      createdAt: row.createdAt ?? FAKE_NOW(),
      updatedAt: row.updatedAt ?? FAKE_NOW(),
    };
    calendars.set(record.id, record);
    if (!joins.has(record.id)) joins.set(record.id, []);
    return record;
  };

  /**
   * EXACTLY the adapter's object for an empty space set on create/setSpaces
   * (see `calendarRequiresSpace` in packages/adapters/src/db/prisma/
   * calendars.ts) — every calendar has ≥1 space.
   */
  const requiresSpace = () =>
    ({
      code: "calendar_requires_space",
      message: "calendar_requires_space",
    }) as const;

  const seedAvailability: FakeCalendarsRepo["seedAvailability"] = (row) => {
    const record: CalendarAvailabilityRow = {
      id: row.id ?? nextId("avail"),
      placeId: row.placeId,
      calendarId: row.calendarId ?? null,
      dayOfWeek: row.dayOfWeek ?? null,
      date: row.date ?? null,
      startTime: row.startTime ?? null,
      endTime: row.endTime ?? null,
      isOpen: row.isOpen ?? true,
      note: row.note ?? null,
      createdAt: row.createdAt ?? FAKE_NOW(),
      updatedAt: row.updatedAt ?? FAKE_NOW(),
    };
    availability.set(record.id, record);
    return record;
  };

  const assertUniques = (
    candidate: Pick<CalendarRow, "placeId" | "slug" | "isDefault">,
    excludeId?: string,
  ) => {
    for (const existing of calendars.values()) {
      if (existing.id === excludeId) continue;
      if (existing.placeId !== candidate.placeId) continue;
      if (existing.slug === candidate.slug) {
        throw conflict(
          "CALENDAR_SLUG_TAKEN",
          `duplicate (placeId, slug): ${candidate.slug}`,
        );
      }
      if (candidate.isDefault && existing.isDefault) {
        // EXACTLY the Step-5 adapter's object: it maps the SQL-only partial
        // unique "Calendar_placeId_default_key" P2002 to this plain literal
        // (see rethrowCalendarUniqueViolation in
        // packages/adapters/src/db/prisma/calendars.ts) — the fake must not
        // drift from what production throws.
        throw {
          code: "conflict",
          message: "calendar_default_exists",
        } as const;
      }
    }
  };

  const withSpaces = (calendar: CalendarRow): CalendarWithSpacesRow => {
    const spaceIds = joins.get(calendar.id) ?? [];
    const spaces = spacesFake
      ? spaceIds
          .map((id) => spacesFake.rows.get(id))
          .filter((r): r is SpaceRow => r !== undefined)
          // ALL joined spaces including RETIRED (port posture), sortOrder asc.
          .sort((a, b) => a.sortOrder - b.sortOrder)
      : [];
    return { ...calendar, spaces };
  };

  return {
    calendars,
    joins,
    availability,
    seedCalendar,
    seedJoins: (calendarId, spaceIds) => {
      const unique = [...new Set(spaceIds)];
      joins.set(calendarId, unique);
      const existing = calendars.get(calendarId);
      if (!existing) return;
      // Only a space of the calendar's OWN place can become its primary. A
      // cross-place join is not schema-prevented and fixtures do create them to
      // exercise the place-scoped guards — but no use case can produce one as a
      // PRIMARY (`assignCalendarSpaces` refuses a foreign space id with
      // SPACE_NOT_FOUND), so a fixture that set one would be modelling a state
      // the system cannot reach, and the retire guard would then refuse for a
      // reason production never sees.
      const primary = unique.find((id) => {
        const space = spacesFake?.rows.get(id);
        return space?.status === "ACTIVE" && space.placeId === existing.placeId;
      });
      if (primary) {
        calendars.set(existing.id, { ...existing, primarySpaceId: primary });
      }
    },
    seedAvailability,
    listByPlace: async (placeId) =>
      [...calendars.values()]
        .filter((c) => c.placeId === placeId)
        // Default first, then name asc (port ordering).
        .sort(
          (a, b) =>
            Number(b.isDefault) - Number(a.isDefault) ||
            a.name.localeCompare(b.name),
        )
        .map(withSpaces),
    findById: async (id) => calendars.get(id) ?? null,
    findDefaultForPlace: async (placeId) =>
      [...calendars.values()].find(
        (c) => c.placeId === placeId && c.isDefault,
      ) ?? null,
    create: async (input: CreateCalendarInput) => {
      // Port contract: refuse an empty space set BEFORE any row exists.
      const spaceIds = [...new Set(input.spaceIds)];
      if (spaceIds.length === 0) throw requiresSpace();
      assertPrimaryActive(input.primarySpaceId, { calendarId: null });
      assertUniques({
        placeId: input.placeId,
        slug: input.slug,
        isDefault: input.isDefault ?? false,
      });
      const created = seedCalendar({
        placeId: input.placeId,
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        isDefault: input.isDefault ?? false,
        primarySpaceId: input.primarySpaceId,
        defaultStartTime: input.defaultStartTime ?? null,
        defaultCategoryId: input.defaultCategoryId ?? null,
        eventTemplate: input.eventTemplate ?? null,
        acceptsPerform: input.acceptsPerform,
        acceptsRent: input.acceptsRent,
        acceptsUse: input.acceptsUse,
        rentalRateCents: input.rentalRateCents,
        rentalRateCurrency: input.rentalRateCurrency,
        rentalRateVisible: input.rentalRateVisible,
        rentalMode: input.rentalMode,
      });
      // Joins land with the row (ONE transaction in the adapter — mandatory
      // since the joined-ness FK, which is deferred precisely so that the
      // calendar row may briefly name a join that does not exist yet).
      joins.set(created.id, spaceIds);
      assertPrimaryJoined(created.id);
      return created;
    },
    update: async (input: UpdateCalendarInput) => {
      const existing = calendars.get(input.id);
      if (!existing) {
        throw conflict("NOT_FOUND", `calendar ${input.id} not found`);
      }
      // Prisma patch semantics: a key that is present but `undefined` is
      // UNTOUCHED (only explicit `null` clears a nullable field) — the Step-5
      // adapter inherits this from Prisma, so the fake must match.
      const updated: CalendarRow = {
        ...existing,
        name: input.name ?? existing.name,
        slug: input.slug ?? existing.slug,
        description:
          input.description !== undefined
            ? input.description
            : existing.description,
        isDefault: input.isDefault ?? existing.isDefault,
        // `primarySpaceId` is NOT patchable through `update` — the port routes
        // it through `setSpaces` / `setPrimarySpace` so it always moves with a
        // decision about the join set.
        primarySpaceId: existing.primarySpaceId,
        defaultStartTime:
          input.defaultStartTime !== undefined
            ? input.defaultStartTime
            : existing.defaultStartTime,
        defaultCategoryId:
          input.defaultCategoryId !== undefined
            ? input.defaultCategoryId
            : existing.defaultCategoryId,
        eventTemplate:
          input.eventTemplate !== undefined
            ? input.eventTemplate
            : existing.eventTemplate,
        acceptsPerform: input.acceptsPerform ?? existing.acceptsPerform,
        acceptsRent: input.acceptsRent ?? existing.acceptsRent,
        acceptsUse: input.acceptsUse ?? existing.acceptsUse,
        rentalRateCents:
          input.rentalRateCents !== undefined
            ? input.rentalRateCents
            : existing.rentalRateCents,
        rentalRateCurrency:
          input.rentalRateCurrency !== undefined
            ? input.rentalRateCurrency
            : existing.rentalRateCurrency,
        rentalRateVisible: input.rentalRateVisible ?? existing.rentalRateVisible,
        rentalMode: input.rentalMode ?? existing.rentalMode,
        updatedAt: FAKE_NOW(),
      };
      assertUniques(updated, updated.id);
      calendars.set(updated.id, updated);
      return updated;
    },
    setSpaces: async (input: SetCalendarSpacesInput) => {
      // Port contract: the WRITE refuses an empty set (reads still tolerate
      // a join-less calendar — `joins.get()` may legitimately be `[]`).
      if (input.spaceIds.length === 0) throw requiresSpace();
      assertPrimaryActive(input.primarySpaceId, {
        calendarId: input.calendarId,
      });
      joins.set(input.calendarId, [...new Set(input.spaceIds)]);
      // Written UNCONDITIONALLY, like the adapter's `tx.calendar.update` (see
      // the port doc for why that write is load-bearing).
      const existing = calendars.get(input.calendarId);
      if (existing) {
        calendars.set(existing.id, {
          ...existing,
          primarySpaceId: input.primarySpaceId,
        });
      }
      assertPrimaryJoined(input.calendarId);
    },
    setPrimarySpace: async (input: SetCalendarPrimarySpaceInput) => {
      assertPrimaryActive(input.spaceId, { calendarId: input.calendarId });
      const existing = calendars.get(input.calendarId);
      if (!existing) {
        throw conflict("NOT_FOUND", `calendar ${input.calendarId} not found`);
      }
      calendars.set(existing.id, {
        ...existing,
        primarySpaceId: input.spaceId,
      });
      assertPrimaryJoined(input.calendarId);
    },
    countForPlace: async (placeId) =>
      [...calendars.values()].filter((c) => c.placeId === placeId).length,
    countAvailabilityForPlace: async (placeId) =>
      [...availability.values()].filter((r) => r.placeId === placeId).length,
    listAvailabilityForPlace: async (placeId) =>
      [...availability.values()]
        .filter((r) => r.placeId === placeId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    upsertAvailability: async (input: UpsertCalendarAvailabilityInput) => {
      if (input.id) {
        const existing = availability.get(input.id);
        if (!existing) {
          throw conflict("NOT_FOUND", `availability ${input.id} not found`);
        }
        const updated: CalendarAvailabilityRow = {
          ...existing,
          dayOfWeek: input.dayOfWeek ?? null,
          date: input.date ?? null,
          startTime: input.startTime ?? null,
          endTime: input.endTime ?? null,
          isOpen: input.isOpen ?? existing.isOpen,
          note: input.note ?? null,
          updatedAt: FAKE_NOW(),
        };
        availability.set(updated.id, updated);
        return updated;
      }
      return seedAvailability({
        placeId: input.placeId,
        calendarId: input.calendarId ?? null,
        dayOfWeek: input.dayOfWeek ?? null,
        date: input.date ?? null,
        startTime: input.startTime ?? null,
        endTime: input.endTime ?? null,
        isOpen: input.isOpen ?? true,
        note: input.note ?? null,
      });
    },
    deleteAvailability: async (input: DeleteCalendarAvailabilityInput) => {
      // Port contract: WHERE id AND placeId — a foreign row id matches zero
      // rows and silently no-ops.
      const existing = availability.get(input.id);
      if (existing && existing.placeId === input.placeId) {
        availability.delete(input.id);
      }
    },
  };
}

// ── Booking-request messages ────────────────────────────────────────────────

export type FakeBookingRequestMessagesRepo = BookingRequestMessagesRepo & {
  /** Keyed by message id. */
  rows: Map<string, BookingRequestMessageRow>;
  seed(
    row: Partial<BookingRequestMessageRow> & { bookingRequestId: string },
  ): BookingRequestMessageRow;
};

/**
 * Map-backed BookingRequestMessagesRepo with the real port semantics:
 * createdAt-asc/id-asc listing, message-id cursor, and side-aware markRead
 * (stamps COUNTERPARTY rows only — never the reader's own and never SYSTEM
 * entries — `createdAt <= upToCreatedAt`, idempotent). `touchLastMessageAt`
 * deliberately lives on the booking-requests repo (the denormalized column is
 * that aggregate's data) and is faked by the use-case tests alongside their
 * bookingRequests mock.
 */
export function createFakeBookingRequestMessagesRepo(): FakeBookingRequestMessagesRepo {
  const rows = new Map<string, BookingRequestMessageRow>();
  // Monotonic tick so same-millisecond seeds keep a stable chat order.
  let tick = 0;

  const seed: FakeBookingRequestMessagesRepo["seed"] = (row) => {
    tick += 1;
    const record: BookingRequestMessageRow = {
      id: row.id ?? nextId("msg"),
      bookingRequestId: row.bookingRequestId,
      authorSide: row.authorSide ?? "VENUE",
      authorHumanId: row.authorHumanId ?? null,
      body: row.body ?? "Hello",
      systemKind: row.systemKind ?? null,
      systemData: row.systemData ?? null,
      readAt: row.readAt ?? null,
      createdAt: row.createdAt ?? new Date(Date.now() + tick),
    };
    rows.set(record.id, record);
    return record;
  };

  const ordered = (bookingRequestId: string) =>
    [...rows.values()]
      .filter((m) => m.bookingRequestId === bookingRequestId)
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );

  return {
    rows,
    seed,
    create: async (input: CreateBookingRequestMessageInput) =>
      seed({
        bookingRequestId: input.bookingRequestId,
        authorSide: input.authorSide,
        authorHumanId: input.authorHumanId ?? null,
        // Passed through verbatim. `seed`'s `?? "Hello"` default is NULLISH,
        // so a SYSTEM entry's legitimately-empty `""` body survives instead of
        // being replaced with filler.
        body: input.body,
        systemKind: input.systemKind ?? null,
        systemData: input.systemData ?? null,
      }),
    listForRequest: async (input: ListBookingRequestMessagesInput) => {
      const all = ordered(input.bookingRequestId);
      const start = input.cursor
        ? all.findIndex((m) => m.id === input.cursor) + 1
        : 0;
      const limit = input.limit ?? 50;
      const items = all.slice(start, start + limit);
      const nextCursor =
        start + limit < all.length
          ? (items[items.length - 1]?.id ?? null)
          : null;
      return { items, nextCursor };
    },
    markRead: async (input: MarkBookingRequestMessagesReadInput) => {
      let stamped = 0;
      const at = new Date();
      for (const m of ordered(input.bookingRequestId)) {
        if (m.authorSide === input.side) continue;
        // SYSTEM entries are never stamped — mirrors the adapter's
        // `notIn: [side, "SYSTEM"]` and keeps this the exact complement of
        // countUnreadByRequest below.
        if (m.authorSide === "SYSTEM") continue;
        if (m.readAt !== null) continue;
        if (m.createdAt.getTime() > input.upToCreatedAt.getTime()) continue;
        rows.set(m.id, { ...m, readAt: at });
        stamped += 1;
      }
      return stamped;
    },
    countUnreadByRequest: async (input: CountUnreadByRequestInput) => {
      // Port contract: zero-unread requests are ABSENT from the map (mirrors
      // the adapter's groupBy), so consumers must zero-fill.
      const counts = new Map<string, number>();
      if (input.bookingRequestIds.length === 0) return counts;
      const wanted = new Set(input.bookingRequestIds);
      for (const m of rows.values()) {
        if (!wanted.has(m.bookingRequestId)) continue;
        // Exact complement of markRead: the COUNTERPARTY's rows that are still
        // unstamped. SYSTEM entries never count — unread means "a human is
        // waiting on you" (port contract).
        if (m.authorSide === input.side) continue;
        if (m.authorSide === "SYSTEM") continue;
        if (m.readAt !== null) continue;
        counts.set(
          m.bookingRequestId,
          (counts.get(m.bookingRequestId) ?? 0) + 1,
        );
      }
      return counts;
    },
    hasSystemEntry: async (input: HasBookingSystemEntryInput) => {
      // Existence of ONE kind on ONE thread — the at-most-once guard the
      // expiry sweep uses (port contract).
      for (const m of rows.values()) {
        if (m.bookingRequestId !== input.bookingRequestId) continue;
        if (m.systemKind !== input.kind) continue;
        // `dataMatch`: every key equal on the stored params (port contract).
        const data = (m.systemData ?? {}) as Record<string, unknown>;
        if (
          input.dataMatch &&
          !Object.entries(input.dataMatch).every(
            ([key, value]) => data[key] === value,
          )
        ) {
          continue;
        }
        return true;
      }
      return false;
    },
  };
}
