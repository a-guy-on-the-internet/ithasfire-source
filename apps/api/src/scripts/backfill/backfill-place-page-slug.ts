/**
 * backfill-place-page-slug.ts — DRY-RUN-BY-DEFAULT repair for places whose
 * public page is unreachable.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `/places/[slug]` and `/p/[slug]` are SINGLE, non-catch-all route segments
 * that resolve `EntityPage.slug`. Two independent paths left venues with no
 * URL that hits them:
 *
 *   (A) NO PAGE AT ALL. `places.bulkCreate` was a plain `createMany` of the
 *       Place columns — no EntityPage write. Every bulk-imported venue landed
 *       with nothing to route to, reachable only via the `/places/id/[placeId]`
 *       fallback that nothing links to. Fixed forward in `bulkImportPlaces`,
 *       which now mints a page per row in the import transaction.
 *
 *   (B) A MULTI-SEGMENT PAGE SLUG. The dev seed copied `Place.slug` — the
 *       DIRECTORY key, shaped `us/tn/name--a1b2c3d4e5`, literal `/` included —
 *       straight into `EntityPage.slug`. A value with a `/` in it can never
 *       match a single-segment route, so those pages 404 twice over: wrong
 *       path shape AND wrong column. Fixed forward in
 *       `seed/entity-pages.ts`, which now calls `buildPageSlug`.
 *
 * Both fixes are write-path only. This script repairs rows already in a
 * database, deriving the slug from `buildPageSlug` — the SAME helper the
 * create path uses — so a repaired row is indistinguishable from one
 * `upsertPlace` wrote.
 *
 * ── What it deliberately does NOT touch ─────────────────────────────────────
 * A FLAT page slug, even a non-canonical one. `the-fillmore-san-francisco` has
 * no `/`, so it resolves today: it is a WORKING public URL, and it may have
 * been chosen by the venue's owner in the page editor. Rewriting it to the
 * canonical `{name}-{id8}` form would break a live link to fix nothing. Only
 * slugs containing `/` — which have never resolved and cannot — are rewritten.
 *
 * ── PageSlugHistory ─────────────────────────────────────────────────────────
 * NOT recorded, deliberately. `PageSlugHistory` exists so a previously WORKING
 * URL keeps redirecting after a rename. The slugs this script replaces never
 * worked: a `/`-bearing value could not match `/places/[slug]` on any request
 * that has ever been served, so there is no inbound link, bookmark, or indexed
 * URL to preserve. Writing history rows would add dead entries to a globally
 * unique index and give `resolveSlugHistory` strings it can never be asked
 * for. If a future run is ever widened to rewrite FLAT slugs, that changes —
 * those DO resolve, and history would then be mandatory.
 *
 * ── Safety properties ───────────────────────────────────────────────────────
 *   - Nothing is written unless `--apply` is passed.
 *   - Keyset pagination by `id`; one `update` per row, scoped to that id,
 *     setting ONLY `slug`. No transaction spans the batch — a several-hundred
 *     row repair must not hold one open, and each row is independent.
 *   - Every write is compare-and-swap guarded on the slug still being the one
 *     that was planned, so a concurrent edit loses the race rather than being
 *     clobbered.
 *   - A unique collision on the target slug is caught per-row and reported
 *     rather than failing the run.
 *   - `--apply` against a non-local database requires
 *     `--confirm-remote-host=<host>` matching the resolved hostname.
 *
 * USAGE — run from the REPO ROOT:
 *
 *   # dry run (local dev)
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dev?schema=public \
 *     pnpm exec tsx apps/api/src/scripts/backfill/backfill-place-page-slug.ts
 *
 *   # apply (local dev)
 *   DATABASE_URL=... pnpm exec tsx \
 *     apps/api/src/scripts/backfill/backfill-place-page-slug.ts --apply
 *
 *   # apply (remote)
 *   DATABASE_URL=<neon-url> pnpm exec tsx \
 *     apps/api/src/scripts/backfill/backfill-place-page-slug.ts \
 *     --apply --confirm-remote-host=<host>
 *
 *   # one phase only
 *   ... backfill-place-page-slug.ts --only=slugs     # (B) rewrite unreachable slugs
 *   ... backfill-place-page-slug.ts --only=missing   # (A) mint absent pages
 */

