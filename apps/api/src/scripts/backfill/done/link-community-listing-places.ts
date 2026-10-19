/**
 * link-community-listing-places.ts — DRY-RUN-BY-DEFAULT, TWO-PHASE backfill
 * that links PUBLISHED COMMUNITY listings to the Place their own title already
 * names.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The community create form is a deliberately slim subset of the event builder
 * with NO place picker (docs/qa/community-events-testing.md), and the open-mic
 * scout cannot set one either. So a community listing carries free-text
 * `addressText` and `placeId = NULL`, forever — even when its title says
 * "… at Third Coast Comedy Club" and that venue is already a row in `Place`.
 * This is a structural gap, not stray bad data.
 *
 * ── READ THIS BEFORE RUNNING IT: what linking a place does NOT do ───────────
 * Setting `placeId` does NOT put a community listing on the venue's public
 * page, and does NOT change its search document. Both are gated on VENUE
 * CONFIRMATION (`packages/core/src/lib/venue-confirmation.ts`, THE
 * derivation), which is
 *
 *     (stamped AND not withdrawn AND venueConfirmedPlaceId = placeId)
 *  OR the event's owner is a verified owner of the place
 *
 * A COMMUNITY listing is OWNERLESS by definition, so the owner arm can never
 * hold, and only the venue itself can issue the stamp (`confirmVenueEvent`,
 * venue-side authority). Therefore, for every row this script touches:
 *
 *   · the public venue page (`listPlaceEvents` -> `listPublishedByPlace` with
 *     `venueConfirmedFor`) still EXCLUDES it;
 *   · the search document still indexes `venueId: null` / `venueName: null`
 *     (`build-search-index.ts`: both are behind `venueConfirmed`);
 *   · the public event page still renders address-only, with no "At {venue}"
 *     link (`get-event-seo.ts` gates `placeSlug` on the same predicate);
 *   · venue availability / conflict detection is unaffected — an unconfirmed
 *     event blocks nothing.
 *
 * WHAT IT ACTUALLY DOES is put the listing in front of the venue: the venue's
 * own admin calendar (`getVenueCalendar` -> `listAllByPlace`, deliberately NOT
 * confirmation-filtered) shows every event at the place, flagged
 * `venueConfirmed: false`, "so the venue sees who is claiming its room". The
 * venue can then confirm it, and confirmation is what lights up the public
 * surfaces. This backfill is the step BEFORE that, not a substitute for it.
 *
 * Also owner-visible: `getStatsForPlace` (venue admin detail, authed) is NOT
 * confirmation-filtered, so a venue's event counts move immediately.
 *
 * ── Precision policy ────────────────────────────────────────────────────────
 * A wrong link puts somebody's open mic on another business's claimable venue
 * page. A missed link costs a row in the review bucket. The matcher therefore
 * REFUSES every ambiguity rather than resolving it. The rules, and why they
 * are those rules, live in ./plan-link-community-listing-places.ts — read that
 * header before changing any threshold.
 *
 * ── Two phases. Apply NEVER re-runs the matcher ─────────────────────────────
 *   1. dry run with `--plan-file=<path>` — writes the proposals as JSON;
 *   2. a HUMAN reads that file, deletes bad rows, optionally promotes a
 *      review row into `links[]` by hand with `bucket: "manual"`;
 *   3. `--apply --from-plan=<path>` writes ONLY what the file contains.
 *
 * If apply re-matched, the thing written would not be the thing reviewed.
 *
 * ── Safety properties ───────────────────────────────────────────────────────
 *   - Nothing is written unless `--apply` is passed. Dry run is the default.
 *   - `--apply` REQUIRES `--from-plan`. There is no match-and-write path.
 *   - An event that already has a `placeId` is never touched, on any path.
 *   - Every row is re-verified INSIDE the write transaction against the state
 *     the plan recorded (event exists / COMMUNITY / PUBLISHED / placeId still
 *     null / TITLE unchanged / place exists / ACTIVE / not renamed). The title
 *     check is load-bearing: the match was DERIVED from the title, so a
 *     retitled listing has no surviving evidence.
 *   - The write is a compare-and-swap `updateMany` on `placeId IS NULL`; zero
 *     rows means somebody moved it and nothing is written.
 *   - Idempotent: a second run over the same plan reports every row
 *     `already-applied` and writes nothing.
 *   - Batched. Each batch is ONE interactive transaction bounded by
 *     `--batch-size` (default 25, max 200).
 *   - Every applied row's PRIOR value is recorded in the applied-file, and
 *     `--revert-from --apply` reverses it (CASed on the value we wrote).
 *   - `--apply` against a non-local database requires
 *     `--confirm-remote-host=<host>` matching the resolved hostname.
 *   - `--from-plan` WITHOUT `--apply` re-verifies every row against the live
 *     database inside a transaction that is deliberately ROLLED BACK, so the
 *     pre-flight exercises the exact code path the apply will.
 *
 * ── AFTERWARDS: reindex ─────────────────────────────────────────────────────
 * A script write triggers no reindex — incremental indexing is driven by
 * `reindexAfterMutation` from inside use cases only. Run:
 *
 *     pnpm -F api reindex:search
 *
 * (or wait for the nightly `search.full-reindex` job, which reconciles drift).
 * Note this is bookkeeping, not a visible change: the indexed `venueId` /
 * `venueName` stay null until the venue confirms — see the section above.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 *   - It does not confirm anything on the venue's behalf. Only the venue can.
 *   - It does not touch `addressText`, coordinates, `locationMode`, or any
 *     address-reveal column. The free text stays exactly as written — which
 *     is why `applyProposedLink` REFUSES a place that withholds its address
 *     (anything but EXACT): the typed street would sit on an event at a
 *     withheld venue (place-address-withholding D1).
 *   - It does not create Places. A listing whose venue has no row is a
 *     no-match; creating it is `upsert-place`'s job.
 *
 * ── No use case exists for this write, and why ──────────────────────────────
 * There is NO reachable use case that sets `placeId` on a COMMUNITY listing,
 * by design:
 *   · `ensureActorCanEditEvent` REFUSES every COMMUNITY row outright
 *     ("Community listings are ownerless by design — direct edits are
 *     disabled"), so `saveEventForOrg` / `saveEventForHuman` are closed;
 *   · the community edit-suggestion whitelist
 *     (`_shared/suggestion-fields.ts` SUGGESTION_EDITABLE_FIELDS, and the
 *     `CommunityEditableFieldValues` type behind `applyCommunityEdit`) does
 *     not contain `placeId` — the whole moderated queue cannot express this
 *     change;
 *   · `createCommunityListing` accepts no `placeId`;
 *   · `setVenuePlacement` writes `calendarId`/`spaceId`, never `placeId`;
 *     `setVenueConfirmation` requires venue-side authority and stamps a vouch.
 * So this script owns the narrowest possible write itself: one CASed
 * `updateMany` naming exactly one column, plus an AuditLog row written through
 * the REAL `makeAuditRepo(tx).log` in the same transaction.
 *
 * USAGE — run from the REPO ROOT:
 *
 *   # 1. dry run + plan file (read-only; safe against production)
 *   DATABASE_URL=<url> pnpm exec tsx \
 *     apps/api/src/scripts/backfill/done/link-community-listing-places.ts \
 *     --plan-file=/tmp/community-place-links.json
 *
 *   # 2. a human edits /tmp/community-place-links.json
 *
 *   # 3. pre-flight the edited plan (re-verifies, rolls back, writes nothing)
 *   DATABASE_URL=<url> pnpm exec tsx \
 *     apps/api/src/scripts/backfill/done/link-community-listing-places.ts \
 *     --from-plan=/tmp/community-place-links.json
 *
 *   # 4. apply (remote) — host must be named back
 *   DATABASE_URL=<url> pnpm exec tsx \
 *     apps/api/src/scripts/backfill/done/link-community-listing-places.ts \
 *     --apply --from-plan=/tmp/community-place-links.json \
 *     --confirm-remote-host=<host> --limit=25
 *
 *   # 5. reverse everything step 4 wrote
 *   DATABASE_URL=<url> pnpm exec tsx \
 *     apps/api/src/scripts/backfill/done/link-community-listing-places.ts \
 *     --apply --revert-from=/tmp/community-place-links.json.applied.json \
 *     --confirm-remote-host=<host>
 */

