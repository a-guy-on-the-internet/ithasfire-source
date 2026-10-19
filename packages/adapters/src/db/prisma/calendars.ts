import { Prisma } from "@prisma/client";
import type { Calendar, CalendarAvailability, Space } from "@prisma/client";
import { fail } from "@th/errors";
import type {
  CalendarAvailabilityRow,
  CalendarBookingConfigInput,
  CalendarRow,
  CalendarsRepo,
  CalendarWithSpacesRow,
  RentalMode,
} from "@th/ports/repos/calendars";
import type { SpaceRow, SpaceStatus } from "@th/ports/repos/spaces";

import type { PrismaClient } from "@prisma/client";
import type { PrismaClientOrTx } from "./types";

type CalendarWithJoinedSpaces = Calendar & {
  calendarSpaces: { space: Space }[];
};

/**
 * Calendars — a Place's named programming streams plus their availability
 * windows (venue-hierarchy FR-003/FR-007). Calendars join M:N onto Spaces via
 * CalendarSpace; event rendering filters on `Event.calendarId`, never the space
 * join (FR-005) — nothing in this repo feeds event rendering.
 */
export function makeCalendarsRepo(p: PrismaClientOrTx): CalendarsRepo {
  return {
    async listByPlace(placeId) {
      const rows = await p.calendar.findMany({
        where: { placeId },
        // Port ordering: default first, then name asc.
        orderBy: [{ isDefault: "desc" }, { name: "asc" }],
        include: { calendarSpaces: { include: { space: true } } },
      });
      return rows.map(toCalendarWithSpacesRow);
    },

    async listByPlaceIds(placeIds) {
      // Explicit short circuit: `in: []` is a valid query that scans and
      // returns nothing, and skipping it keeps "no owned places ⇒ no calendar
      // query" a testable property rather than an adapter detail.
      if (placeIds.length === 0) return [];
      const rows = await p.calendar.findMany({
        where: { placeId: { in: placeIds } },
        // Grouped by place, then the port's own ordering within each place.
        orderBy: [{ placeId: "asc" }, { isDefault: "desc" }, { name: "asc" }],
        include: { calendarSpaces: { include: { space: true } } },
      });
      return rows.map(toCalendarWithSpacesRow);
    },

    async findById(id) {
      const row = await p.calendar.findUnique({ where: { id } });
      return row ? toCalendarRow(row) : null;
    },

    async findDefaultForPlace(placeId) {
      // At most one row can match — the SQL-only partial unique
      // "Calendar_placeId_default_key" guarantees it (see `create`).
      const row = await p.calendar.findFirst({
        where: { placeId, isDefault: true },
      });
      return row ? toCalendarRow(row) : null;
    },

    async create(input) {
      // Every calendar has ≥1 space (port contract / venue-confirmation spec):
      // refuse BEFORE any row is written. Dedupe so a repeated id can't trip
      // the (calendarId, spaceId) unique mid-transaction.
      const spaceIds = [...new Set(input.spaceIds)];
      if (spaceIds.length === 0) {
        throw calendarRequiresSpace();
      }
      // Calendar row + its CalendarSpace joins in ONE transaction: inside
      // repos.tx() the surrounding tx provides it; a root client wraps both
      // statements itself (same shape as setSpaces below).
      //
      // The transaction is now MANDATORY, not merely tidy. Since migration
      // 20260924160000_calendar_primary_space_joined the Calendar row's primary
      // must have a CalendarSpace join row, and the join row needs the
      // calendar's id — a circular dependency no statement order resolves. The
      // FK is DEFERRABLE INITIALLY DEFERRED for exactly this, and "deferred"
      // means "checked at the end of the enclosing transaction": in autocommit
      // that is the end of the FIRST statement, so these two statements
      // unwrapped would fail. VERIFIED by running them that way.
      const run = async (tx: PrismaClientOrTx) => {
        const row = await tx.calendar.create({
          data: {
            placeId: input.placeId,
            name: input.name,
            slug: input.slug,
            // FK-pinned to an ACTIVE Space (owner ruling 2026-09-24). Passed
            // straight through — the port makes it required rather than
            // deriving `spaceIds[0]`, so a caller that has not thought about
            // which room is primary cannot compile.
            primarySpaceId: input.primarySpaceId,
            description: input.description ?? null,
            isDefault: input.isDefault ?? false,
            defaultStartTime: input.defaultStartTime ?? null,
            defaultCategoryId: input.defaultCategoryId ?? null,
            eventTemplate: toJsonInput(input.eventTemplate ?? null),
            // Omitted config keys take the column defaults (PERFORM only, no
            // rate, REQUEST) — `undefined` keys are skipped by Prisma.
            ...bookingConfigData(input),
          },
        });
        await tx.calendarSpace.createMany({
          data: spaceIds.map((spaceId) => ({ calendarId: row.id, spaceId })),
          skipDuplicates: true,
        });
        return row;
      };
      try {
        const row =
          "$transaction" in p
            ? await (p as PrismaClient).$transaction((tx) => run(tx))
            : await run(p);
        return toCalendarRow(row);
      } catch (error) {
        rethrowPrimarySpaceViolation(error, {
          calendarId: null,
          primarySpaceId: input.primarySpaceId,
        });
        rethrowCalendarUniqueViolation(error);
      }
    },

    async update(input) {
      try {
        // Prisma patch semantics: `undefined` keys are UNTOUCHED.
        const row = await p.calendar.update({
          where: { id: input.id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.slug !== undefined ? { slug: input.slug } : {}),
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
            ...(input.isDefault !== undefined
              ? { isDefault: input.isDefault }
              : {}),
            ...(input.defaultStartTime !== undefined
              ? { defaultStartTime: input.defaultStartTime }
              : {}),
            ...(input.defaultCategoryId !== undefined
              ? { defaultCategoryId: input.defaultCategoryId }
              : {}),
            ...(input.eventTemplate !== undefined
              ? { eventTemplate: toJsonInput(input.eventTemplate) }
              : {}),
            ...bookingConfigData(input),
          },
        });
        return toCalendarRow(row);
      } catch (error) {
        rethrowCalendarUniqueViolation(error);
      }
    },

    async setSpaces({ calendarId, spaceIds, primarySpaceId }) {
      // Every calendar has ≥1 space (port contract): the WRITE refuses an
      // empty set. Reads still tolerate a calendar with no joins (stale rows
      // / a space deleted from under a calendar) — that tolerance is
      // deliberate and lives in the availability code, not here.
      if (spaceIds.length === 0) {
        throw calendarRequiresSpace();
      }
      // FULL replacement of the join set (port contract): remove joins not in
      // `spaceIds`, create the missing ones. `skipDuplicates` keeps a repeat
      // call idempotent under the (calendarId, spaceId) unique. Space/place
      // isolation is asserted by the USE CASE before this runs — the join
      // table has no cross-place guard.
      //
      // ORDER: create the new joins, THEN repoint the primary, THEN drop the
      // stale joins. The primary is never named by the Calendar row before its
      // CalendarSpace row exists — which is exactly what
      // "Calendar_primary_space_joined_fkey" now requires (migration
      // 20260924160000_calendar_primary_space_joined). That FK is DEFERRABLE
      // INITIALLY DEFERRED, so this order is not strictly forced; it is kept
      // because it means no INTERMEDIATE state ever violates the constraint
      // either, which is what makes a mid-transaction `SET CONSTRAINTS ...
      // IMMEDIATE` (a debugging tool, and a future tightening) survivable.
      // MEASURED: `deleteMany`-then-re-`createMany` in one transaction IS
      // tolerated by the deferred constraint, so neither order breaks — see the
      // "delete-then-insert" test in
      // packages/adapters/test/integration/calendar-primary-space-race.test.ts.
      //
      // The primary UPDATE is UNCONDITIONAL — see the port doc. It is what
      // takes the Calendar row's lock, and that lock is the whole reason a
      // concurrent `setSpaceStatus` auto-promotion cannot slip past this
      // replacement.
      const run = async (tx: PrismaClientOrTx) => {
        await tx.calendarSpace.createMany({
          data: spaceIds.map((spaceId) => ({ calendarId, spaceId })),
          skipDuplicates: true,
        });
        await tx.calendar.update({
          where: { id: calendarId },
          data: { primarySpaceId },
        });
        await tx.calendarSpace.deleteMany({
          where: { calendarId, spaceId: { notIn: [...spaceIds] } },
        });
      };
      // One transaction (port contract). When `p` is already a transaction
      // client (the standard repos.tx() path) the surrounding tx provides
      // atomicity; a root client wraps the statements itself.
      try {
        if ("$transaction" in p) {
          await (p as PrismaClient).$transaction((tx) => run(tx));
        } else {
          await run(p);
        }
      } catch (error) {
        rethrowPrimarySpaceViolation(error, { calendarId, primarySpaceId });
        throw error;
      }
    },

    async setPrimarySpace({ calendarId, spaceId }) {
      try {
        await p.calendar.update({
          where: { id: calendarId },
          data: { primarySpaceId: spaceId },
        });
      } catch (error) {
        rethrowPrimarySpaceViolation(error, {
          calendarId,
          primarySpaceId: spaceId,
        });
        throw error;
      }
    },

    async countForPlace(placeId) {
      return p.calendar.count({ where: { placeId } });
    },

    async countAvailabilityForPlace(placeId) {
      return p.calendarAvailability.count({ where: { placeId } });
    },

    async listAvailabilityForPlace(placeId) {
      // ONE query path on purpose (port doc): calendar-scoped rows AND
      // place-wide rows (calendarId null) — consumers always need the merged
      // view. Stable order for editors: oldest first, id as tiebreak.
      const rows = await p.calendarAvailability.findMany({
        where: { placeId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      return rows.map(toAvailabilityRow);
    },

    async upsertAvailability(input) {
      if (input.id) {
        // Scoped updateMany (id AND placeId in the WHERE — same IDOR backstop
        // as deleteAvailability): a foreign row id matches zero rows and
        // surfaces as not-found instead of mutating another place's row. The
        // row's place/calendar scoping is immutable on update (port
        // contract — the use case enforces the calendar half; placeId is
        // pinned here).
        const { count } = await p.calendarAvailability.updateMany({
          where: { id: input.id, placeId: input.placeId },
          data: {
            dayOfWeek: input.dayOfWeek ?? null,
            date: input.date ?? null,
            startTime: input.startTime ?? null,
            endTime: input.endTime ?? null,
            ...(input.isOpen !== undefined ? { isOpen: input.isOpen } : {}),
            note: input.note ?? null,
          },
        });
        if (count === 0) {
          throw fail("AVAILABILITY_NOT_FOUND", {
            meta: { id: input.id, placeId: input.placeId },
          });
        }
        const row = await p.calendarAvailability.findUniqueOrThrow({
          where: { id: input.id },
        });
        return toAvailabilityRow(row);
      }

      const row = await p.calendarAvailability.create({
        data: {
          placeId: input.placeId,
          calendarId: input.calendarId ?? null,
          dayOfWeek: input.dayOfWeek ?? null,
          date: input.date ?? null,
          startTime: input.startTime ?? null,
          endTime: input.endTime ?? null,
          isOpen: input.isOpen ?? true,
          note: input.note ?? null,
        },
      });
      return toAvailabilityRow(row);
    },

    async deleteAvailability({ id, placeId }) {
      // Port contract: deleteMany with BOTH id AND placeId in the WHERE — the
      // placeId scope is the IDOR backstop (a forged/leaked row id from
      // another place matches zero rows). Zero rows = silent no-op (deletes
      // are idempotent).
      await p.calendarAvailability.deleteMany({ where: { id, placeId } });
    },
  };
}

/**
 * Map a P2002 on the Calendar uniques to its domain error (port doc):
 * - `@@unique([placeId, slug])` ("Calendar_placeId_slug_key") — the race
 *   loser of the slug pre-check in `createCalendar` → CALENDAR_SLUG_TAKEN.
 * - SQL-only partial unique "Calendar_placeId_default_key" (one default
 *   calendar per place; migration 20260818120000_venue_hierarchy_rooms_
 *   calendars) — Prisma can't attribute a partial index to model fields, so
 *   it surfaces by index NAME. Mapped to a typed conflict (mirrors the
 *   booking-requests `duplicate_open_request` / `claim_token_hash_collision`
 *   plain-object pattern).
 * Anything else is rethrown untouched.
 */
function rethrowCalendarUniqueViolation(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    // Which unique fired travels in `meta`, but its SHAPE varies by engine:
    // the classic engine puts a field array (or raw index name) on
    // `meta.target`, while driver-adapter mode (Prisma 7, the only mode this
    // repo runs) nests it under `meta.driverAdapterError.cause`. VERIFIED
    // against the integration suite (test/integration/venue-hierarchy.test.ts):
    // in driver-adapter mode `cause.constraint` is `{ fields: [...] }` — the
    // index NAME appears verbatim ONLY inside `cause.originalMessage`
    // (Postgres wording: `…violates unique constraint
    // "Calendar_placeId_slug_key"`). Probe exactly those slots (never the
    // adapter stack traces riding along in meta).
    const m = (error.meta ?? {}) as {
      target?: unknown;
      constraint?: unknown;
      driverAdapterError?: {
        cause?: { constraint?: unknown; originalMessage?: unknown };
      };
    };

    // EXACT index-name match FIRST. Collect index names verbatim across
    // engine shapes: a bare string slot, an `{ index: "..." }` object, or
    // the quoted name inside Postgres's `unique constraint "…"` message —
    // each an exact capture, never a substring guess.
    const names: string[] = [];
    const collectNames = (slot: unknown): void => {
      if (typeof slot === "string") {
        names.push(slot);
        const quoted = /unique constraint "([^"]+)"/.exec(slot);
        if (quoted?.[1]) names.push(quoted[1]);
      } else if (
        slot !== null &&
        typeof slot === "object" &&
        "index" in slot &&
        typeof (slot as { index: unknown }).index === "string"
      ) {
        names.push((slot as { index: string }).index);
      }
    };
    collectNames(m.target);
    collectNames(m.constraint);
    collectNames(m.driverAdapterError?.cause?.constraint);
    collectNames(m.driverAdapterError?.cause?.originalMessage);
    if (names.includes("Calendar_placeId_slug_key")) {
      fail("CALENDAR_SLUG_TAKEN", { cause: error });
    }
    if (names.includes("Calendar_placeId_default_key")) {
      throw {
        code: "conflict",
        message: "calendar_default_exists",
        cause: error,
      } as const;
    }

    // FALLBACK ONLY: substring probe over every slot including
    // `originalMessage`, for shapes that surface field lists ("placeId",
    // "slug") instead of the index name. Kept deliberately second:
    // `originalMessage` may gain column lists in future Prisma releases, and
    // an exact-name match above prevents cross-mapping (a message that
    // happens to mention both "slug" and "default" columns must never route
    // the default-key violation to CALENDAR_SLUG_TAKEN). Both violations on
    // this model have a distinctive token ("slug" / "default") that appears
    // in every known shape and never in the other's.
    let probe: string;
    try {
      probe = JSON.stringify([
        m.target,
        m.constraint,
        m.driverAdapterError?.cause?.constraint,
        m.driverAdapterError?.cause?.originalMessage,
      ]);
    } catch {
      probe = String(m.target ?? "");
    }
    if (probe.includes("slug")) {
      fail("CALENDAR_SLUG_TAKEN", { cause: error });
    }
    if (probe.includes("default")) {
      throw {
        code: "conflict",
        message: "calendar_default_exists",
        cause: error,
      } as const;
    }
  }
  // Unmapped P2002 (or any other error): rethrow untouched.
  throw error;
}