import "dotenv/config";
import { parseArgs } from "node:util";

import { getPrisma } from "@th/db";
import { buildPageSlug } from "@th/core/use-cases/places/_shared/page-slug";

const SCRIPT_NAME = "backfill-place-page-slug";
const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
]);

/** Keyset page size. Small enough that no single query is a memory event. */
const PAGE_SIZE = 200;

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    "confirm-remote-host": { type: "string" },
    only: { type: "string" },
    limit: { type: "string" },
  },
  strict: false,
  allowPositionals: true,
});

const APPLY = values.apply === true;
const LIMIT = values.limit ? Number(values.limit) : undefined;
const ONLY = typeof values.only === "string" ? values.only : undefined;

if (ONLY !== undefined && ONLY !== "slugs" && ONLY !== "missing") {
  throw new Error(`--only must be "slugs" or "missing" (got "${ONLY}")`);
}

const RUN_SLUGS = ONLY === undefined || ONLY === "slugs";
const RUN_MISSING = ONLY === undefined || ONLY === "missing";

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

type SlugStats = {
  scanned: number;
  planned: number;
  written: number;
  collision: number;
  skippedDrift: number;
  alreadyCanonical: number;
};

type MissingStats = {
  scanned: number;
  written: number;
  collision: number;
};

/**
 * (B) Rewrite PLACE page slugs that contain a `/` — the unreachable
 * multi-segment shape copied from `Place.slug`.
 */