import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { makeAuditRepo } from "@th/adapters/db/prisma/audit";
import { getPrisma } from "@th/db";

import {
  applyProposedLink,
  buildPlaceIndex,
  buildPlanFile,
  countCorroboratedReviews,
  describeLink,
  describeReview,
  matchListing,
  parseBatchSize,
  parseLimit,
  parseOptionalValue,
  parseRequiredPath,
  parsePlanFile,
  revertAppliedLink,
  summarizeLinks,
  summarizeReviews,
  SCRIPT_NAME,
  type LinkBackfillTx,
  type LinkOutcome,
  type PlaceCandidate,
  type PlanFile,
  type ProposedLink,
  type ReviewEntry,
} from "./plan-link-community-listing-places";

const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
]);

/** Page size for the two read scans. Not the transaction bound. */
const READ_PAGE_SIZE = 500;

/**
 * The whole Place corpus is held in memory to make matching O(1) per title.
 * A row costs a couple of hundred bytes, so this ceiling is a few tens of MB
 * — and refusing loudly beats an OOM half way through a production scan.
 */
const MAX_PLACE_CORPUS = 200_000;

/**
 * Per-batch transaction budget. A batch is up to `--batch-size` links and each
 * link costs ~4 round trips, so Prisma's 5s default is not enough against a
 * remote database — and a timeout mid-batch rolls the batch back, which looks
 * like "the script did nothing" to an operator watching counts.
 */
