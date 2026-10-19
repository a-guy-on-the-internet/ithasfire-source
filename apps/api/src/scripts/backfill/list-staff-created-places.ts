/**
 * List in the directory every place staff created from the community flow
 * that is still hidden from it.
 *
 * Owner ruling 2026-10-14: places community moderators and platform ADMINs
 * create (`createCommunityPlace`) appear in the places directory. New ones are
 * listed at creation; this lists the ones made before that, through the real
 * use case (`setPlaceDirectoryListing`): one audited `place.directory_listed`
 * row and one search-reindex mark per place, in one transaction each. No
 * hand-written SQL writes anything.
 *
 * Selection: a `place.community_created` audit row, `listedInDirectory =
 * false`, status ACTIVE. Skipped and counted:
 *   - not ACTIVE (archived or suspended): listing one would put nothing in
 *     the directory today, and a restore keeps the place's own flag;
 *   - staff unlisted it since (`place.directory_unlisted` or
 *     `place.unlisted_from_directory`): a deliberate call this script does
 *     not reverse.
 *
 * DRY RUN BY DEFAULT: prints the host, the count and the list (id, name,
 * created at) and writes nothing. `--apply --actor <humanId>` lists each one
 * as that human, who must be a platform ADMIN or REVIEWER with a second
 * factor enrolled (the use case checks; nothing here bypasses it).
 * IDEMPOTENT: a listed place leaves the selection, so a re-run lists nothing.
 *
 * `DATABASE_URL` is REQUIRED and never read from a .env file
 * (`apps/api/.env` points at Neon). Any run against a host other than
 * localhost needs `--confirm-remote-host=<host>`.
 *
 * Usage (from the repo root):
 *
 *   DATABASE_URL=postgresql://... pnpm -F api backfill:list-staff-places
 *   DATABASE_URL=postgresql://... pnpm -F api backfill:list-staff-places \
 *     --apply --actor <humanId>
 *
 * The search documents follow from the reindex marks (the reindex sweep picks
 * them up); run `pnpm -F api reindex:search` to refresh them at once.
 */
import { parseArgs } from "node:util";

import { getPrisma } from "@th/db";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import { createDbAuthZAdapter } from "@th/adapters/authz/db-authz-adapter";
import { createSystemClock } from "@th/adapters/infra/clock";
import {
  setPlaceDirectoryListing,
  type SetPlaceDirectoryListingDeps,
} from "@th/core/use-cases/places/set-place-directory-listing";

const SCRIPT_NAME = "list-staff-created-places";

export const LISTING_REASON =
  "Staff-created place listed (owner ruling 2026-10-14)";

/** Audit actions that mark a place as created from the community flow. */
export const COMMUNITY_CREATED_ACTION = "place.community_created";

/** Audit actions both staff toggles write when they unlist a place. */
export const STAFF_UNLIST_ACTIONS = [
  "place.directory_unlisted",
  "place.unlisted_from_directory",
] as const;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** The host `getPrisma` connects to: the URL hostname, IPv6 brackets removed. */
export function resolveDbHost(databaseUrl: string): string {
  return new URL(databaseUrl).hostname.replace(/^\[(.*)\]$/, "$1");
}

export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `--actor` must be a human id: checked before any read or write. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export type CandidateRow = {
  id: string;
  name: string;
  createdAt: Date;
  status: string;
  listedInDirectory: boolean;
  /** Staff unlisted it after it was created (an unlist audit row exists). */
  unlistedByStaff: boolean;
};

export type Partition = {
  toList: CandidateRow[];
  skippedNotActive: CandidateRow[];
  skippedUnlistedByStaff: CandidateRow[];
};

/**
 * Splits the community-created places that are still unlisted. Pure, so the
 * test pins the rule. Already-listed rows are dropped (nothing to do).
 */
export function partitionCandidates(rows: readonly CandidateRow[]): Partition {
  const out: Partition = {
    toList: [],
    skippedNotActive: [],
    skippedUnlistedByStaff: [],
  };
  for (const row of rows) {
    if (row.listedInDirectory) continue;
    if (row.status !== "ACTIVE") out.skippedNotActive.push(row);
    else if (row.unlistedByStaff) out.skippedUnlistedByStaff.push(row);
    else out.toList.push(row);
  }
  return out;
}

export type ApplySummary = { listed: number; skipped: number; failed: number };

/**
 * Lists each place through `setPlaceDirectoryListing`, one transaction each.
 * Each place is re-read first and skipped (counted) when it is no longer
 * ACTIVE or no longer exists: one archived since the selection stays out of
 * the directory. A refusal or throw is counted, not fatal, except STAFF_ONLY
 * on the first place: the actor is wrong for every place, so the run stops.
 */
