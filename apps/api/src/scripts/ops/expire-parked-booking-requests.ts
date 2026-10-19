/**
 * expire-parked-booking-requests.ts — expire every booking request still
 * PARKED at an unclaimed venue, with one thread note to its sender.
 *
 * WHY. The 2026-09-25 amendment to the venue-confirmation spec
 * (docs/specs/2026-08-27/venue-confirmation-and-booking-intents.spec.md,
 * "no requests to unclaimed venues", step 3): an unclaimed venue takes no
 * requests, parking is gone, and "any request still parked when this ships is
 * expired with one thread note to the sender: '{venue} isn't on Ithas Fire
 * yet, so this request can't reach them.'" Nothing writes
 * `parkedUnclaimedAt` any more; this expires the OPEN parked requests and
 * clears their stamp. Closed requests that still carry one are counted and
 * left for the later migration that drops the column.
 *
 * WHAT IT RUNS. `expireParkedBookingRequests` (core) — the request expiry
 * machinery keyed on the parked stamp: per request, its booking lock, a
 * guarded flip to EXPIRED that clears the stamp, its live holds released, the
 * `booking_request.expired_unclaimed` entry, an audit row; acts that joined
 * the bill get the usual "isn't going ahead" notice (in-app; this script binds
 * no mailer or push).
 *
 * SAFE BY DEFAULT.
 *   · DRY RUN unless `--commit` is passed (`--dry-run` is accepted and is the
 *     default) — lists every candidate and writes nothing.
 *   · IDEMPOTENT — the flip clears the stamp, so a second `--commit` finds
 *     nothing; a row taken by an overlapping run fails its guard.
 *   · One request's failure rolls back that request only and is printed; the
 *     exit code is non-zero.
 *
 * DATABASE URL RESOLUTION — printed on every run, with the reason:
 *   1. DATABASE_URL from the shell, else from `<cwd>/.env` (from apps/api
 *      that file points at the HOSTED database — see 3), else from the
 *      repo-root `.env.local` (the local dev DB);
 *   2. a placeholder or unset value falls through to the next source;
 *   3. a NON-LOCAL host without `THC_SEED_ALLOW_REMOTE_DB=true` is NOT used:
 *      the script falls back to the default local URL and SAYS SO.
 * `apps/api/.env.local` supplies the rest (PUBLIC_WEB_URL for the act
 * notice's link).
 *
 * A `--commit` against a non-local host also needs `--expect-host=<host>`
 * equal to the resolved host (`host` or `host:port`), or the script refuses
 * before writing anything. A dry run never needs it.
 *
 * Usage:
 *   pnpm -F api exec tsx src/scripts/ops/expire-parked-booking-requests.ts
 *   pnpm -F api exec tsx src/scripts/ops/expire-parked-booking-requests.ts --commit
 *   THC_SEED_ALLOW_REMOTE_DB=true DATABASE_URL=… … --commit --expect-host=<host>
 */
import { config as dotenvConfig } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isPlaceholder = (value: string | undefined): boolean =>
  !value || /USER:PASSWORD|@HOST|postgres:\/\/USER/.test(value);
const usable = (value: string | undefined): value is string =>
  !isPlaceholder(value);
const maskUrl = (value: string): string =>
  value.replace(/\/\/[^@/]*@/, "//***@");

// Where DATABASE_URL came from, in precedence order. Each source is read
// WITHOUT overriding an earlier one, so the first usable value wins.
let dbUrlSource = "unset";
if (usable(process.env.DATABASE_URL)) {
  dbUrlSource = "the shell environment";
} else {
  delete process.env.DATABASE_URL;
  const cwdEnv = path.resolve(process.cwd(), ".env");
  dotenvConfig({ path: cwdEnv, override: false, quiet: true });
  if (usable(process.env.DATABASE_URL)) {
    dbUrlSource = cwdEnv;
  } else {
    delete process.env.DATABASE_URL;
    const rootEnvLocal = path.resolve(__dirname, "../../../../../.env.local");
    dotenvConfig({ path: rootEnvLocal, override: false, quiet: true });
    if (usable(process.env.DATABASE_URL)) dbUrlSource = rootEnvLocal;
  }
}
dotenvConfig({
  path: path.resolve(__dirname, "../../../.env.local"),
  override: false,
  quiet: true,
});

const localDbUrl =
  "postgresql://postgres:postgres@localhost:5432/dev?schema=public";
const allowRemoteDb = process.env.THC_SEED_ALLOW_REMOTE_DB === "true";
const isLocalHostname = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

/** The URL to use and one sentence saying why — never a silent fallback. */
const resolveDbUrl = (): { url: string; reason: string } => {
  const candidate = process.env.DATABASE_URL;
  if (!usable(candidate)) {
    return {
      url: localDbUrl,
      reason: `no usable DATABASE_URL in the shell, ./.env or the repo-root .env.local; FELL BACK to the default local URL ${maskUrl(localDbUrl)}`,
    };
  }
  let hostname: string;
  try {
    hostname = new URL(candidate).hostname;
  } catch {
    return {
      url: localDbUrl,
      reason: `DATABASE_URL from ${dbUrlSource} is not a parseable URL; FELL BACK to the default local URL ${maskUrl(localDbUrl)}`,
    };
  }
  if (!isLocalHostname(hostname) && !allowRemoteDb) {
    return {
      url: localDbUrl,
      reason: `DATABASE_URL from ${dbUrlSource} points at NON-LOCAL host ${hostname}, refused without THC_SEED_ALLOW_REMOTE_DB=true; FELL BACK to the default local URL ${maskUrl(localDbUrl)}`,
    };
  }
  return {
    url: candidate,
    reason: `DATABASE_URL from ${dbUrlSource}${isLocalHostname(hostname) ? "" : " (remote allowed by THC_SEED_ALLOW_REMOTE_DB=true)"}: ${maskUrl(candidate)}`,
  };
};
const resolvedDb = resolveDbUrl();
process.env.DATABASE_URL = resolvedDb.url;