const TX_TIMEOUT_MS = 120_000;
const TX_MAX_WAIT_MS = 15_000;

/** Thrown to roll back a pre-flight batch. Never escapes `runBatch`. */
class DryRunRollback extends Error {
  constructor(readonly outcomes: LinkOutcome[]) {
    super("dry-run rollback");
  }
}

type ParsedValues = {
  apply?: boolean;
  verbose?: boolean;
  "confirm-remote-host"?: string;
  limit?: string;
  "batch-size"?: string;
  "start-after"?: string;
  "plan-file"?: string;
  "from-plan"?: string;
  "applied-file"?: string;
  "revert-from"?: string;
};

/**
 * `strict: true` so a typo'd flag is a hard error rather than a silently
 * ignored one — a mistyped `--aply` must not look like a successful dry run,
 * and a mistyped `--limit` must not silently mean "every row in the plan".
 */
function parseCliArgs(): ParsedValues {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      "confirm-remote-host": { type: "string" },
      limit: { type: "string" },
      "batch-size": { type: "string" },
      "start-after": { type: "string" },
      "plan-file": { type: "string" },
      "from-plan": { type: "string" },
      "applied-file": { type: "string" },
      "revert-from": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  return values as ParsedValues;
}

// ALL argument handling runs inside main() (see `resolveArgs`), never at module
// evaluation: `parseArgs` with `strict: true` throws on a typo'd flag, and
// doing that at import time escapes `main().catch` and prints a raw Node stack
// trace instead of the script's own `${SCRIPT_NAME} failed:` line.
let values: ParsedValues = {};
let APPLY = false;
let VERBOSE = false;
let LIMIT: number | undefined;
let BATCH_SIZE = 25;
let START_AFTER: string | undefined;
let PLAN_FILE: string | undefined;
let FROM_PLAN: string | undefined;
let APPLIED_FILE: string | undefined;
let REVERT_FROM: string | undefined;

