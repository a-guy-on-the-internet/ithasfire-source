/**
 * Correct the date segment of event slugs minted in UTC (owner ruling
 * 2026-10-15).
 *
 * Until ba1a3df50 the slug's `YYYY-MM-DD-HHmm` was the UTC start, so every
 * evening event's URL is dated a day late (a Mon 12 Oct 19:00 Chicago show
 * has `…-2026-10-13-0000--<shortId>`). This rewrites those slugs to the local
 * start in `Event.timezone`, through the core use case
 * `correctEventSlugDates` (see it for the rules): only the date segment
 * changes, the old slug goes to `EventSlugHistory` so old links keep
 * resolving, one `event.slug_date_corrected` audit row per event, and a
 * per-event search reindex mark for PUBLISHED events. No full reindex.
 *
 * Every event with a slug is scanned, any status: old links exist for
 * archived, cancelled and past events too. Slugs whose segment matches
 * neither the UTC nor the local start (`start_moved`: the start was edited
 * after the slug was made) are left alone and listed.
 *
 * `--utc-minted-before=<ISO instant>` (opt-in): events created before this
 * instant also get their slug's segment READ AS UTC and re-rendered in the
 * event's zone (`basis: slug_instant`). That catches recurring series, whose
 * `startsAt` mirrors the next occurrence so the slug never matches it. The
 * instant must be NO LATER than the moment the ba1a3df50 API revision FIRST
 * took traffic (until then every slug was minted in UTC): use the deploy
 * START, rounded earlier if unsure. A later one would shift slugs already
 * minted in local time. Whether the CURRENT slug was minted before the cutoff is read from
 * the event's newest slug-writing audit row: one written at/after the cutoff
 * (a draft first published after the deploy) is `minted_after_cutoff` and
 * left alone. A slug written with no audit row (the one-off
 * `backfill-event-slugs.ts`) is not seen; check the dry run's `slug_instant`
 * rows before applying. Requires an explicit offset (`Z` or `±HH:MM`).
 *
 * RUN ORDER: until ba1a3df50 is deployed, prod keeps minting UTC slugs (new
 * events, first-publish re-derives). A run before the deploy leaves those
 * behind, so run it AGAIN after the deploy, with the cutoff at the deploy
 * time. That second run also re-fixes an event corrected by the first run and
 * then re-minted in UTC by the old code. After the second run, review the
 * printed `minted_after_cutoff` list.
 *
 * DRY RUN BY DEFAULT: classifies and prints, writes nothing. `--apply` writes.
 * IDEMPOTENT: a `current_start` correction classifies as already correct on
 * the next run by itself; a `slug_instant` one only through the audit gate
 * (this backfill's `event.slug_date_corrected` row; see the use case).
 * A failure on one event is listed and does not stop the run (exit code 1).
 *
 * SIDE EFFECT: `Event.updatedAt` moves on each corrected row, which re-dates
 * that event's sitemap `<lastmod>`.
 *
 * Usage (from the repo root; `DATABASE_URL` is REQUIRED and never read from a
 * .env file, so the target database is always a deliberate choice):
 *
 *   DATABASE_URL=postgresql://... pnpm -F api backfill:event-slug-dates
 *   DATABASE_URL=postgresql://... pnpm -F api backfill:event-slug-dates --apply
 *   DATABASE_URL=postgresql://... pnpm -F api backfill:event-slug-dates --utc-minted-before=2026-10-14T00:00:00Z
 *   DATABASE_URL=postgresql://... pnpm -F api backfill:event-slug-dates --utc-minted-before=2026-10-14T00:00:00Z --apply
 *
 * Do not put `--` before the flags: pnpm drops it and everything after it.
 */
import { getPrisma } from "@th/db";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import {
  correctEventSlugDates,
  type SlugDateOutcome,
  type SlugDateRowResult,
} from "@th/core/use-cases/events/correct-event-slug-dates";