async function repairUnreachableSlugs(
  prisma: ReturnType<typeof getPrisma>,
): Promise<SlugStats> {
  const stats: SlugStats = {
    scanned: 0,
    planned: 0,
    written: 0,
    collision: 0,
    skippedDrift: 0,
    alreadyCanonical: 0,
  };

  let cursor: string | undefined;

  for (;;) {
    if (LIMIT !== undefined && stats.scanned >= LIMIT) break;

    const take =
      LIMIT !== undefined ? Math.min(PAGE_SIZE, LIMIT - stats.scanned) : PAGE_SIZE;

    const pages = await prisma.entityPage.findMany({
      where: {
        ownerType: "PLACE",
        // The clear signal: a `/` can never match a single-segment route.
        slug: { contains: "/" },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true, ownerId: true, slug: true },
      orderBy: { id: "asc" },
      take,
    });

    if (pages.length === 0) break;
    cursor = pages[pages.length - 1]!.id;

    // The page carries no name — the PLACE does. One batched read per page of
    // results, not one per row.
    const places = await prisma.place.findMany({
      where: { id: { in: pages.map((pg) => pg.ownerId) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(places.map((pl) => [pl.id, pl.name]));

    for (const page of pages) {
      stats.scanned += 1;

      const name = nameById.get(page.ownerId);
      if (name === undefined) {
        // An EntityPage whose owner place is gone. Not this script's problem
        // — renaming an orphan's slug fixes nothing — but worth surfacing.
        console.log(
          `  ORPHAN ${page.id} — no Place ${page.ownerId} (slug=${page.slug})`,
        );
        continue;
      }

      const target = buildPageSlug(name, page.ownerId);
      if (target === page.slug) {
        stats.alreadyCanonical += 1;
        continue;
      }
      stats.planned += 1;

      console.log(
        `  ${APPLY ? "write" : "plan "} ${page.id} (${name}) ${page.slug} → ${target}`,
      );

      if (!APPLY) continue;

      try {
        // CAS on the slug we planned against: an owner renaming the page
        // mid-run wins.
        const res = await prisma.entityPage.updateMany({
          where: { id: page.id, slug: page.slug },
          data: { slug: target },
        });
        if (res.count === 0) {
          stats.skippedDrift += 1;
          console.log(`         SKIPPED — row drifted since it was planned`);
          continue;
        }
        stats.written += 1;
      } catch (err) {
        // `EntityPage.slug` is globally unique across every owner type, so a
        // taken target is per-row recoverable — report and keep going rather
        // than losing the rest of a several-hundred-row repair.
        const code = (err as { code?: string })?.code;
        if (code === "P2002") {
          stats.collision += 1;
          console.log(`         SKIPPED — slug already taken (${target})`);
          continue;
        }
        throw err;
      }
    }
  }

  return stats;
}

/**
 * (A) Mint an EntityPage for PLACE rows that have none — what every
 * bulk-imported venue looks like before the `bulkImportPlaces` fix.
 */
async function mintMissingPages(
  prisma: ReturnType<typeof getPrisma>,
): Promise<MissingStats> {
  const stats: MissingStats = { scanned: 0, written: 0, collision: 0 };

  let cursor: string | undefined;

  for (;;) {
    if (LIMIT !== undefined && stats.scanned >= LIMIT) break;

    // Fixed page size here (unlike the slug pass): `scanned` counts PAGELESS
    // places, but the keyset walks EVERY place, so it is not a row budget for
    // the query — `--limit` caps how many pages get minted, nothing more.
    const places = await prisma.place.findMany({
      where: cursor ? { id: { gt: cursor } } : {},
      select: { id: true, name: true },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
    });

    if (places.length === 0) break;
    cursor = places[places.length - 1]!.id;

    // `EntityPage` has no FK to `Place` (ownerId is a polymorphic column), so
    // the "has a page" check is a second batched read, not a join.
    const existing = await prisma.entityPage.findMany({
      where: { ownerType: "PLACE", ownerId: { in: places.map((pl) => pl.id) } },
      select: { ownerId: true },
    });
    const hasPage = new Set(existing.map((pg) => pg.ownerId));

    for (const place of places) {
      if (LIMIT !== undefined && stats.scanned >= LIMIT) break;
      if (hasPage.has(place.id)) continue;
      stats.scanned += 1;

      const slug = buildPageSlug(place.name, place.id);
      console.log(
        `  ${APPLY ? "write" : "plan "} page for ${place.id} (${place.name}) slug=${slug}`,
      );

      if (!APPLY) continue;

      try {
        // `create`, not `upsert`: the read above already established there is
        // no page, and a create surfaces a genuine race as P2002 instead of
        // rewriting a page that appeared in between.
        await prisma.entityPage.create({
          data: {
            ownerType: "PLACE",
            ownerId: place.id,
            slug,
            displayName: place.name,
            // Same call as the import path: a scraped venue has no bio worth
            // inventing on its unclaimed operator's behalf.
            bio: null,
          },
        });
        stats.written += 1;
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === "P2002") {
          stats.collision += 1;
          console.log(`         SKIPPED — unique collision (slug=${slug})`);
          continue;
        }
        throw err;
      }
    }
  }

  return stats;
}

async function main() {
  const host = resolveDbHost();
  assertWriteAllowed(host);

  console.log(
    `${SCRIPT_NAME} — ${APPLY ? "APPLY" : "DRY RUN"} against ${host}\n`,
  );

  const prisma = getPrisma();

  let slugStats: SlugStats | null = null;
  let missingStats: MissingStats | null = null;

  if (RUN_SLUGS) {
    console.log("(B) PLACE pages with an unreachable multi-segment slug:");
    slugStats = await repairUnreachableSlugs(prisma);
    console.log("");
  }

  if (RUN_MISSING) {
    console.log("(A) Places with no EntityPage at all:");
    missingStats = await mintMissingPages(prisma);
    console.log("");
  }

  console.log(`${SCRIPT_NAME} summary (${APPLY ? "APPLIED" : "DRY RUN"}):`);
  if (slugStats) {
    console.log(`  slugs scanned:      ${slugStats.scanned}`);
    console.log(`  slugs planned:      ${slugStats.planned}`);
    console.log(`  slugs rewritten:    ${slugStats.written}`);
    console.log(`  already canonical:  ${slugStats.alreadyCanonical}`);
    console.log(`  slug collisions:    ${slugStats.collision}`);
    console.log(`  skipped (drift):    ${slugStats.skippedDrift}`);
  }
  if (missingStats) {
    console.log(`  pageless places:    ${missingStats.scanned}`);
    console.log(`  pages minted:       ${missingStats.written}`);
    console.log(`  mint collisions:    ${missingStats.collision}`);
  }
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
