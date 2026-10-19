/**
 * migrate-series-rrule-local-basis.ts — DRY-RUN-BY-DEFAULT rewrite of
 * `EventSeries.schedule.rrule` from the legacy UTC token basis to the local
 * (event-timezone) basis.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The backend used to drive the `rrule` package on real UTC instants. `rrule`
 * is timezone-blind — it reads a Date's UTC fields as wall-clock — so
 * BYDAY/BYSETPOS were evaluated against the UTC calendar. The admin event
 * builder compensated by emitting a SHIFTED token: a Nashville Friday-20:00
 * show (Saturday 01:00 UTC) was stored as `BYDAY=SA` and labelled "Friday".
 * Two bugs cancelling.
 *
 * The backend now evaluates in the event timezone
 * (`packages/core/src/use-cases/events/_shared/rrule-floating-time.ts`) and the
 * builder now emits the local token. Rules written under the old basis would
 * therefore land their series a day LATE. This script shifts them back.
 *
 * ── MONTHLY rules change the DATE SET, not just the label ───────────────────
 * A local "last Friday" and a UTC "first Saturday" are the same anchor but
 * NOT the same monthly cadence: a month whose last Friday is the 24th has its
 * first Saturday on the 4th. Rewriting a MONTHLY rule therefore moves the
 * whole enumerated series, not just what it is called.
 *
 * That is the intended ruling — the organizer picked "the last Friday", and
 * the label is what they agreed to — but it has an operational consequence:
 * the FIRST reconcile after migrating a MONTHLY series will find its already
 * materialized occurrences off-grid and orphan them (PLANNED deleted,
 * GENERATED/PUBLISHED without sales detached, ones with sales raised for
 * confirmation). MONTHLY rows are marked in the dry-run output and counted
 * separately so that can be sequenced deliberately rather than discovered.
 *
 * SCOPE — `EventSeries.schedule` ONLY. Community listings store their schedule
 * in `Event.recurrenceSchedule` and were always written on the local basis
 * (`apps/web/src/lib/recurrence/build-recurrence-schedule.ts`); they are not
 * read or written here.
 *
 * ── Safety properties ───────────────────────────────────────────────────────
 *   - Nothing is written unless `--apply` is passed. Dry run is the default.
 *   - The old/new basis decision is made per row from that row's OWN dtstart
 *     and timezone (see `lib/series-rrule-local-basis.ts`), never from a
 *     table-wide assumption — the shift depends on the specific instant.
 *   - Rows the anchor cannot classify are counted as AMBIGUOUS and skipped,
 *     never guessed at.
 *   - Re-running is a no-op: a migrated rule reads as `already-local`.
 *   - Every write is scoped to ONE id and sets only `schedule`, rebuilt from
 *     the row's own JSON with the `rrule` string replaced. (Prisma also bumps
 *     `updatedAt`, which is `@updatedAt` on the model — so "only `schedule`"
 *     is true of the columns this script names, not literally of the row.)
 *   - Each write is compare-and-swap guarded on the WHOLE stored `schedule`
 *     value, not just its `rrule` key. Guarding the rule alone would let an
 *     organizer's concurrent edit to `until` or `dtstart` be reverted by
 *     writing back a stale sibling — and a changed `dtstart` would also mean
 *     the shift had been computed from a stale anchor. A row that moved under
 *     us is skipped and reported.
 *   - `--apply` against a non-local database requires
 *     `--confirm-remote-host=<host>` matching the resolved hostname.
 *
 * USAGE — run from the REPO ROOT:
 *
 *   # dry run (local dev) — prints the full plan, writes nothing
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dev?schema=public \
 *     pnpm exec tsx apps/api/src/scripts/backfill/done/migrate-series-rrule-local-basis.ts
 *
 *   # dry run, saving the from -> to plan as the rollback record
 *   DATABASE_URL=... pnpm exec tsx \
 *     apps/api/src/scripts/backfill/done/migrate-series-rrule-local-basis.ts \
 *     --plan-file=/tmp/series-rrule-plan.json
 *
 *   # apply (local dev)
 *   DATABASE_URL=... pnpm exec tsx \
 *     apps/api/src/scripts/backfill/done/migrate-series-rrule-local-basis.ts --apply
 *
 *   # apply (remote)
 *   DATABASE_URL=<url> pnpm exec tsx \
 *     apps/api/src/scripts/backfill/done/migrate-series-rrule-local-basis.ts \
 *     --apply --confirm-remote-host=<host>
 */

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { getPrisma } from "@th/db";

import {
  analyzeSeriesSchedule,
  type Analysis,
  type StoredSchedule,
} from "./series-rrule-local-basis";

const SCRIPT_NAME = "migrate-series-rrule-local-basis";
const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
]);

