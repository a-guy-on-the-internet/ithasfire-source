/**
 * detect.ts — READ-ONLY detection for the two Place data-integrity defects
 * described at the top of ./queries.ts (stranded-PENDING lockouts, and the
 * literal "TBD" address sentinel).
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  NO WRITE PATH IS LOADED BY THIS SCRIPT.                                 ║
 * ║  It imports `./queries` (read-only) and nothing else from this folder.   ║
 * ║  `./repair` — the only module in the repo that writes these columns —    ║
 * ║  is never imported, transitively or otherwise. Safe to point at prod.    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The target database is NEVER inferred: `DATABASE_URL` must be passed
 * explicitly (this script loads no .env file — `apps/api/.env` points at a
 * CLOUD Neon database and `.env.local` overrides it, so an implicit target is
 * precisely the mistake worth refusing). The resolved host/database/user is
 * printed before a single query runs.
 *
 * USAGE — run from the REPO ROOT:
 *
 *   # local dev
 *   DATABASE_URL='postgresql://postgres:postgres@localhost:5432/dev' \
 *     pnpm exec tsx apps/api/src/scripts/place-data-integrity/detect.ts
 *
 *   # production (read-only; safe)
 *   DATABASE_URL='postgresql://...prod...' \
 *     pnpm exec tsx apps/api/src/scripts/place-data-integrity/detect.ts
 *
 * ⚠ DO NOT invoke this via `pnpm -F api exec tsx …`. That form works, but pnpm's
 * recursive-exec wrapper COLLAPSES every non-zero exit code to 1
 * (ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL: "Command failed with exit code 2" — then
 * the shell sees 1), which destroys the findings-vs-crash distinction below and
 * would make this exactly the kind of check that looks real and is not. Verified
 * by running both forms: `pnpm -F api exec` → 1, `pnpm exec` from the root → 2.
 *
 * FLAGS:
 *   --no-fail-on-findings   exit 0 even when findings exist (report-only usage)
 *
 * EXIT CODES — deliberately three-valued, because this repo has both
 * conventions and conflating them is how a broken check goes green:
 *   0  clean (no findings), or findings with --no-fail-on-findings
 *   1  the script itself failed (bad DATABASE_URL, connection error, ...)
 *   2  findings present
 *
 * Why 2 and not 1: the `backfill-*` siblings (backfill-venue-defaults.ts,
 * backfill-tax-rates.ts, scripts/backfill-order-item-paidout.ts) always exit 0
 * and reserve 1 for a crash, while the `check-*` siblings
 * (scripts/ci/check-ci-test-coverage.mjs) exit 1 on findings. This script is a
 * check, so it must fail on findings — but exiting 1 would make "found 3
 * stranded places" indistinguishable from "could not connect to the database",
 * which is unacceptable for something you might wire into a cron. 2 means
 * findings; 1 always and only means the run itself broke.
 */

import { getPrisma } from "@th/db";

import {
  detectAll,
  parseArgs,
  printAddressSentinels,
  printPendingLockouts,
  printSummary,
  printTargetBanner,
} from "./queries";

const SCRIPT_NAME = "place-data-integrity / detect (READ-ONLY)";

const EXIT_CLEAN = 0;
const EXIT_ERROR = 1;
const EXIT_FINDINGS = 2;

async function main(): Promise<number> {
  const { flags } = parseArgs(process.argv.slice(2), {
    flags: ["--no-fail-on-findings"],
  });
  const failOnFindings = !flags.has("--no-fail-on-findings");

  printTargetBanner(
    SCRIPT_NAME,
    "read-only detection — this script writes NOTHING",
  );

  const prisma = getPrisma();
  const report = await detectAll(prisma);

  printPendingLockouts(report.pendingLockouts);
  printAddressSentinels(report.addressSentinels);
  const { totalFindings, autoRepairable, reportOnly } = printSummary(report);

  if (totalFindings === 0) {
    console.log("No data-integrity issues found. Nothing to repair.");
    return EXIT_CLEAN;
  }

  console.log(
    `${autoRepairable} row(s) can be repaired automatically; ${reportOnly} need a human.`,
  );
  console.log("");
  console.log("To review the exact writes (dry run — changes nothing):");
  console.log(
    "  DATABASE_URL='<same url>' pnpm exec tsx apps/api/src/scripts/place-data-integrity/repair.ts",
  );
  console.log("");

  return failOnFindings ? EXIT_FINDINGS : EXIT_CLEAN;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(EXIT_ERROR);
  });