// ── Imports (hoisted under ESM; safe because getPrisma reads DATABASE_URL lazily, in main) ──
import { getPrisma } from "@th/db";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import { createSystemClock } from "@th/adapters/infra/clock";
import { createPinoLoggerAdapter } from "@th/adapters/infra/logger";
import { PrismaIdempotencyAdapter } from "@th/adapters/idempotency/prisma-adapter";
import {
  expireParkedBookingRequests,
  notifyBookingLineupRequestClosed,
  type NotifyBookingLineupRequestClosedArgs,
} from "@th/core/use-cases/booking-requests";
import { notify as notifyUseCase } from "@th/core/use-cases/comms/notify";

function parseArgs(argv: string[]) {
  let commit = false;
  let expectHost: string | null = null;
  for (const arg of argv) {
    if (arg === "--commit") commit = true;
    else if (arg === "--dry-run") commit = false;
    else if (arg.startsWith("--expect-host=")) {
      expectHost = arg.slice("--expect-host=".length) || null;
    } else if (arg === "--") continue;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { commit, expectHost };
}

/**
 * A `--commit` against a non-local host must name that host
 * (`--expect-host=<host>` matching the URL's `host` or `hostname`), so a
 * write never lands on a database the operator did not mean. Returns the
 * refusal message, or null when the run may proceed.
 */
function refuseRemoteCommit(
  args: { commit: boolean; expectHost: string | null },
  url: URL,
): string | null {
  if (!args.commit) return null;
  // A named host must match even when the URL is local: an operator who
  // named the prod host but got the local fallback must not commit locally
  // and read "expired=N" as the prod run.
  if (args.expectHost === url.host || args.expectHost === url.hostname) {
    return null;
  }
  if (args.expectHost === null && isLocalHostname(url.hostname)) return null;
  return args.expectHost === null
    ? `--commit against non-local host ${url.host} needs --expect-host=${url.host}; refusing, nothing written.`
    : `--expect-host=${args.expectHost} does not match the resolved host ${url.host}; refusing, nothing written.`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dbUrl = new URL(process.env.DATABASE_URL!);
  console.log(`[expire-parked] database: ${resolvedDb.reason}`);
  const refusal = refuseRemoteCommit(args, dbUrl);
  if (refusal) {
    console.error(`[expire-parked] ${refusal}`);
    process.exitCode = 1;
    return;
  }
  const prisma = getPrisma();
  const repos = createPrismaRepos(prisma);
  const clock = createSystemClock();
  const logger = createPinoLoggerAdapter({ options: { level: "warn" } });
  const dbHost = dbUrl.host;
  let reportedFailures = 0;
  const reportError = (err: unknown, context?: unknown) => {
    reportedFailures += 1;
    console.error("[expire-parked] reported failure", err, context ?? {});
  };

  // In-app only: no mailer, no push. The idempotency keys live in Postgres
  // under their own namespace, so a re-run never re-sends a notice.
  const idempotency = new PrismaIdempotencyAdapter(
    prisma,
    "ops-expire-parked",
    logger,
  );
  const notify = (payload: Parameters<typeof notifyUseCase>[1]) =>
    notifyUseCase({ repos, clock, idempotency, logger, reportError }, payload);

  const stampedBefore = await prisma.bookingRequest.count({
    where: { parkedUnclaimedAt: { not: null } },
  });
  console.log(
    `[expire-parked] ${args.commit ? "COMMIT" : "DRY RUN"} on ${dbHost} — ${stampedBefore} row(s) carry parkedUnclaimedAt`,
  );

  const result = await expireParkedBookingRequests(
    {
      repos,
      clock,
      logger,
      reportError,
      notifyBookingLineupRequestClosed: (
        notifyArgs: NotifyBookingLineupRequestClosedArgs,
      ) =>
        notifyBookingLineupRequestClosed(
          {
            repos,
            notify,
            logger,
            reportError,
            publicAppUrl: process.env.PUBLIC_WEB_URL ?? null,
          },
          notifyArgs,
        ),
    },
    { dryRun: !args.commit },
  );

  for (const candidate of result.candidates) {
    console.log(JSON.stringify(candidate));
  }
  const stampedAfter = await prisma.bookingRequest.count({
    where: { parkedUnclaimedAt: { not: null } },
  });
  console.log(
    `[expire-parked] candidates=${result.candidates.length} expired=${result.expiredCount} holdNotices=${result.holdNotificationIntents.length} stampedAfter=${stampedAfter}`,
  );
  if (stampedAfter > 0 && args.commit) {
    // Closed rows (withdrawn / declined / expired before the amendment) keep
    // their stamp; only OPEN parked requests are this script's to expire.
    console.log(
      "[expire-parked] rows still stamped are closed requests (not parked any more); clear them in the column-drop migration.",
    );
  }
  if (result.holdNotificationIntents.length > 0) {
    console.warn(
      "[expire-parked] hold move-up notices are owed but NOT sent by this script — dispatch them, or tell the venues:",
      JSON.stringify(result.holdNotificationIntents),
    );
  }
  if (!args.commit && result.candidates.length > 0) {
    console.log("[expire-parked] dry run — re-run with --commit to write.");
  }
  if (
    reportedFailures > 0 ||
    result.candidates.some((candidate) => candidate.outcome === "failed")
  ) {
    process.exitCode = 1;
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[expire-parked] Failed:", err);
  process.exit(1);
});
