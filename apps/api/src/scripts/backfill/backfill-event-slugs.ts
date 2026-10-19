/**
 * Backfill `Event.slug` / `Event.shortId` for slugless events.
 *
 * Context. Until slug-at-create landed, `publish-event` was the ONLY writer of
 * `Event.slug`, so in any existing database EVERY never-published event is
 * slugless — and a slugless event's public page used to 500 rather than
 * render. New events are slugged at create now; that original pass brought the
 * existing ones up to the same state.
 *
 * NOT A SPENT ONE-SHOT — DO NOT ARCHIVE IT. Slug assignment happens AFTER the
 * create commits, in its own transaction, so a crash in that window still
 * leaves a slugless event TODAY. That window is an accepted trade, not a bug,
 * and it is only acceptable because this script stays runnable: see
 * `packages/core/src/use-cases/events/_shared/assign-slug-on-create.ts`
 * ("THE COST, ACCEPTED DELIBERATELY"), plus `save-event-shared.ts`,
 * `series/generate-events-from-series.ts` and
 * `booking-requests/_shared/accept-mint.ts`, all of which name this script as
 * the repair. It selects only slugless events, so re-running it is a no-op.
 * Keep `pnpm -F api backfill:event-slugs` alive.
 *
 * WHAT IT DOES, per slugless event (paged on `id` ascending):
 *   - read the same `getSlugContext` projection the use cases read (the
 *     event's own country/region/locality, falling back through its linked
 *     SavedLocation and Place);
 *   - SKIP the row when that yields no country code — `generateEventSlug`
 *     refuses to build a slug without one, and inventing a placeholder country
 *     would bake a wrong, permanent URL into a page people can link to;
 *   - otherwise write `slug` + `shortId` + `regionCode`, mirroring
 *     `events.assignSlug`.
 *
 * NO `EventSlugHistory` ROWS ARE WRITTEN. That table means SUPERSEDED slugs
 * only. These events never had a slug, so nothing has been superseded, and
 * `EventSlugHistory.slug` is GLOBALLY unique — writing the current slug there
 * would break the first later `regenerateEventSlug` on P2002.
 *
 * PUBLISHED EVENTS ARE NOT TOUCHED beyond the same rule: publish assigns a
 * slug in its own transaction, so a PUBLISHED row with no slug is a genuine
 * anomaly rather than the expected state. It is still filled in here (the
 * selection is "no slug", not "is a draft") because a live event with no URL
 * is strictly worse than one with a derived one.
 *
 * PHASE 2 — PRUNE SELF-REFERENTIAL EventSlugHistory ROWS. Until slug-at-create
 * landed, `publish-event` recorded the NEW slug in history at publish time,
 * while `regenerateEventSlug` records the PREVIOUS one. Every event published
 * before this change therefore has its own LIVE slug sitting in
 * `EventSlugHistory` — and because `EventSlugHistory.slug` is GLOBALLY
 * `@unique`, the first rename-and-regenerate on any of those events throws a
 * raw P2002. Phase 2 deletes history rows whose `slug` equals the owning
 * event's current `slug`.
 *
 * Deleting them is a pure no-op for redirects: `resolveBySlug` checks
 * `Event.slug` FIRST and only falls through to history on a miss, so a history
 * row for the current slug is unreachable by construction. Nothing that
 * resolves today stops resolving.
 *
 * IDEMPOTENT. Phase 1's selection is `slug: null`, so a second run only sees
 * rows the first run skipped (no country code) or could not write. Nothing is
 * ever overwritten, and a slug the organiser later regenerates is never
 * revisited. Phase 2 selects on an equality that its own deletes remove, so a
 * second run finds nothing.
 *
 * A UNIQUE-CONSTRAINT COLLISION ON ONE ROW DOES NOT STOP THE RUN. Each event
 * is written in its own statement and a P2002 is counted and reported at the
 * end rather than thrown — one pathological row must not strand the other ten
 * thousand.
 *
 * SIDE EFFECT ON THE SITEMAP: `Event.updatedAt` is `@updatedAt`, and
 * `listPublishedForSitemap` surfaces it as `<lastmod>`. Writing a slug
 * therefore re-dates the sitemap entry for every PUBLISHED event this touches,
 * so a run will look to crawlers like a bulk content update. Harmless, but do
 * not run it the same week you are debugging crawl behaviour.
 *
 * Usage (from the repo root — `DATABASE_URL` is REQUIRED and never read from a
 * .env file, so the target database is always a deliberate choice):
 *
 *   DATABASE_URL=postgresql://... pnpm -F api backfill:event-slugs --dry-run
 *   DATABASE_URL=postgresql://... pnpm -F api backfill:event-slugs
 *
 * Note `pnpm -F api backfill:event-slugs -- --dry-run` does NOT work: pnpm
 * drops the `--` and everything after it silently, so the flag never arrives
 * and the run is LIVE. Pass the flag without the separator, as above.
 */