type ParsedValues = {
  apply?: boolean;
  "confirm-remote-host"?: string;
  limit?: string;
  "plan-file"?: string;
};

/**
 * `strict: true` so a typo'd flag is a hard error rather than a silently
 * ignored one — a mistyped `--aply` must not look like a successful dry run,
 * and a mistyped `--limit` must not silently mean "the whole table".
 */
function parseCliArgs(): ParsedValues {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      "confirm-remote-host": { type: "string" },
      limit: { type: "string" },
      "plan-file": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  return values as ParsedValues;
}

function parsePlanFile(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // `--plan-file=` passes strict parsing as an empty string and would then
  // silently no-op, so an operator who asked for a rollback record would get
  // none. Refuse instead.
  if (raw.trim() === "") {
    throw new Error("--plan-file needs a path (got an empty value)");
  }
  return raw;
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  // A NaN limit previously fell through to `undefined` and scanned the WHOLE
  // table; a negative one reversed the slice. Both are refused.
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--limit must be a positive integer (got "${raw}")`);
  }
  return n;
}

// ALL argument handling runs inside main() (see `resolveArgs`), never at
// module evaluation: `parseArgs` with `strict: true` throws on a typo'd flag,
// and doing that at import time escapes `main().catch` and prints a raw Node
// stack trace instead of the script's own `${SCRIPT_NAME} failed:` line.
let values: ParsedValues = {};
let APPLY = false;
let LIMIT: number | undefined;
let PLAN_FILE: string | undefined;

function resolveArgs(): void {
  values = parseCliArgs();
  APPLY = values.apply === true;
  LIMIT = parseLimit(values.limit);
  PLAN_FILE = parsePlanFile(values["plan-file"]);
}

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
  if (!APPLY) return;
  // NOTE: a local hostname is not proof of a local DATABASE — a cloud-sql
  // proxy or an SSH tunnel presents as 127.0.0.1 while pointing at
  // production. The confirmation flag is skipped for local hosts for
  // ergonomics, so check what your DATABASE_URL actually reaches before
  // passing --apply.
  if (LOCAL_HOSTS.has(host)) {
    console.warn(
      `  NOTE: "${host}" is treated as local, so no --confirm-remote-host is ` +
        `required.\n  If this is a proxy or tunnel to a remote database, stop now.\n`,
    );
    return;
  }
  const confirmed = values["confirm-remote-host"];
  if (confirmed !== host) {
    throw new Error(
      `Refusing to --apply against remote host "${host}".\n` +
        `Re-run with --confirm-remote-host=${host} if that is intended.`,
    );
  }
}

async function main() {
  resolveArgs();
  const host = resolveDbHost();
  assertWriteAllowed(host);

  console.log(
    `${SCRIPT_NAME} — ${APPLY ? "APPLY" : "DRY RUN"} against ${host}\n`,
  );

  const prisma = getPrisma();

  const series = await prisma.eventSeries.findMany({
    where: { archivedAt: null },
    select: { id: true, name: true, timezone: true, schedule: true },
    orderBy: { createdAt: "asc" },
    ...(LIMIT ? { take: LIMIT } : {}),
  });

  console.log(`${series.length} active series examined.\n`);

  const stats = {
    examined: series.length,
    notApplicable: 0,
    unreadable: 0,
    noShift: 0,
    alreadyLocal: 0,
    needsMigration: 0,
    monthlyNeedsMigration: 0,
    anchorOnly: 0,
    ambiguous: 0,
    rewritten: 0,
    skippedConcurrentEdit: 0,
    writeFailed: 0,
  };

  const attention: Array<{ id: string; name: string; note: string }> = [];
  const plan: Array<{
    id: string;
    name: string;
    timezone: string;
    freq: string;
    shift: number;
    from: string;
    to: string;
  }> = [];

  for (const row of series) {
    const schedule = row.schedule as StoredSchedule | null;
    const analysis: Analysis = analyzeSeriesSchedule({
      schedule,
      timezone: row.timezone,
    });

    switch (analysis.kind) {
      case "not-applicable":
        stats.notApplicable += 1;
        continue;
      case "unreadable":
        stats.unreadable += 1;
        attention.push({
          id: row.id,
          name: row.name,
          note: `UNREADABLE — ${analysis.reason}`,
        });
        continue;
      case "no-shift":
        stats.noShift += 1;
        continue;
      case "already-local":
        stats.alreadyLocal += 1;
        continue;
      case "anchor-only":
        stats.anchorOnly += 1;
        attention.push({
          id: row.id,
          name: row.name,
          note: `ANCHOR-ONLY — ${analysis.reason}`,
        });
        continue;
      case "ambiguous":
        stats.ambiguous += 1;
        attention.push({
          id: row.id,
          name: row.name,
          note: `AMBIGUOUS — ${analysis.reason}`,
        });
        continue;
      case "needs-migration":
        break;
    }

    stats.needsMigration += 1;
    const freq =
      /(?:^|;)\s*FREQ=([A-Z]+)/i.exec(analysis.from)?.[1]?.toUpperCase() ??
      "UNKNOWN";
    if (freq === "MONTHLY") stats.monthlyNeedsMigration += 1;
    plan.push({
      id: row.id,
      name: row.name,
      timezone: row.timezone,
      freq,
      shift: analysis.shift,
      from: analysis.from,
      to: analysis.to,
    });
    console.log(
      `  ${row.id}  ${row.name}\n` +
        `    tz=${row.timezone} shift=${analysis.shift}` +
        (freq === "MONTHLY" ? "  [MONTHLY — date SET changes, see header]" : "") +
        `\n    ${analysis.from}\n` +
        ` -> ${analysis.to}`,
    );

    if (!APPLY) continue;

    // Rebuild the row's own JSON with only `rrule` replaced, so any field the
    // schedule carries that this script does not know about survives.
    const nextSchedule = {
      ...(schedule as Record<string, unknown>),
      rrule: analysis.to,
    };

    try {
      // Compare-and-swap on the WHOLE schedule value: only write if nothing
      // about it has moved since it was read. Guarding `rrule` alone would
      // revert a concurrent edit to `until` / `dtstart` by writing back the
      // stale siblings captured in `nextSchedule` — and a changed `dtstart`
      // would additionally invalidate the shift this rewrite was derived from.
      const result = await prisma.eventSeries.updateMany({
        where: {
          id: row.id,
          schedule: { equals: schedule as never },
        },
        data: { schedule: nextSchedule },
      });
      if (result.count === 1) {
        stats.rewritten += 1;
      } else {
        stats.skippedConcurrentEdit += 1;
        attention.push({
          id: row.id,
          name: row.name,
          note: "SKIPPED — schedule changed under us (concurrent edit)",
        });
      }
    } catch (err) {
      stats.writeFailed += 1;
      attention.push({
        id: row.id,
        name: row.name,
        note: `WRITE FAILED — ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  console.log(`\n── ${APPLY ? "Applied" : "Plan"} ─────────────────────────`);
  console.log(`  examined             ${stats.examined}`);
  console.log(`  not applicable       ${stats.notApplicable}  (FIXED_DATES / no rrule)`);
  console.log(`  no shift             ${stats.noShift}  (local and UTC agree — nothing to do)`);
  console.log(`  already local basis  ${stats.alreadyLocal}`);
  console.log(`  NEEDS MIGRATION      ${stats.needsMigration}`);
  console.log(
    `    of which MONTHLY   ${stats.monthlyNeedsMigration}  (enumerated DATE SET changes — see header)`,
  );
  console.log(`  anchor-only drift    ${stats.anchorOnly}  (review by hand)`);
  console.log(`  ambiguous            ${stats.ambiguous}  (review by hand)`);
  console.log(`  unreadable           ${stats.unreadable}`);
  if (APPLY) {
    console.log(`  rewritten            ${stats.rewritten}`);
    console.log(`  skipped (concurrent) ${stats.skippedConcurrentEdit}`);
    console.log(`  write failed         ${stats.writeFailed}`);
  } else {
    console.log(`\n  DRY RUN — nothing was written. Re-run with --apply.`);
  }

  if (PLAN_FILE && plan.length > 0) {
    // Wrapped: on an --apply run the rows are ALREADY rewritten by now, and
    // the attention list below is the only record of which ids failed or need
    // a human. Letting an ENOENT here reject main() would take that list with
    // it — the operator would lose exactly what a re-run cannot reconstruct.
    try {
      writeFileSync(PLAN_FILE, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
      console.log(
        `\n  Plan written to ${PLAN_FILE} (${plan.length} row(s)) — keep it: the` +
          ` \`from\` strings are the only record of the pre-migration rules.`,
      );
    } catch (err) {
      console.error(
        `\n  WARNING: could not write the plan file ${PLAN_FILE}: ` +
          `${err instanceof Error ? err.message : String(err)}\n` +
          `  The plan is printed above; copy it from the console.`,
      );
    }
  }

  // Always printed. On an --apply run this is the ONLY record of which ids
  // failed to write or need a human, so suppressing it would leave an
  // operator with counts and nothing to retry.
  if (attention.length > 0) {
    console.log(`\n── Needs a human ─────────────────────────`);
    for (const item of attention) {
      console.log(`  ${item.id}  ${item.name}\n    ${item.note}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`${SCRIPT_NAME} failed:`, err);
    process.exit(1);
  });
