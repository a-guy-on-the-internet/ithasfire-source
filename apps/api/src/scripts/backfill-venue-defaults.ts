/**
 * Backfill venue-hierarchy defaults for pre-hierarchy Places.
 *
 * Context (venue-hierarchy FR-001/FR-002, Step 5): every Place is expected to
 * own one default Calendar joined to at least one Space — `upsert-place` mints
 * them for NEW places and the dev seed mints them for seeded ones, but places
 * created BEFORE the hierarchy shipped have neither. At those venues every
 * agreement mint reports `no_default_calendar` per-mint. This one-shot brings
 * them up to the invariant:
 *
 *   For each Place with NO default calendar:
 *     - reuse the place's first space (sortOrder asc, createdAt asc) if any
 *       exist, else create a "Main Space";
 *     - reuse the place's "main"-slugged calendar (promote it to default) if
 *       one exists, else create a default "Main Calendar" (slug "main");
 *     - join the calendar to the space (CalendarSpace upsert).
 *
 * PHASE 2 — AVAILABILITY (added when the public booking date picker moved off
 * `PlaceAvailability`). The picker used to read the legacy Place-level rows;
 * it now reads `CalendarAvailability`, so any pre-hierarchy venue whose hours
 * still live in the old table would answer "closed" on EVERY date with no
 * error at all — a silently dead picker. Migrate the debt first, then gate:
 *
 *   For each PlaceAvailability row with no matching CalendarAvailability row:
 *     - copy it to CalendarAvailability with `calendarId: null`.
 *
 * `calendarId: null` is semantically EXACT, not a fallback: the old rows were
 * place-scoped, and a null-calendar row is defined as applying to every
 * calendar of the place (FR-007). The source rows are NOT deleted — this
 * script never destroys data, and the table is dropped separately.
 *
 * ORDERING vs THE DROP MIGRATION — READ THIS BEFORE DEPLOYING. The legacy
 * table is dropped by migration 20260821140000_drop_place_availability. In any
 * environment that still holds legacy rows, THIS SCRIPT MUST RUN FIRST, or
 * those venues' hours go down with the table. Once the drop has run there is
 * nothing left to migrate and phase 2 becomes a clean NO-OP rather than a
 * crash: the legacy read probes for the table and returns an empty set when it
 * is gone (see ./read-legacy-place-availability). Phase 1 is unaffected either
 * way and still runs normally.
 *
 * MIRRORS (not extracted from) `ensureVenueDefaults` in
 * apps/api/src/scripts/seed/places.ts: the seed helper is entangled with
 * DEMO_IDS pinning and reseed-specific name clobbering ("Main Calendar"
 * rename on update) that a production backfill must not inherit, so the
 * shared shape is mirrored here with two deliberate divergences: an existing
 * space is REUSED instead of find-or-created by name, and an existing "main"
 * calendar keeps its owner-chosen name when promoted to default.
 *
 * Idempotent: places that already have a default calendar are never selected;
 * re-running only touches places still missing one. Spaces/calendars/joins are
 * find-or-created / upserted. Safe to run multiple times.
 *
 * Dev is already covered by seeds (this should NO-OP locally); prod runs it
 * once at deploy. Usage (from repo root — DATABASE_URL is REQUIRED and never
 * read from a .env file, so the target is always explicit):
 *
 *   DATABASE_URL=postgresql://... pnpm -F api backfill:venue-defaults [--dry-run]
 */

import { getPrisma } from "@th/db";