import { getPrisma } from "@th/db";
import { generateEventSlug } from "@th/core/use-cases/events/_shared/slug";
import { isAppError } from "@th/errors";

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = 500;

/** Mirrors the adapter's `SLUG_CONTEXT_SELECT` so both derive the same slug. */
const SLUG_CONTEXT_SELECT = {
  id: true,
  orgId: true,
  humanId: true,
  title: true,
  startsAt: true,
  timezone: true,
  shortId: true,
  countryCode: true,
  region: true,
  locality: true,
  status: true,
  org: { select: { name: true } },
  place: { select: { city: true, region: true, country: true } },
  savedLocation: {
    select: { locality: true, region: true, countryCode: true },
  },
} as const;

/**
 * One page of slugless events, keyed on `id > cursor`.
 *
 * NOT Prisma's `cursor` + `skip: 1`. That combination is only correct when the
 * cursor row is still in the result set on the next page, and here it never is:
 * this script WRITES a slug to every row it processes, including the last one
 * of the batch, so on the next call that row no longer satisfies `slug: null`,
 * is absent from the matched set, and the `skip: 1` OFFSET — which is applied
 * AFTER the WHERE — eats a genuine unprocessed row instead.
 *
 * With 501 slugless events that meant: batch 1 handled rows 1-500 and set the
 * cursor to id500; batch 2 matched exactly [row501], OFFSET 1 discarded it,
 * length 0, loop exits. The summary printed "501 found / 500 assigned / 0
 * skipped / 0 failures" and exited 0. `--dry-run` writes nothing, so the cursor
 * row stayed in the set and the dry run reported 501 — the dry run and the live
 * run disagreed, which is the worst possible way to find this out.
 *
 * `id > cursor` has no such coupling: it is evaluated as part of the WHERE, so
 * rows leaving the `slug: null` set cannot shift anything, and skipped rows
 * (no country code) are simply behind the cursor and not revisited.
 *
 * Extracted rather than inlined for a type reason too: with the query inline
 * the result type depends on the cursor clause and `cursor` is assigned FROM
 * the result — a cycle tsc refuses to infer (TS7022). An annotated PARAMETER
 * breaks it.
 */
async function readSluglessBatch(
  prisma: ReturnType<typeof getPrisma>,
  cursor: string | null,
) {
  return prisma.event.findMany({
    where: {
      slug: null,
      ...(cursor ? { id: { gt: cursor } } : {}),
    },
    select: SLUG_CONTEXT_SELECT,
    orderBy: { id: "asc" },
    take: BATCH_SIZE,
  });
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must be set explicitly (this script never loads .env files — the target DB must be deliberate).",
    );
  }
  const target = new URL(process.env.DATABASE_URL);
  console.log(
    `backfill-event-slugs → ${target.hostname}:${target.port || "5432"}${target.pathname}${DRY_RUN ? " (DRY RUN)" : ""}`,
  );

  const prisma = getPrisma();

  const total = await prisma.event.count({ where: { slug: null } });
  console.log(`events with no slug: ${total}`);

  let assigned = 0;
  let skippedNoCountry = 0;
  let conflicts = 0;
  let failures = 0;
  // Keyset pagination on the primary key. A plain offset would drift as rows
  // leave the `slug: null` set under us; cursoring on `id` cannot skip a row.
  let cursor: string | null = null;

  for (;;) {
    const batch = await readSluglessBatch(prisma, cursor);
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.id;

    for (const row of batch) {
      const countryCode =
        row.countryCode ??
        row.savedLocation?.countryCode ??
        row.place?.country ??
        null;
      const regionCode =
        row.region ?? row.savedLocation?.region ?? row.place?.region ?? null;
      const cityOrRegionCode =
        row.locality ??
        row.savedLocation?.locality ??
        row.place?.city ??
        regionCode ??
        null;

      let generated;
      try {
        generated = generateEventSlug({
          eventId: row.id,
          orgId: row.orgId,
          humanId: row.humanId,
          eventTitle: row.title,
          startsAt: row.startsAt,
          timezone: row.timezone,
          orgName: row.org?.name ?? null,
          countryCode,
          regionCode,
          cityOrRegionCode,
          shortId: row.shortId ?? null,
        });
      } catch (error) {
        if (isAppError(error) && error.code === "EVENT_LOCATION_REQUIRED") {
          skippedNoCountry += 1;
          continue;
        }
        failures += 1;
        console.error(`  FAILED to derive slug for ${row.id}:`, error);
        continue;
      }

      if (DRY_RUN) {
        console.log(`  would assign: ${row.id} (${row.status}) → ${generated.slug}`);
        assigned += 1;
        continue;
      }

      try {
        await prisma.event.update({
          where: { id: row.id },
          data: {
            slug: generated.slug,
            shortId: generated.shortId,
            regionCode: generated.regionCode,
          },
        });
        assigned += 1;
      } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        if (code === "P2002") {
          conflicts += 1;
          console.error(
            `  CONFLICT on ${row.id} → ${generated.slug} (left slugless; re-run after resolving)`,
          );
          continue;
        }
        failures += 1;
        console.error(`  FAILED to write slug for ${row.id}:`, error);
      }
    }
  }

  // ── Phase 2: prune self-referential EventSlugHistory rows ────────────────
  const prunedHistory = await pruneSelfReferentialSlugHistory(prisma);

  console.log("\nbackfill-event-slugs summary:");
  console.log(`  events with no slug:       ${total}`);
  console.log(`  slugs assigned:            ${assigned}`);
  console.log(`  skipped (no country code): ${skippedNoCountry}`);
  console.log(`  unique conflicts:          ${conflicts}`);
  console.log(`  other failures:            ${failures}`);
  console.log(`  history rows pruned:       ${prunedHistory}`);
  if (DRY_RUN) console.log("  (DRY RUN — no rows were written.)");

  // ── Reconciliation ───────────────────────────────────────────────────────
  // Every selected row must land in exactly one bucket. This is not a vanity
  // total: the pagination bug this script shipped with silently dropped one
  // row per batch, and the ONLY thing that would have caught it is this
  // arithmetic — the run reported "501 found / 500 assigned / 0 skipped / 0
  // failures" and exited 0. A summary that cannot disagree with itself is not
  // a summary, it is a decoration.
  //
  // Rows created between the initial COUNT and the paging can legitimately
  // widen the tally, so the check is one-directional: more accounted for than
  // counted is fine, fewer is a bug.
  const accountedFor = assigned + skippedNoCountry + conflicts + failures;
  if (accountedFor < total) {
    console.error(
      `\n  UNACCOUNTED: counted ${total} slugless events but only handled ${accountedFor}. ` +
        `${total - accountedFor} row(s) were never visited — do NOT treat this run as complete.`,
    );
    process.exitCode = 1;
  }

  if (conflicts > 0 || failures > 0) {
    process.exitCode = 1;
  }
}

