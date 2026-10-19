import { Prisma } from "@prisma/client";
import type { Space } from "@prisma/client";
import { fail } from "@th/errors";
import type {
  SpaceRow,
  SpacesRepo,
  SpaceStatus,
} from "@th/ports/repos/spaces";

import type { PrismaClientOrTx } from "./types";

/**
 * Spaces of a Place (venue-hierarchy FR-001). Spaces are RETIRED, never
 * hard-deleted — the port deliberately exposes NO delete method (a Space
 * delete would cascade CalendarSpace rows and silently leave calendars
 * spaceless), and this adapter follows suit.
 */
export function makeSpacesRepo(p: PrismaClientOrTx): SpacesRepo {
  return {
    async listByPlace({ placeId, includeRetired }) {
      const rows = await p.space.findMany({
        where: {
          placeId,
          ...(includeRetired ? {} : { status: "ACTIVE" as const }),
        },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      });
      return rows.map(toSpaceRow);
    },

    async findById(id) {
      const row = await p.space.findUnique({ where: { id } });
      return row ? toSpaceRow(row) : null;
    },

    async findByIds(ids) {
      // Port contract: empty set short-circuits without touching the DB;
      // unknown ids are simply absent (callers index by id).
      if (ids.length === 0) return [];
      const rows = await p.space.findMany({ where: { id: { in: [...ids] } } });
      return rows.map(toSpaceRow);
    },

    async create(input) {
      const row = await p.space.create({
        data: {
          placeId: input.placeId,
          name: input.name,
          capacity: input.capacity ?? null,
          sortOrder: input.sortOrder ?? 0,
        },
      });
      return toSpaceRow(row);
    },

    async update(input) {
      // Prisma patch semantics: keys that are `undefined` are UNTOUCHED; only
      // an explicit `null` clears the nullable `capacity`.
      const row = await p.space.update({
        where: { id: input.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
          ...(input.sortOrder !== undefined
            ? { sortOrder: input.sortOrder }
            : {}),
        },
      });
      return toSpaceRow(row);
    },

    async setStatus({ id, status }) {
      try {
        const row = await p.space.update({ where: { id }, data: { status } });
        return toSpaceRow(row);
      } catch (error) {
        rethrowPrimarySpaceViolation(error, id);
      }
    },

    async countActiveForPlace(placeId) {
      return p.space.count({ where: { placeId, status: "ACTIVE" } });
    },
  };
}

/**
 * A retire refused by the DATABASE, translated for a venue admin.
 *
 * `Calendar.primarySpaceId` carries a composite FK onto `Space(id, status)`
 * whose status leg is CHECK-pinned to ACTIVE (owner ruling 2026-09-24,
 * migration 20260924120000_calendar_primary_space), so retiring a space that is
 * some calendar's primary violates it FROM THE REFERENCED SIDE — Postgres
 * "update or delete on table Space violates foreign key constraint ... on table
 * Calendar", which Prisma surfaces as P2003.
 *
 * `setSpaceStatus` guards this in core and names the blocking calendars, so the
 * only way to arrive here is a RACE: a calendar created or repointed onto this
 * space by a transaction that committed after the guard's reads. The FK is the
 * backstop those guards cannot be (they are check-then-act under READ
 * COMMITTED); this mapping is what keeps the backstop's refusal legible.
 * `meta.calendars` is deliberately empty — the referencing rows are not in the
 * error, and re-reading them after an aborted statement would report a state
 * nobody saw.
 */
function rethrowPrimarySpaceViolation(error: unknown, spaceId: string): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2003" &&
    mentionsPrimarySpaceFk(error)
  ) {
    fail("CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR", {
      meta: { spaceId, calendars: [], raced: true },
      cause: error,
    });
  }
  throw error;
}

/**
 * Whether a P2003 names the primary-space FK. Probes the same engine-dependent
 * slots `rethrowCalendarUniqueViolation` documents in calendars.ts: in
 * driver-adapter mode (Prisma 7, the only mode this repo runs) the constraint
 * name appears under `meta.driverAdapterError.cause`, while the classic engine
 * puts it on `meta.field_name`. EXACT name match — never a substring guess at
 * "Space" or "Calendar", which would swallow every other FK on either table.
 */
function mentionsPrimarySpaceFk(
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
  const slots: unknown[] = [
    meta.field_name,
    meta.constraint,
    cause?.constraint,
    cause?.originalMessage,
  ];
  for (const slot of slots) {
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

/** The constraint name the 20260924120000 migration creates. */
const PRIMARY_SPACE_FK = "Calendar_primarySpaceId_primarySpaceStatus_fkey";

/** Prisma row → DTO (adapters never leak Prisma models). */
function toSpaceRow(row: Space): SpaceRow {
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