export async function listPlaces(
  deps: SetPlaceDirectoryListingDeps,
  placeIds: readonly string[],
  actorHumanId: string,
  onError: (placeId: string, err: unknown) => void = () => {},
): Promise<ApplySummary> {
  const summary: ApplySummary = { listed: 0, skipped: 0, failed: 0 };
  for (const placeId of placeIds) {
    try {
      const current = await deps.repos.places.getById(placeId);
      if (!current || current.status !== "ACTIVE") {
        summary.skipped += 1;
        continue;
      }
      await setPlaceDirectoryListing(deps, {
        actorHumanId,
        placeId,
        listedInDirectory: true,
        reason: LISTING_REASON,
      });
      summary.listed += 1;
    } catch (err) {
      if (
        summary.listed === 0 &&
        summary.failed === 0 &&
        (err as { code?: unknown })?.code === "STAFF_ONLY"
      ) {
        throw err;
      }
      summary.failed += 1;
      onError(placeId, err);
    }
  }
  return summary;
}

async function readCandidates(
  prisma: ReturnType<typeof getPrisma>,
): Promise<CandidateRow[]> {
  const created = await prisma.auditLog.findMany({
    where: { entity: "place", action: COMMUNITY_CREATED_ACTION },
    select: { entityId: true },
    distinct: ["entityId"],
  });
  const ids = created
    .map((r) => r.entityId)
    .filter((id): id is string => typeof id === "string");
  if (ids.length === 0) return [];

  const places = await prisma.place.findMany({
    where: { id: { in: ids }, listedInDirectory: false },
    select: {
      id: true,
      name: true,
      createdAt: true,
      status: true,
      listedInDirectory: true,
    },
    orderBy: { createdAt: "asc" },
  });
  if (places.length === 0) return [];

  const unlisted = await prisma.auditLog.findMany({
    where: {
      entity: "place",
      entityId: { in: places.map((p) => p.id) },
      action: { in: [...STAFF_UNLIST_ACTIONS] },
    },
    select: { entityId: true },
    distinct: ["entityId"],
  });
  const unlistedIds = new Set(unlisted.map((r) => r.entityId));

  return places.map((p) => ({
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    status: p.status,
    listedInDirectory: p.listedInDirectory,
    unlistedByStaff: unlistedIds.has(p.id),
  }));
}

function printRows(label: string, rows: readonly CandidateRow[]): void {
  console.log(`${label}: ${rows.length}`);
  for (const r of rows) {
    console.log(`  ${r.id}  ${r.createdAt.toISOString()}  ${r.name}`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      actor: { type: "string" },
      "confirm-remote-host": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const apply = values.apply === true;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL must be set explicitly (this script never loads .env files; the target DB must be deliberate).",
    );
  }
  const host = resolveDbHost(databaseUrl);
  if (!isLocalHost(host) && values["confirm-remote-host"] !== host) {
    throw new Error(
      `Refusing to run against remote host "${host}". ` +
        `Re-run with --confirm-remote-host=${host} if that is intended.`,
    );
  }
  if (apply && !isUuid(values.actor)) {
    throw new Error(
      "--apply needs --actor <humanId>, a UUID (a platform ADMIN or REVIEWER).",
    );
  }
  const target = new URL(databaseUrl);
  console.log(
    `${SCRIPT_NAME} → ${host}:${target.port || "5432"}${target.pathname} (${apply ? "APPLY" : "DRY RUN"})\n`,
  );

  const prisma = getPrisma();
  const partition = partitionCandidates(await readCandidates(prisma));

  printRows("to list", partition.toList);
  printRows("skipped, not ACTIVE", partition.skippedNotActive);
  printRows("skipped, unlisted by staff since", partition.skippedUnlistedByStaff);

  if (!apply) {
    console.log("\n(DRY RUN: nothing written. Re-run with --apply --actor <humanId> to list them.)");
    return;
  }

  const repos = createPrismaRepos(prisma);
  const deps: SetPlaceDirectoryListingDeps = {
    repos,
    authz: createDbAuthZAdapter({ repos }),
    clock: createSystemClock(),
  };
  const summary = await listPlaces(
    deps,
    partition.toList.map((r) => r.id),
    values.actor!,
    (id, err) => console.error(`  FAILED ${id}:`, err),
  );
  console.log(
    `\nlisted: ${summary.listed}  skipped (no longer ACTIVE): ${summary.skipped}  failed: ${summary.failed}`,
  );
  if (summary.failed > 0) process.exitCode = 1;
}

// Only when run as a script, so the test can import the pure parts.
if (process.argv[1]?.endsWith("list-staff-created-places.ts")) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      // Only disconnect a client that could be built: with DATABASE_URL
      // unset, `getPrisma()` would throw a second time here.
      if (!process.env.DATABASE_URL) return;
      await getPrisma()
        .$disconnect()
        .catch(() => undefined);
    });
}