/**
 * Delete `EventSlugHistory` rows whose slug is the owning event's CURRENT slug.
 *
 * Why they exist: before slug-at-create, `publish-event` filed the NEW slug in
 * history at publish time, while `regenerateEventSlug` files the PREVIOUS one.
 * So every event published before this change carries its own live slug in a
 * globally-unique column, and the first rename-and-regenerate on it throws a
 * raw P2002 — which, raised from inside a transaction, is far worse than a
 * visible error (a failed statement aborts the transaction and the COMMIT that
 * follows is answered with ROLLBACK and no error).
 *
 * Why deleting them is safe: `resolveBySlug` matches `Event.slug` FIRST and
 * only consults history on a miss, so a history row equal to the current slug
 * can never be the row that answers a request. No redirect changes.
 *
 * Compared in memory rather than in SQL: Prisma cannot express a column-to-
 * column predicate in `where`, and the alternative is `$queryRaw`, which this
 * codebase avoids. The table holds one row per rename, so it is small; it is
 * still paged rather than slurped whole.
 */
async function pruneSelfReferentialSlugHistory(
  prisma: ReturnType<typeof getPrisma>,
): Promise<number> {
  let cursor: string | null = null;
  let pruned = 0;

  for (;;) {
    const rows = await readSlugHistoryBatch(prisma, cursor);
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    const redundant = rows
      .filter((row) => row.event.slug !== null && row.event.slug === row.slug)
      .map((row) => row.id);

    if (redundant.length === 0) continue;

    if (DRY_RUN) {
      for (const row of rows) {
        if (redundant.includes(row.id)) {
          console.log(
            `  would prune history row ${row.id}: ${row.slug} (== event ${row.eventId}'s current slug)`,
          );
        }
      }
      pruned += redundant.length;
      continue;
    }

    const result = await prisma.eventSlugHistory.deleteMany({
      where: { id: { in: redundant } },
    });
    pruned += result.count;
  }

  return pruned;
}

/** One page of history rows with the owning event's current slug attached. */
async function readSlugHistoryBatch(
  prisma: ReturnType<typeof getPrisma>,
  cursor: string | null,
) {
  return prisma.eventSlugHistory.findMany({
    where: cursor ? { id: { gt: cursor } } : {},
    select: {
      id: true,
      slug: true,
      eventId: true,
      event: { select: { slug: true } },
    },
    orderBy: { id: "asc" },
    take: BATCH_SIZE,
  });
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