const PAGE_SIZE = 200;
const SAMPLE_SIZE = 20;
const CUTOFF_FLAG = "--utc-minted-before";
// A full ISO-8601 instant with an explicit offset: a bare local time would
// depend on the machine's TZ.
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** `Date` rolls 30 Feb over to 2 Mar; reject a day the month does not have. */
function isRealCalendarDate(value: string): boolean {
  const [y, m, d] = value.slice(0, 10).split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

/** `--utc-minted-before=<ISO instant>`, validated; null when absent. */
function parseCutoff(argv: string[]): Date | null {
  const args = argv.filter(
    (a) => a === CUTOFF_FLAG || a.startsWith(`${CUTOFF_FLAG}=`),
  );
  if (args.length === 0) return null;
  if (args.length > 1) throw new Error(`${CUTOFF_FLAG} given more than once`);
  const value = args[0]!.slice(CUTOFF_FLAG.length + 1);
  const date = new Date(value);
  if (
    !ISO_INSTANT.test(value) ||
    !isRealCalendarDate(value) ||
    Number.isNaN(date.getTime())
  ) {
    throw new Error(
      `${CUTOFF_FLAG} needs an ISO instant with an offset, e.g. ${CUTOFF_FLAG}=2026-10-14T00:00:00Z (got ${JSON.stringify(value)})`,
    );
  }
  if (date.getTime() > Date.now()) {
    throw new Error(`${CUTOFF_FLAG} is in the future: ${date.toISOString()}`);
  }
  return date;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must be set explicitly (this script never loads .env files — the target DB must be deliberate).",
    );
  }
  const apply = process.argv.includes("--apply");
  const utcMintedBefore = parseCutoff(process.argv.slice(2));
  const target = new URL(process.env.DATABASE_URL);
  console.log(
    `correct-event-slug-dates → ${target.hostname}:${target.port || "5432"}${target.pathname}${apply ? " (APPLY)" : " (DRY RUN)"}`,
  );
  console.log(
    utcMintedBefore
      ? `  utc-minted-before: ${utcMintedBefore.toISOString()} (slugs of events created before it are also read as UTC)`
      : "  utc-minted-before: not set (current-start rule only)",
  );

  const repos = createPrismaRepos(getPrisma());
  const deps = { repos, clock: { now: () => new Date() } };

  const totals: Record<SlugDateOutcome, number> = {
    corrected: 0,
    already_correct: 0,
    start_moved: 0,
    unparseable: 0,
    minted_after_cutoff: 0,
    gone: 0,
    failed: 0,
  };
  const corrected: SlugDateRowResult[] = [];
  const flagged: SlugDateRowResult[] = [];
  let scanned = 0;
  let afterId: string | null = null;

  for (;;) {
    const page = await correctEventSlugDates(deps, {
      afterId,
      limit: PAGE_SIZE,
      apply,
      utcMintedBefore,
    });
    scanned += page.scanned;
    for (const key of Object.keys(totals) as SlugDateOutcome[]) {
      totals[key] += page.counts[key];
    }
    for (const row of page.rows) {
      if (row.outcome === "corrected") corrected.push(row);
      else if (row.outcome !== "already_correct") flagged.push(row);
    }
    if (!page.nextAfterId) break;
    afterId = page.nextAfterId;
  }

  const verb = apply ? "corrected" : "would correct";
  // Every slug_instant row is listed (they are the ones to eyeball); the
  // current_start rows are sampled.
  const bySlugInstant = corrected.filter((row) => row.basis === "slug_instant");
  const byCurrentStart = corrected.filter((row) => row.basis !== "slug_instant");
  const shown = [...byCurrentStart.slice(0, SAMPLE_SIZE), ...bySlugInstant];
  for (const row of shown) {
    console.log(
      `  ${verb} [${row.basis ?? "?"}]: ${row.eventId}\n    ${row.previousSlug}\n  → ${row.newSlug}`,
    );
  }
  if (byCurrentStart.length > SAMPLE_SIZE) {
    console.log(
      `  … and ${byCurrentStart.length - SAMPLE_SIZE} more [current_start]`,
    );
  }

  if (flagged.length > 0) {
    console.log("\nleft alone or failed:");
    for (const row of flagged) {
      const detail = row.error ? `  (${row.error})` : "";
      console.log(`  ${row.outcome}: ${row.eventId}  ${row.previousSlug}${detail}`);
    }
  }

  console.log("\ncorrect-event-slug-dates summary:");
  console.log(`  scanned:          ${scanned}`);
  console.log(`  ${apply ? "corrected:       " : "would correct:   "} ${totals.corrected}`);
  console.log(`    current_start:  ${byCurrentStart.length}`);
  console.log(`    slug_instant:   ${bySlugInstant.length}`);
  console.log(`  already correct:  ${totals.already_correct}`);
  console.log(`  start moved:      ${totals.start_moved}`);
  console.log(`  unparseable:      ${totals.unparseable}`);
  console.log(`  minted after cutoff: ${totals.minted_after_cutoff}`);
  console.log(`  gone:             ${totals.gone}`);
  console.log(`  failed:           ${totals.failed}`);
  if (!apply) console.log("(DRY RUN — nothing written. Re-run with --apply to write.)");
  if (totals.failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => getPrisma().$disconnect());
