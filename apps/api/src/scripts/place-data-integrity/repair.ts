/**
 * repair.ts — DRY-RUN-BY-DEFAULT repair for the two Place data-integrity
 * defects described at the top of ./queries.ts.
 *
 * Nothing is written unless `--apply` is passed. Without it this prints exactly
 * the same row-by-row plan the read-only `./detect.ts` prints, and exits 0.
 *
 * If you only want to LOOK, use `./detect.ts` instead — it does not load this
 * module and therefore does not load a write path at all.
 *
 * ── What it repairs ─────────────────────────────────────────────────────────
 *   Defect 1 (always auto-repaired): `Place.verification` PENDING -> UNVERIFIED
 *     for places with no PENDING/IN_REVIEW verification request. One column,
 *     scoped to one id, compare-and-swap guarded on the value still being
 *     PENDING.
 *
 *   Defect 2 (conservatively auto-repaired; see `planAddressRepair`):
 *     - `addrLine1` that trims to exactly "TBD"  -> NULL
 *     - `address` -> the same string with whole "TBD" segments removed, or
 *       (only when that leaves nothing) rebuilt from the row's own structured
 *       columns. `addressHash` is kept consistent (`address.toLowerCase()`,
 *       mirroring the Prisma places adapter).
 *     - anything ambiguous is REPORTED, never rewritten.
 *
 * ── Safety properties ───────────────────────────────────────────────────────
 *   - No raw SQL. Every write is a Prisma `updateMany` scoped to ONE `id`.
 *   - The whole repair runs in ONE interactive transaction.
 *   - Detection is RE-RUN INSIDE the transaction and the per-row plan is
 *     recomputed; a row whose state drifted since the plan was printed is
 *     SKIPPED, not written. What you reviewed is exactly what gets written.
 *   - Every write is additionally compare-and-swap guarded on the prior column
 *     values, so a concurrent edit loses the race rather than being clobbered.
 *   - Every repaired place gets an `AuditLog` row inside the same transaction.
 *   - `--apply` against a non-local host requires `--confirm-remote-host=<host>`
 *     matching the resolved hostname.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 *   - It does not go through `upsertPlace` or `tx.places.upsert`. That adapter
 *     rebuilds the WHOLE place row from its input, and omitted fields have
 *     silently wiped geo, capacity, status and verification before (see the
 *     long comment on `buildPlaceData` in the Prisma places adapter). A repair
 *     script must touch the columns it names and nothing else.
 *   - It does not recompute the admission-tax cache or the timezone. Note that
 *     an `address` rewrite changes `addressHash`, and `upsertPlace` gates its
 *     ZipTax/timezone re-lookup on an `addressHash` change — so the next
 *     ordinary save of a repaired place re-fires those lookups once. Because
 *     postcode/country/lat/lng are untouched, both recompute to the same
 *     values. Use `--report-only-addresses` to avoid every address write.
 *
 * USAGE — run from the REPO ROOT:
 *
 *   # 1. dry run (DEFAULT — writes nothing)
 *   DATABASE_URL='postgresql://postgres:postgres@localhost:5432/dev' \
 *     pnpm exec tsx apps/api/src/scripts/place-data-integrity/repair.ts
 *
 *   # 2. apply, local
 *   DATABASE_URL='postgresql://postgres:postgres@localhost:5432/dev' \
 *     pnpm exec tsx apps/api/src/scripts/place-data-integrity/repair.ts --apply
 *
 *   # 3. apply, remote (host must be named back)
 *   DATABASE_URL='postgresql://...@db.example.com:5432/prod' \
 *     pnpm exec tsx apps/api/src/scripts/place-data-integrity/repair.ts \
 *       --apply --confirm-remote-host=db.example.com
 *
 * ⚠ DO NOT invoke via `pnpm -F api exec tsx …` — pnpm's recursive-exec wrapper
 * collapses every non-zero exit code to 1, so exit 2 ("work remains") becomes
 * indistinguishable from exit 1 ("the run broke"). Verified both ways.
 *
 * FLAGS:
 *   --apply                     actually write (default is dry run)
 *   --report-only-addresses     repair defect 1 only; report every defect-2 row
 *   --confirm-remote-host=<h>   required for --apply against a non-local host
 *
 * EXIT CODES (mirrors ./detect.ts):
 *   0  dry run completed, or --apply completed with no rows left needing work
 *   1  the script itself failed
 *   2  work remains: a dry run with findings, or an --apply that left
 *      report-only / skipped rows behind
 */

import { randomUUID } from "node:crypto";

import { getPrisma } from "@th/db";

