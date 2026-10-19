/**
 * backfill-place-timezone.ts — DRY-RUN-BY-DEFAULT backfill of `Place.timezone`
 * for the venues `places.bulkImportPlaces` leaves null.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `upsertPlace` derives a timezone on create. The bulk import path does not:
 * `bulkCreate` is a plain `createMany` of the columns the import row carries,
 * so a bulk-imported venue lands with `timezone = null`.
 *
 * That is not cosmetic. `timezone` is the IANA zone every Calendar wall-clock
 * default resolves through (venue-hierarchy FR-004). A null zone at a venue is
 * what turns "doors at 7:00 PM" into an event whose local time depends on
 * whatever the caller happened to fall back to.
 *
 * It is backfilled the SAME way the create path derives it — by calling the
 * tz-lookup adapter, not by reimplementing the lookup here — so a backfilled
 * row is indistinguishable from one written by `upsertPlace`.
 *
 * ── This script used to also fill `Place.slug` ──────────────────────────────
 * It no longer does, and must not be taught to again. `Place.slug` was a
 * multi-segment directory key (`{country}/{region}/{name}--{shortId}`, literal
 * `/` included) that NO route ever resolved: `/places/[slug]` and `/p/[slug]`
 * are single non-catch-all segments and they resolve the place's
 * `EntityPage.slug`, a separate FLAT slug (`{name}-{id8}`). The column is
 * deprecated and nothing mints or reads it any more. Bulk-imported venues get
 * their public page from the `EntityPage` row `bulkImportPlaces` creates with
 * `buildPageSlug`; there is nothing left for a slug backfill to do.
 *
 * ── Safety properties ───────────────────────────────────────────────────────
 *   - Nothing is written unless `--apply` is passed.
 *   - Only rows where `timezone` is still NULL are selected; a venue that
 *     already has a derived timezone is never touched.
 *   - Every write is a Prisma `update` scoped to ONE id, setting ONLY the
 *     column this script names. It deliberately does NOT route through
 *     `upsertPlace` / `tx.places.upsert`, which rebuild the whole row from
 *     their input and have silently wiped geo/capacity/status before.
 *   - The write is compare-and-swap guarded on `timezone` still being null, so
 *     a concurrent edit mid-run loses the race rather than being clobbered.
 *   - `--apply` against a non-local database requires
 *     `--confirm-remote-host=<host>` matching the resolved hostname.
 *
 * USAGE — run from the REPO ROOT:
 *
 *   # dry run (local dev)
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dev?schema=public \
 *     pnpm exec tsx apps/api/src/scripts/backfill/backfill-place-timezone.ts
 *
 *   # apply (local dev)
 *   DATABASE_URL=... pnpm exec tsx \
 *     apps/api/src/scripts/backfill/backfill-place-timezone.ts --apply
 *
 *   # apply (remote)
 *   DATABASE_URL=<neon-url> pnpm exec tsx \
 *     apps/api/src/scripts/backfill/backfill-place-timezone.ts \
 *     --apply --confirm-remote-host=<host>
 */

import "dotenv/config";
import { parseArgs } from "node:util";

import { getPrisma } from "@th/db";
import { createTzLookupAdapter } from "@th/adapters/timezone-lookup";

const SCRIPT_NAME = "backfill-place-timezone";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal"]);

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    "confirm-remote-host": { type: "string" },
    limit: { type: "string" },
  },
  strict: false,
  allowPositionals: true,
});

const APPLY = values.apply === true;
const LIMIT = values.limit ? Number(values.limit) : undefined;

function resolveDbHost(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  try {
    return new URL(url).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a parseable URL");
  }
}

function assertWriteAllowed(host: string): void {
  if (!APPLY || LOCAL_HOSTS.has(host)) return;
  const confirmed = values["confirm-remote-host"];
  if (confirmed !== host) {
    throw new Error(
      `Refusing to --apply against remote host "${host}".\n` +
        `Re-run with --confirm-remote-host=${host} if that is intended.`,
    );
  }
}

async function main() {
  const host = resolveDbHost();
  assertWriteAllowed(host);

  console.log(`${SCRIPT_NAME} — ${APPLY ? "APPLY" : "DRY RUN"} against ${host}\n`);

  const prisma = getPrisma();
  const tzLookup = createTzLookupAdapter();

  const places = await prisma.place.findMany({
    where: { timezone: null },
    select: {
      id: true, name: true, timezone: true, lat: true, lng: true,
    },
    orderBy: { createdAt: "asc" },
    ...(LIMIT ? { take: LIMIT } : {}),
  });

  console.log(`${places.length} place(s) missing a timezone.\n`);
  if (places.length === 0) return;

  const stats = {
    tzPlanned: 0, tzWritten: 0, tzNoGeo: 0, tzLookupFailed: 0,
    skippedDrift: 0,
  };

  for (const place of places) {
    if (place.lat === null || place.lng === null) {
      // No coordinates, no derivation. Guessing from region would be worse
      // than null: the port's contract is that unknown stays unknown.
      stats.tzNoGeo += 1;
      continue;
    }

    let tz: string | null = null;
    try {
      tz = tzLookup(place.lat, place.lng);
    } catch {
      tz = null;
    }
    if (!tz) {
      stats.tzLookupFailed += 1;
      continue;
    }
    stats.tzPlanned += 1;

    console.log(`  ${APPLY ? "write" : "plan "} ${place.id} (${place.name}) tz=${tz}`);

    if (!APPLY) continue;

    // Compare-and-swap on the column still being null: a concurrent edit
    // mid-run loses the race rather than being clobbered.
    const res = await prisma.place.updateMany({
      where: { id: place.id, timezone: null },
      data: { timezone: tz },
    });
    if (res.count === 0) {
      stats.skippedDrift += 1;
      console.log(`         SKIPPED — row drifted since it was planned`);
      continue;
    }
    stats.tzWritten += 1;
  }

  console.log(`\n${SCRIPT_NAME} summary (${APPLY ? "APPLIED" : "DRY RUN"}):`);
  console.log(`  timezones planned:  ${stats.tzPlanned}`);
  console.log(`  timezones written:  ${stats.tzWritten}`);
  console.log(`  no coordinates:     ${stats.tzNoGeo}`);
  console.log(`  tz lookup failed:   ${stats.tzLookupFailed}`);
  console.log(`  skipped (drift):    ${stats.skippedDrift}`);
  if (!APPLY) console.log(`\nNothing was written. Re-run with --apply.`);
}

main()
  .catch((err) => {
    console.error(`${SCRIPT_NAME} failed:`, err);
    process.exit(1);
  })
  .finally(async () => {
    await getPrisma().$disconnect();
  });