/**
 * A write refused by the PRIMARY-SPACE constraint, translated for a venue
 * admin. Returns normally when the error is something else — callers keep
 * their own rethrow after it.
 *
 * `Calendar.primarySpaceId` carries a composite FK onto `Space(id, status)`
 * whose status leg is CHECK-pinned to ACTIVE (owner ruling 2026-09-24,
 * migration 20260924120000_calendar_primary_space). From the REFERENCING side —
 * inserting or repointing a Calendar onto a space that is RETIRED, or that a
 * concurrent transaction retires while this one is open — Postgres raises
 * "insert or update on table Calendar violates foreign key constraint ...",
 * which Prisma surfaces as P2003.
 *
 * Core guards this first (`CALENDAR_REQUIRES_ACTIVE_SPACE`, thrown with the
 * full space set in `meta`), so reaching here means the guard's read was
 * overtaken — the FK is the backstop those check-then-act guards cannot be
 * under READ COMMITTED. Mapping it to the SAME typed error is what keeps the
 * backstop's refusal legible instead of leaking Postgres wording into a
 * venue-admin dialog.
 *
 * ── THE OTHER PRIMARY-SPACE FK IS DELIBERATELY NOT MAPPED ──────────────────
 * "Calendar_primary_space_joined_fkey" (migration
 * 20260924160000_calendar_primary_space_joined, `Calendar(id, primarySpaceId)`
 * → `CalendarSpace(calendarId, spaceId)`) is DEFERRABLE INITIALLY DEFERRED, so
 * it is raised AT COMMIT — after every repo method has returned, outside the
 * try/catch of all of them. It is therefore not mappable from here at all; it
 * propagates out of `repos.tx()` itself. MEASURED against real Postgres, it
 * arrives as a bare `DriverAdapterError`, NOT a `PrismaClientKnownRequestError`:
 *
 *   err.constructor.name === "DriverAdapterError"
 *   err.code             === undefined      // so no P2003, no `meta`
 *   err.message          === "ForeignKeyConstraintViolation"
 *   err.cause            === { originalCode: "23503", kind:
 *                              "ForeignKeyConstraintViolation",
 *                              originalMessage: 'insert or update on table
 *                              "Calendar" violates foreign key constraint
 *                              "Calendar_primary_space_joined_fkey"',
 *                              constraint: {} }   // note: name only in the message
 *
 * Left unmapped because it is unreachable through the application, not because
 * it is harmless. Every sanctioned writer refuses first with a typed error:
 * `createCalendar` / `assignCalendarSpaces` pick the primary OUT of the space
 * set they are writing (`pickPrimarySpace`), `setSpaces` above creates the join
 * rows BEFORE it repoints the primary, and `setSpaceStatus` promotes only to a
 * space already in `calendar.spaces` and then re-reads and refuses with
 * `CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR`. Neutralise that re-read and
 * the constraint fires instead — which is what the last two tests in
 * packages/adapters/test/integration/calendar-primary-space-race.test.ts
 * measure. If this ever DOES show up in Sentry, the shape above is how to
 * recognise it, and it means a write path reached the database without going
 * through those guards.
 */
