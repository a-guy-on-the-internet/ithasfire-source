/**
 * The read half of the `PlaceAvailability → CalendarAvailability` backfill.
 *
 * WHY RAW SQL. The `PlaceAvailability` model, its port, its adapter and its
 * table were all removed on 2026-08-21 (migration
 * 20260821140000_drop_place_availability) — the venue hierarchy moved hours and
 * blackouts to `CalendarAvailability` (FR-007) and the last reader, the public
 * booking date picker, was re-pointed there. There is therefore no generated
 * Prisma delegate to read the legacy rows with any more. Keeping a model +
 * port + adapter alive purely to feed a one-shot script would re-create exactly
 * the dead surface that change deleted, so the backfill reads the legacy table
 * directly instead. The statement is a fixed string with ZERO interpolation —
 * no user data reaches it, and there is nothing to inject into.
 *
 * WHAT HAPPENS AFTER THE TABLE IS DROPPED. This must NOT crash. Once an
 * environment has run the drop migration, the legacy table is simply gone and
 * there is nothing left to migrate, which is a success state, not an error: the
 * reader probes for the table first (`to_regclass`, which answers NULL for a
 * missing relation instead of raising) and returns an empty set. The backfill
 * then plans zero availability rows and its phase-2 output reads "0". Running
 * the script on an up-to-date database is a clean no-op.
 *
 * SEQUENCING. In any environment that still HAS legacy rows, this backfill must
 * run BEFORE the drop migration, or those hours are destroyed with the table.
 * See the migration's SQL header.
 */

import type { LegacyAvailabilityRow } from "./plan-availability-backfill";

/**
 * The slice of a Prisma client this reader needs. Structural on purpose: it
 * keeps the raw-SQL escape hatch narrow and lets the tests drive it without a
 * database.
 */
export interface RawQueryClient {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
}

/**
 * True when the legacy table still exists in the target database.
 *
 * `to_regclass` is the only lookup that answers "no such relation" as a NULL
 * rather than a raised `42P01` — important because a thrown error inside an
 * implicit transaction would poison every later statement in the script.
 */
export async function legacyPlaceAvailabilityExists(
  prisma: RawQueryClient,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<
    { present: boolean }[]
  >`SELECT to_regclass('public."PlaceAvailability"') IS NOT NULL AS present`;
  return rows[0]?.present === true;
}

/**
 * Every legacy Place-level availability row, narrowed to the fields that carry
 * meaning, oldest first. Returns `[]` when the table has already been dropped.
 */
export async function readLegacyPlaceAvailability(
  prisma: RawQueryClient,
): Promise<LegacyAvailabilityRow[]> {
  if (!(await legacyPlaceAvailabilityExists(prisma))) return [];

  return prisma.$queryRaw<LegacyAvailabilityRow[]>`
    SELECT "placeId", "dayOfWeek", "date", "startTime", "endTime", "isOpen", "note"
    FROM "PlaceAvailability"
    ORDER BY "createdAt" ASC
  `;
}