import {
  detectAll,
  parseArgs,
  planAddressRepair,
  planNeedsHuman,
  planWritesAnything,
  printAddressSentinels,
  printPendingLockouts,
  printSummary,
  printTargetBanner,
} from "./queries";

const SCRIPT_NAME = "place-data-integrity / repair";

const EXIT_CLEAN = 0;
const EXIT_ERROR = 1;
const EXIT_WORK_REMAINS = 2;

/** Generous: the whole repair is one interactive transaction. */
const TX_TIMEOUT_MS = 120_000;
const TX_MAX_WAIT_MS = 15_000;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

async function main(): Promise<number> {
  const { flags, options } = parseArgs(process.argv.slice(2), {
    flags: ["--apply", "--report-only-addresses"],
    options: ["--confirm-remote-host"],
  });

  const apply = flags.has("--apply");
  const reportOnlyAddresses = flags.has("--report-only-addresses");

  const mode = apply
    ? "APPLY — rows WILL be written"
    : "DRY RUN — nothing will be written (pass --apply to write)";
  const { hostname } = printTargetBanner(SCRIPT_NAME, mode);

  if (apply && !LOCAL_HOSTS.has(hostname)) {
    const confirmed = options.get("--confirm-remote-host");
    if (confirmed !== hostname) {
      throw new Error(
        `--apply against the non-local host ${JSON.stringify(hostname)} requires ` +
          `--confirm-remote-host=${hostname} (got ${confirmed === undefined ? "nothing" : JSON.stringify(confirmed)}).`,
      );
    }
    console.log(`Remote host ${hostname} confirmed on the command line.\n`);
  }
  if (reportOnlyAddresses) {
    console.log(
      "--report-only-addresses: defect 2 will be REPORTED ONLY; no address column will be written.\n",
    );
  }

  const prisma = getPrisma();

  // ── Plan (read-only) ──────────────────────────────────────────────────────
  const report = await detectAll(prisma);
  printPendingLockouts(report.pendingLockouts);
  printAddressSentinels(report.addressSentinels);
  const { totalFindings, autoRepairable, reportOnly } = printSummary(report);

  if (!apply) {
    console.log("DRY RUN — no rows were written.");
    if (totalFindings === 0) {
      console.log("Nothing to repair.");
      return EXIT_CLEAN;
    }
    console.log(
      `Re-run with --apply to write the ${autoRepairable} auto-repairable row(s). ` +
        `${reportOnly} row(s) need a human either way.`,
    );
    return EXIT_WORK_REMAINS;
  }

  if (autoRepairable === 0) {
    console.log("Nothing auto-repairable — no transaction opened.");
    return reportOnly > 0 ? EXIT_WORK_REMAINS : EXIT_CLEAN;
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  const runId = randomUUID();
  const at = new Date();
  console.log(`## Applying (runId=${runId})\n`);

  const plannedLockoutIds = new Set(
    report.pendingLockouts.map((row) => row.id),
  );
  const plannedAddressPlans = new Map(
    report.addressSentinels
      .filter((entry) => planWritesAnything(entry.plan))
      .map((entry) => [entry.row.id, entry] as const),
  );

  const result = await prisma.$transaction(
    async (tx) => {
      let verificationRepaired = 0;
      let addressRepaired = 0;
      const skipped: string[] = [];

      // Re-detect INSIDE the transaction. Only ids that are still stranded AND
      // were in the reviewed plan are eligible — a place that gained a fresh
      // verification request between the plan and the write must not be reset.
      const fresh = await detectAll(tx);

      for (const row of fresh.pendingLockouts) {
        if (!plannedLockoutIds.has(row.id)) {
          skipped.push(
            `  ~ ${row.id} (${row.name}): newly stranded since the plan was printed — NOT written. Re-run to include it.`,
          );
          continue;
        }
        // Compare-and-swap: only flip a row that is still PENDING.
        const { count } = await tx.place.updateMany({
          where: { id: row.id, verification: "PENDING" },
          data: { verification: "UNVERIFIED" },
        });
        if (count === 0) {
          skipped.push(
            `  ~ ${row.id} (${row.name}): no longer PENDING at write time — skipped.`,
          );
          continue;
        }
        verificationRepaired += 1;
        console.log(
          `  ✓ ${row.id} (${row.name}): verification PENDING -> UNVERIFIED`,
        );
        await tx.auditLog.create({
          data: {
            entity: "place",
            entityId: row.id,
            action: "place.verification_lockout_repaired",
            data: {
              script: "place-data-integrity/repair",
              runId,
              from: "PENDING",
              to: "UNVERIFIED",
              reason:
                "stranded at PENDING with no PENDING/IN_REVIEW verification request (withdraw-place-verification did not reset Place.verification before the fix)",
              closedRequestIds: row.requests.map((request) => request.id),
            },
            at,
          },
        });
      }

      if (!reportOnlyAddresses) {
        for (const { row } of fresh.addressSentinels) {
          const planned = plannedAddressPlans.get(row.id);
          if (!planned) continue; // report-only, clean, or newly appeared.

          // The row must be byte-identical to what the operator reviewed, and
          // the recomputed plan must match the printed plan exactly.
          const freshPlan = planAddressRepair(row);
          const sameRow =
            row.address === planned.row.address &&
            row.addrLine1 === planned.row.addrLine1 &&
            row.addressHash === planned.row.addressHash;
          const samePlan =
            JSON.stringify(freshPlan) === JSON.stringify(planned.plan);
          if (!sameRow || !samePlan) {
            skipped.push(
              `  ~ ${row.id} (${row.name}): address changed since the plan was printed — skipped. Re-run.`,
            );
            continue;
          }

          const data: {
            addrLine1?: null;
            address?: string;
            addressHash?: string;
          } = {};
          if (freshPlan.line1Action === "clear") data.addrLine1 = null;
          if (freshPlan.proposedAddress !== undefined) {
            data.address = freshPlan.proposedAddress;
            data.addressHash = freshPlan.proposedAddressHash;
          }
          if (Object.keys(data).length === 0) continue;

          // Compare-and-swap on the exact prior values.
          const { count } = await tx.place.updateMany({
            where: {
              id: row.id,
              address: planned.row.address,
              addrLine1: planned.row.addrLine1,
            },
            data,
          });
          if (count === 0) {
            skipped.push(
              `  ~ ${row.id} (${row.name}): address raced at write time — skipped.`,
            );
            continue;
          }
          addressRepaired += 1;
          console.log(
            `  ✓ ${row.id} (${row.name}): ${
              data.addrLine1 === null
                ? `addrLine1 ${JSON.stringify(planned.row.addrLine1)} -> null`
                : "addrLine1 unchanged"
            }; ${
              data.address !== undefined
                ? `address ${JSON.stringify(planned.row.address)} -> ${JSON.stringify(data.address)}`
                : "address unchanged"
            }`,
          );
          await tx.auditLog.create({
            data: {
              entity: "place",
              entityId: row.id,
              action: "place.address_sentinel_repaired",
              data: {
                script: "place-data-integrity/repair",
                runId,
                addressAction: freshPlan.addressAction,
                line1Action: freshPlan.line1Action,
                before: {
                  address: planned.row.address,
                  addrLine1: planned.row.addrLine1,
                  addressHash: planned.row.addressHash,
                },
                after: {
                  address: data.address ?? planned.row.address,
                  addrLine1:
                    data.addrLine1 === null ? null : planned.row.addrLine1,
                  addressHash: data.addressHash ?? planned.row.addressHash,
                },
                // Only true when `address` (and therefore `addressHash`) was
                // actually rewritten. A line1-only repair leaves the hash alone
                // and must not claim otherwise — this audit row is the record
                // an operator reads to decide whether a re-lookup is expected.
                note:
                  data.address !== undefined
                    ? "addressHash changed — the next upsertPlace save will re-fire the ZipTax + timezone lookups once (same inputs, same results)"
                    : "addrLine1 only — addressHash untouched, no downstream re-lookup implied",
              },
              at,
            },
          });
        }
      }

      return { verificationRepaired, addressRepaired, skipped };
    },
    { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
  );

  console.log("");
  for (const line of result.skipped) console.log(line);
  if (result.skipped.length > 0) console.log("");

  console.log("## Applied");
  console.log(
    `  verification PENDING -> UNVERIFIED:  ${result.verificationRepaired}`,
  );
  console.log(
    `  address sentinel rows repaired:      ${result.addressRepaired}`,
  );
  console.log(
    `  skipped (raced / drifted / new):     ${result.skipped.length}`,
  );
  console.log(
    `  audit rows written:                  ${result.verificationRepaired + result.addressRepaired}`,
  );
  console.log("");

  // ── Verify ────────────────────────────────────────────────────────────────
  console.log("## Post-apply re-detection\n");
  const after = await detectAll(prisma);
  printPendingLockouts(after.pendingLockouts);
  printAddressSentinels(after.addressSentinels);
  const post = printSummary(after);

  if (post.totalFindings === 0) {
    console.log("Clean. Nothing left to repair.");
    return EXIT_CLEAN;
  }
  console.log(
    `${post.totalFindings} finding(s) remain (${post.reportOnly} need a human` +
      `${reportOnlyAddresses ? "; --report-only-addresses suppressed the address writes" : ""}).`,
  );
  return EXIT_WORK_REMAINS;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(EXIT_ERROR);
  });