function rethrowPrimarySpaceViolation(
  error: unknown,
  meta: { calendarId: string | null; primarySpaceId: string },
): void {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2003" &&
    namesPrimarySpaceFk(error)
  ) {
    fail("CALENDAR_REQUIRES_ACTIVE_SPACE", {
      meta: { ...meta, raced: true },
      cause: error,
    });
  }
}

/** The constraint name migration 20260924120000 creates. */
const PRIMARY_SPACE_FK = "Calendar_primarySpaceId_primarySpaceStatus_fkey";

/**
 * Whether a P2003 names the primary-space FK. Probes the same engine-dependent
 * slots `rethrowCalendarUniqueViolation` documents above — driver-adapter mode
 * nests the constraint under `meta.driverAdapterError.cause`, the classic
 * engine puts it on `meta.field_name`. EXACT name, never a substring guess at
 * "Calendar" or "Space": every other FK on this table would match that.
 */
function namesPrimarySpaceFk(
  error: Prisma.PrismaClientKnownRequestError,
): boolean {
  const meta = (error.meta ?? {}) as {
    field_name?: unknown;
    constraint?: unknown;
    driverAdapterError?: {
      cause?: { constraint?: unknown; originalMessage?: unknown };
    };
  };
  const cause = meta.driverAdapterError?.cause;
  for (const slot of [
    meta.field_name,
    meta.constraint,
    cause?.constraint,
    cause?.originalMessage,
  ]) {
    if (typeof slot === "string" && slot.includes(PRIMARY_SPACE_FK)) return true;
    if (
      slot !== null &&
      typeof slot === "object" &&
      "index" in slot &&
      (slot as { index: unknown }).index === PRIMARY_SPACE_FK
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The typed error `create` / `setSpaces` throw on an empty space set (port
 * contract). Plain object, same shape as the `calendar_default_exists`
 * conflict and the booking-requests `duplicate_open_request` — core matches
 * on `code`.
 */
function calendarRequiresSpace() {
  return {
    code: "calendar_requires_space",
    message: "calendar_requires_space",
  } as const;
}

/**
 * Booking config patch (venue-confirmation spec): only keys the caller set
 * are written — `undefined` is skipped by Prisma, so on create the column
 * defaults apply and on update the existing values are untouched.
 */
function bookingConfigData(input: CalendarBookingConfigInput): {
  acceptsPerform?: boolean;
  acceptsRent?: boolean;
  acceptsUse?: boolean;
  rentalRateCents?: number | null;
  rentalRateCurrency?: string | null;
  rentalRateVisible?: boolean;
  rentalMode?: RentalMode;
} {
  return {
    ...(input.acceptsPerform !== undefined
      ? { acceptsPerform: input.acceptsPerform }
      : {}),
    ...(input.acceptsRent !== undefined
      ? { acceptsRent: input.acceptsRent }
      : {}),
    ...(input.acceptsUse !== undefined ? { acceptsUse: input.acceptsUse } : {}),
    ...(input.rentalRateCents !== undefined
      ? { rentalRateCents: input.rentalRateCents }
      : {}),
    ...(input.rentalRateCurrency !== undefined
      ? { rentalRateCurrency: input.rentalRateCurrency }
      : {}),
    ...(input.rentalRateVisible !== undefined
      ? { rentalRateVisible: input.rentalRateVisible }
      : {}),
    ...(input.rentalMode !== undefined ? { rentalMode: input.rentalMode } : {}),
  };
}

/** Prisma row → DTO (adapters never leak Prisma models). */
function toCalendarRow(row: Calendar): CalendarRow {
  return {
    id: row.id,
    placeId: row.placeId,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    isDefault: row.isDefault,
    primarySpaceId: row.primarySpaceId,
    defaultStartTime: row.defaultStartTime ?? null,
    defaultCategoryId: row.defaultCategoryId ?? null,
    eventTemplate: toEventTemplate(row.eventTemplate),
    acceptsPerform: row.acceptsPerform,
    acceptsRent: row.acceptsRent,
    acceptsUse: row.acceptsUse,
    rentalRateCents: row.rentalRateCents ?? null,
    rentalRateCurrency: row.rentalRateCurrency ?? null,
    rentalRateVisible: row.rentalRateVisible,
    rentalMode: row.rentalMode as RentalMode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCalendarWithSpacesRow(
  row: CalendarWithJoinedSpaces,
): CalendarWithSpacesRow {
  return {
    ...toCalendarRow(row),
    // ALL joined spaces INCLUDING RETIRED ones (port posture — admin surfaces
    // need retired joins to explain history / un-join them); sortOrder asc,
    // createdAt asc tiebreak, mirroring SpacesRepo.listByPlace.
    spaces: row.calendarSpaces
      .map((join) => toJoinedSpaceRow(join.space))
      .sort(
        (a, b) =>
          a.sortOrder - b.sortOrder ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      ),
  };
}

function toJoinedSpaceRow(row: Space): SpaceRow {
  return {
    id: row.id,
    placeId: row.placeId,
    name: row.name,
    capacity: row.capacity ?? null,
    sortOrder: row.sortOrder,
    status: row.status as SpaceStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The column is Prisma `Json?`, which also admits arrays and scalars — guard
 * non-object JSON to `null` (port doc mandate), never `as`-cast the Prisma
 * value into the record shape.
 */
function toEventTemplate(
  value: Prisma.JsonValue | null,
): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** DTO → Prisma Json input (`null` clears via DbNull). */
function toJsonInput(
  value: Record<string, unknown> | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

function toAvailabilityRow(row: CalendarAvailability): CalendarAvailabilityRow {
  return {
    id: row.id,
    placeId: row.placeId,
    calendarId: row.calendarId ?? null,
    dayOfWeek: row.dayOfWeek ?? null,
    date: row.date ?? null,
    startTime: row.startTime ?? null,
    endTime: row.endTime ?? null,
    isOpen: row.isOpen,
    note: row.note ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