import { planAvailabilityBackfill } from "./plan-availability-backfill";
import { readLegacyPlaceAvailability } from "./read-legacy-place-availability";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must be set explicitly (this script never loads .env files — the target DB must be deliberate).",
    );
  }
  const target = new URL(process.env.DATABASE_URL);
  console.log(
    `backfill-venue-defaults → ${target.hostname}:${target.port || "5432"}${target.pathname}${DRY_RUN ? " (DRY RUN)" : ""}`,
  );

  const prisma = getPrisma();

  // Only places violating the invariant: no default calendar at all. The
  // SQL-only partial unique "Calendar_placeId_default_key" guarantees at most
  // one default per place, so `none: { isDefault: true }` is exact.
  const places = await prisma.place.findMany({
    where: { calendars: { none: { isDefault: true } } },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`places missing a default calendar: ${places.length}`);

  let spacesCreated = 0;
  let calendarsCreated = 0;
  let calendarsPromoted = 0;
  let joinsEnsured = 0;

  for (const place of places) {
    if (DRY_RUN) {
      console.log(`  would backfill: ${place.id} (${place.name})`);
      continue;
    }

    // Space: reuse the place's first space if it has any (a post-hierarchy
    // space the owner made via manage-spaces must not gain a duplicate
    // "Main Space" sibling); otherwise mint the standard default.
    let space = await prisma.space.findFirst({
      where: { placeId: place.id },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    if (!space) {
      space = await prisma.space.create({
        data: { placeId: place.id, name: "Main Space", sortOrder: 0 },
      });
      spacesCreated += 1;
    }

    // Calendar: if the owner already made a calendar slugged "main" (possible
    // via createCalendar, which never sets isDefault), promote it — keeping
    // its owner-chosen name — else create the standard default.
    const existingMain = await prisma.calendar.findUnique({
      where: { placeId_slug: { placeId: place.id, slug: "main" } },
    });
    let calendar;
    if (existingMain) {
      calendar = existingMain.isDefault
        ? existingMain
        : await prisma.calendar.update({
            where: { id: existingMain.id },
            data: { isDefault: true },
          });
      if (!existingMain.isDefault) calendarsPromoted += 1;
    } else {
      calendar = await prisma.calendar.create({
        data: {
          placeId: place.id,
          name: "Main Calendar",
          slug: "main",
          isDefault: true,
        },
      });
      calendarsCreated += 1;
    }

    // Join (idempotent on the (calendarId, spaceId) unique).
    await prisma.calendarSpace.upsert({
      where: {
        calendarId_spaceId: { calendarId: calendar.id, spaceId: space.id },
      },
      update: {},
      create: { calendarId: calendar.id, spaceId: space.id },
    });
    joinsEnsured += 1;

    console.log(
      `  backfilled: ${place.id} (${place.name}) space=${space.id} calendar=${calendar.id}`,
    );
  }

  // ── Phase 2: availability rows ────────────────────────────────────────────
  // Independent of phase 1's place selection: a place can already HAVE a
  // default calendar (so phase 1 skips it) while its hours are still stranded
  // in the legacy table. Both tables are small — this is a one-shot on
  // pre-launch data — so the whole set is read and diffed in memory rather
  // than issuing a per-row existence query.
  //
  // Read over raw SQL, and EMPTY once the drop migration has run — the legacy
  // model no longer exists in the Prisma schema. See the module docblock in
  // ./read-legacy-place-availability for why, and the ORDERING note at the top
  // of this file for the deploy sequencing this depends on.
  const legacyRows = await readLegacyPlaceAvailability(prisma);
  const existingRows = await prisma.calendarAvailability.findMany({
    select: {
      placeId: true,
      calendarId: true,
      dayOfWeek: true,
      date: true,
      startTime: true,
      endTime: true,
      isOpen: true,
    },
  });

  const plannedAvailability = planAvailabilityBackfill(legacyRows, existingRows);
  console.log(
    `\nlegacy PlaceAvailability rows: ${legacyRows.length} (already migrated or otherwise present: ${legacyRows.length - plannedAvailability.length})`,
  );

  let availabilityCreated = 0;
  if (plannedAvailability.length > 0) {
    if (DRY_RUN) {
      for (const row of plannedAvailability) {
        console.log(
          `  would copy availability: place=${row.placeId} dow=${row.dayOfWeek ?? "-"} date=${row.date?.toISOString() ?? "-"} ${row.startTime ?? "-"}–${row.endTime ?? "-"} isOpen=${row.isOpen}`,
        );
      }
    } else {
      // One statement, so a crash mid-way cannot leave a venue with half its
      // hours (the re-run would be correct either way, but a half-open venue
      // between the two runs would take real bookings on closed nights).
      const result = await prisma.calendarAvailability.createMany({
        data: plannedAvailability,
      });
      availabilityCreated = result.count;
      console.log(`  copied availability rows: ${availabilityCreated}`);
    }
  }

  console.log("\nbackfill-venue-defaults summary:");
  console.log(`  places needing backfill: ${places.length}`);
  console.log(`  spaces created:           ${spacesCreated}`);
  console.log(`  calendars created:       ${calendarsCreated}`);
  console.log(`  calendars promoted:      ${calendarsPromoted}`);
  console.log(`  joins ensured:           ${joinsEnsured}`);
  console.log(`  availability rows copied: ${availabilityCreated}`);
  console.log(
    legacyRows.length === 0
      ? "  legacy availability source:  none (table already dropped, or empty)"
      : `  availability rows left in PlaceAvailability: ${legacyRows.length} (source is never deleted)`,
  );
  if (DRY_RUN) console.log("  (DRY RUN — no rows were written.)");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