function resolveArgs(): void {
  values = parseCliArgs();
  APPLY = values.apply === true;
  VERBOSE = values.verbose === true;
  LIMIT = parseLimit(values.limit);
  BATCH_SIZE = parseBatchSize(values["batch-size"]);
  START_AFTER = parseOptionalValue(values["start-after"], "--start-after");
  PLAN_FILE =
    values["plan-file"] === undefined
      ? undefined
      : parseRequiredPath(values["plan-file"], "--plan-file");
  FROM_PLAN =
    values["from-plan"] === undefined
      ? undefined
      : parseRequiredPath(values["from-plan"], "--from-plan");
  APPLIED_FILE =
    values["applied-file"] === undefined
      ? undefined
      : parseRequiredPath(values["applied-file"], "--applied-file");
  REVERT_FROM =
    values["revert-from"] === undefined
      ? undefined
      : parseRequiredPath(values["revert-from"], "--revert-from");

  if (FROM_PLAN && REVERT_FROM) {
    throw new Error("--from-plan and --revert-from are mutually exclusive");
  }
  // THE two-phase contract. Without this, `--apply` alone would re-run the
  // matcher and write something nobody reviewed.
  if (APPLY && !FROM_PLAN && !REVERT_FROM) {
    throw new Error(
      "--apply requires --from-plan=<path> (or --revert-from=<path>).\n" +
        "This backfill never matches and writes in one step: produce a plan with\n" +
        "a dry run (--plan-file=<path>), have a human read and edit it, then apply\n" +
        "exactly that file.",
    );
  }
  if (PLAN_FILE && (FROM_PLAN || REVERT_FROM)) {
    throw new Error(
      "--plan-file is for the matching dry run; it does nothing when reading a plan back",
    );
  }
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
  // proxy or an SSH tunnel presents as 127.0.0.1 while pointing at production.
  // The confirmation flag is skipped for local hosts for ergonomics, so check
  // what your DATABASE_URL actually reaches before passing --apply.
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

function writeJsonFile(path: string, payload: unknown, label: string): void {
  // Wrapped: on an --apply run the rows are ALREADY written by now, and this
  // file is the ONLY reversal record. Letting an ENOENT reject main() would
  // take the attention list below it with it.
  try {
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`\n  ${label} written to ${path}`);
  } catch (err) {
    console.error(
      `\n  WARNING: could not write ${label} to ${path}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — match
// ─────────────────────────────────────────────────────────────────────────────

async function loadPlaceCorpus(
  prisma: ReturnType<typeof getPrisma>,
): Promise<PlaceCandidate[]> {
  const places: PlaceCandidate[] = [];
  let lastSeen = "";
  for (;;) {
    const rows = await prisma.place.findMany({
      where: { id: { gt: lastSeen } },
      select: {
        id: true,
        name: true,
        address: true,
        addrLine1: true,
        city: true,
        region: true,
        postcode: true,
        status: true,
        listedInDirectory: true,
      },
      orderBy: { id: "asc" },
      take: READ_PAGE_SIZE,
    });
    if (rows.length === 0) break;
    lastSeen = rows[rows.length - 1]!.id;
    for (const row of rows) places.push(row as PlaceCandidate);
    if (places.length > MAX_PLACE_CORPUS) {
      throw new Error(
        `Place corpus exceeds ${MAX_PLACE_CORPUS} rows. The matcher holds it in ` +
          `memory; raise MAX_PLACE_CORPUS deliberately or scope the run.`,
      );
    }
  }
  return places;
}

async function runMatchPhase(
  prisma: ReturnType<typeof getPrisma>,
  host: string,
): Promise<void> {
  console.log("  loading the Place corpus…");
  const places = await loadPlaceCorpus(prisma);
  const index = buildPlaceIndex(places);
  console.log(
    `  ${index.size} place(s) indexed (${index.byNormalizedName.size} distinct normalized names)\n`,
  );

  const stats = {
    examined: 0,
    alreadyLinked: 0,
    noMatch: 0,
    proposed: 0,
    needsReview: 0,
  };
  const links: ProposedLink[] = [];
  const reviews: ReviewEntry[] = [];

  // Keyset pagination on `Event.id`. The candidate set does not change under a
  // read-only scan, but keyset paging is what makes `--start-after` a real
  // resume point rather than an offset that shifts under a concurrent insert.
  let lastSeen = START_AFTER ?? "";

  for (;;) {
    const remaining = LIMIT === undefined ? READ_PAGE_SIZE : LIMIT - stats.examined;
    if (remaining <= 0) break;
    const take = Math.min(READ_PAGE_SIZE, remaining);

    const rows = await prisma.event.findMany({
      where: {
        id: { gt: lastSeen },
        stewardship: "COMMUNITY",
        status: "PUBLISHED",
        placeId: null,
      },
      select: {
        id: true,
        title: true,
        startsAt: true,
        addressText: true,
        placeId: true,
        stewardship: true,
        status: true,
      },
      orderBy: { id: "asc" },
      take,
    });
    if (rows.length === 0) break;
    lastSeen = rows[rows.length - 1]!.id;
    stats.examined += rows.length;

    for (const row of rows) {
      const classification = matchListing(
        {
          eventId: row.id,
          title: row.title,
          startsAt: row.startsAt,
          addressText: row.addressText,
          placeId: row.placeId,
          stewardship: row.stewardship,
          status: row.status,
        },
        index,
      );

      switch (classification.kind) {
        case "already-linked":
          stats.alreadyLinked += 1;
          break;
        case "no-match":
          stats.noMatch += 1;
          break;
        case "needs-review":
          stats.needsReview += 1;
          reviews.push(classification.entry);
          break;
        case "auto":
          stats.proposed += 1;
          links.push(classification.link);
          console.log(describeLink(classification.link, VERBOSE));
          break;
      }
    }
  }

  const confidence = summarizeLinks(links);
  const reviewCounts = summarizeReviews(reviews);
  const corroboratedReviews = countCorroboratedReviews(reviews);

  const counts: Record<string, number> = {
    examined: stats.examined,
    alreadyLinked: stats.alreadyLinked,
    noMatch: stats.noMatch,
    proposed: stats.proposed,
    needsReview: stats.needsReview,
    highConfidence: confidence.high,
    mediumConfidence: confidence.medium,
    addressCorroborated: confidence.addressCorroborated,
    directoryListed: confidence.directoryListed,
    reviewsAddressCorroborated: corroboratedReviews,
    signalAtSuffixExact: confidence.atSuffix,
    signalTitleExact: confidence.titleExact,
    ...reviewCounts,
  };

  console.log(`\n── Plan ─────────────────────────`);
  console.log(`  examined                     ${stats.examined}  (PUBLISHED COMMUNITY listings with placeId IS NULL)`);
  console.log(`  already linked               ${stats.alreadyLinked}  (never touched)`);
  console.log(`  no match                     ${stats.noMatch}`);
  console.log(`  PROPOSED (auto)              ${stats.proposed}`);
  console.log(`    high confidence            ${confidence.high}  (distinctive venue name, exact match — the only thing the matcher auto-links)`);
  console.log(`    medium confidence          ${confidence.medium}  (always 0 here; the wire value exists for rows a human promotes by hand)`);
  console.log(`    via " at "/"@" suffix      ${confidence.atSuffix}`);
  console.log(`    via whole-title match      ${confidence.titleExact}`);
  console.log(`    address-corroborated       ${confidence.addressCorroborated}`);
  console.log(`    venue in the directory     ${confidence.directoryListed}`);
  console.log(`  NEEDS REVIEW                 ${stats.needsReview}  (never auto-linked)`);
  console.log(`    of which addr-corroborated ${corroboratedReviews}  (the likely approvals — promote by hand)`);
  console.log(`    ambiguous (2+ places)      ${reviewCounts["ambiguous-multiple-places"]}`);
  console.log(`    duplicate place name       ${reviewCounts["duplicate-place-name"]}`);
  console.log(`    generic place name         ${reviewCounts["generic-place-name"]}`);
  console.log(`    partial name match         ${reviewCounts["partial-name-match"]}`);
  console.log(`    weak substring only        ${reviewCounts["weak-substring-only"]}`);
  console.log(`    inactive place             ${reviewCounts["inactive-place"]}`);
  console.log(`    unexpected listing state   ${reviewCounts["unexpected-listing-state"]}`);
  console.log(
    `\n  DRY RUN — nothing was written. This phase never writes; ` +
      `--apply reads a plan file back.`,
  );
  if (LIMIT !== undefined && stats.examined >= LIMIT) {
    console.log(
      `\n  --limit ${LIMIT} reached. Re-run with --start-after=${lastSeen} to continue.`,
    );
  }

  if (PLAN_FILE) {
    const plan = buildPlanFile({
      generatedAt: new Date(),
      databaseHost: host,
      counts,
      links,
      needsReview: reviews,
    });
    writeJsonFile(PLAN_FILE, plan, "Plan");
    console.log(
      `    links[] holds the ${links.length} proposed write(s); needsReview[] holds ${reviews.length} and is NEVER applied.\n` +
        `    Edit it, then: --apply --from-plan=${PLAN_FILE}`,
    );
  } else if (links.length > 0) {
    console.log(
      `\n  NOTE: no --plan-file given, so these proposals cannot be applied. ` +
        `Re-run with --plan-file=<path>.`,
    );
  }

  // Always printed. This is the list a human has to act on.
  if (reviews.length > 0) {
    console.log(`\n── Needs a human ─────────────────────────`);
    for (const entry of reviews) console.log(describeReview(entry));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — apply / pre-flight / revert, all from a reviewed file
// ─────────────────────────────────────────────────────────────────────────────

function readPlan(path: string): PlanFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parsePlanFile(raw);
}

type BatchMode = "apply" | "revert";

async function runBatch(
  prisma: ReturnType<typeof getPrisma>,
  batch: ProposedLink[],
  mode: BatchMode,
  planGeneratedAt: string,
): Promise<LinkOutcome[]> {
  const run = async (tx: unknown): Promise<LinkOutcome[]> => {
    // The REAL audit repo, bound to this transaction, so a backfilled link
    // lands the same AuditLog shape every other write in the system does —
    // not a second hand-rolled copy that can drift from it.
    const deps = { logAudit: makeAuditRepo(tx as never).log };
    const outcomes: LinkOutcome[] = [];
    for (const link of batch) {
      outcomes.push(
        mode === "apply"
          ? await applyProposedLink(tx as LinkBackfillTx, deps, link, {
              planGeneratedAt,
            })
          : await revertAppliedLink(tx as LinkBackfillTx, deps, link),
      );
    }
    return outcomes;
  };

  if (APPLY) {
    return prisma.$transaction(run, {
      timeout: TX_TIMEOUT_MS,
      maxWait: TX_MAX_WAIT_MS,
    });
  }

  // PRE-FLIGHT. The same code path, in a transaction we force to roll back by
  // throwing — so the verification an operator sees is the verification the
  // apply will do, not a second read-only reimplementation of it that can
  // drift from the real one.
  try {
    await prisma.$transaction(
      async (tx) => {
        throw new DryRunRollback(await run(tx));
      },
      { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
    );
  } catch (err) {
    if (err instanceof DryRunRollback) return err.outcomes;
    throw err;
  }
  /* c8 ignore next */
  throw new Error("pre-flight transaction did not roll back");
}

async function runPlanPhase(
  prisma: ReturnType<typeof getPrisma>,
  host: string,
  path: string,
  mode: BatchMode,
): Promise<void> {
  const plan = readPlan(path);

  console.log(
    `  plan ${path}\n` +
      `    generated ${plan.generatedAt} against ${plan.databaseHost}\n` +
      `    ${plan.links.length} link(s) in links[], ${plan.needsReview.length} in needsReview[] (never applied)\n`,
  );
  if (plan.databaseHost !== host) {
    console.warn(
      `  WARNING: the plan was generated against "${plan.databaseHost}" but ` +
        `DATABASE_URL points at "${host}".\n` +
        `  Every row is re-verified below, so a mismatch is safe — but check ` +
        `this is what you meant.\n`,
    );
  }

  let selected = plan.links;
  if (START_AFTER) {
    const at = selected.findIndex((link) => link.eventId === START_AFTER);
    if (at === -1) {
      throw new Error(
        `--start-after=${START_AFTER} names no event in the plan's links[]`,
      );
    }
    selected = selected.slice(at + 1);
    console.log(`  resuming after ${START_AFTER}: ${selected.length} link(s) left\n`);
  }
  if (LIMIT !== undefined && selected.length > LIMIT) {
    selected = selected.slice(0, LIMIT);
    console.log(`  --limit ${LIMIT}: taking the first ${selected.length} link(s)\n`);
  }

  const stats = { written: 0, alreadyApplied: 0, skipped: 0, batchFailed: 0 };
  const attention: Array<{ what: string; note: string }> = [];
  const applied: ProposedLink[] = [];
  const byEventId = new Map(selected.map((link) => [link.eventId, link]));

  for (let i = 0; i < selected.length; i += BATCH_SIZE) {
    const batch = selected.slice(i, i + BATCH_SIZE);
    let outcomes: LinkOutcome[];
    try {
      outcomes = await runBatch(prisma, batch, mode, plan.generatedAt);
    } catch (err) {
      // The batch rolled back whole. Name every row in it: the counts alone
      // would leave an operator with no idea what to retry.
      stats.batchFailed += 1;
      for (const link of batch) {
        attention.push({
          what: `${link.eventTitle} -> ${link.placeName} (event ${link.eventId})`,
          note: `BATCH FAILED (rolled back, nothing written) — ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
      continue;
    }

    for (const outcome of outcomes) {
      const link = byEventId.get(outcome.eventId);
      const what = link
        ? `${link.eventTitle} -> ${link.placeName} (event ${link.eventId})`
        : outcome.eventId;
      switch (outcome.kind) {
        case "linked":
          stats.written += 1;
          if (link) applied.push(link);
          console.log(`  ${APPLY ? "WROTE" : "would write"}  ${what}`);
          break;
        case "already-applied":
          stats.alreadyApplied += 1;
          console.log(`  no-op       ${what}  (already linked to this place)`);
          break;
        case "skipped":
          stats.skipped += 1;
          attention.push({ what, note: `SKIPPED — ${outcome.reason}` });
          break;
      }
    }
  }

  const verb = mode === "apply" ? "linked" : "unlinked";
  console.log(`\n── ${APPLY ? "Applied" : "Pre-flight"} ─────────────────────────`);
  console.log(`  selected from the plan       ${selected.length}`);
  console.log(`  ${APPLY ? verb.padEnd(28) : `would be ${verb}`.padEnd(28)} ${stats.written}`);
  console.log(`  already in the target state  ${stats.alreadyApplied}  (idempotent no-op)`);
  console.log(`  skipped (state moved)        ${stats.skipped}`);
  console.log(`  batches failed               ${stats.batchFailed}`);
  if (!APPLY) {
    console.log(
      `\n  PRE-FLIGHT — every row was verified inside a transaction that was ` +
        `ROLLED BACK.\n  Nothing was written. Re-run with --apply to commit.`,
    );
  }

  if (APPLY && mode === "apply" && applied.length > 0) {
    const outPath = APPLIED_FILE ?? `${path}.applied.json`;
    writeJsonFile(
      outPath,
      buildPlanFile({
        generatedAt: new Date(),
        databaseHost: host,
        counts: {
          linked: stats.written,
          alreadyApplied: stats.alreadyApplied,
          skipped: stats.skipped,
        },
        links: applied,
        needsReview: [],
      }),
      "Applied/rollback record",
    );
    console.log(
      `    KEEP IT. Every entry carries priorPlaceId (null). To reverse:\n` +
        `      --apply --revert-from=${outPath}` +
        (LOCAL_HOSTS.has(host) ? "" : ` --confirm-remote-host=${host}`),
    );
  }

  // Always printed. On an --apply run this is the ONLY record of which rows
  // were refused or failed, so suppressing it would leave an operator with
  // counts and nothing to retry.
  if (attention.length > 0) {
    console.log(`\n── Needs a human ─────────────────────────`);
    for (const item of attention) console.log(`  ${item.what}\n    ${item.note}`);
  }
}

async function main() {
  resolveArgs();
  const host = resolveDbHost();
  assertWriteAllowed(host);

  const mode = REVERT_FROM ? "REVERT" : FROM_PLAN ? "FROM PLAN" : "MATCH";
  console.log(
    `${SCRIPT_NAME} — ${APPLY ? "APPLY" : "DRY RUN"} (${mode}) against ${host}\n` +
      `  batch size ${BATCH_SIZE}${LIMIT ? `, limit ${LIMIT}` : ""}\n`,
  );

  const prisma = getPrisma();

  if (REVERT_FROM) {
    await runPlanPhase(prisma, host, REVERT_FROM, "revert");
  } else if (FROM_PLAN) {
    await runPlanPhase(prisma, host, FROM_PLAN, "apply");
  } else {
    await runMatchPhase(prisma, host);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`${SCRIPT_NAME} failed:`, err);
    process.exit(1);
  });
