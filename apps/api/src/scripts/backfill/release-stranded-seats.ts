/**
 * release-stranded-seats.ts — DRY-RUN-BY-DEFAULT backfill that gives back the
 * reserved seats stranded by the refund bug fixed forward in 0c77c77c.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Before 0c77c77c, refunding a seated ticket left `Seat.status = SOLD` and the
 * dead ticket's `seatId` pointing at it, forever. Three locks, each sufficient
 * on its own: no code path wrote a SOLD seat back to AVAILABLE (the writes that
 * exist are HELD-gated), `findBySeatIds` had no status filter so a REFUNDED row
 * kept blocking, and `Ticket.seatId` is `@unique` so freeing the seat alone
 * just moves the failure to mint. Cancelling a show refunds the whole house, so
 * one cancellation bricked every reserved seat in a layout.
 *
 * The fix is forward-only. Rows refunded BEFORE it landed still hold their
 * seats. This script releases exactly those.
 *
 * ── THE ORDERING REQUIREMENT (read before changing anything) ────────────────
 * Clear `Ticket.seatId` FIRST, flip the seat to AVAILABLE SECOND. Never
 * seats-first.
 *
 * An AVAILABLE seat under a live `@unique` link passes every checkout gate and
 * then fails `tickets.create` with P2002 -> `seat_taken` AFTER the buyer's card
 * is charged. That is strictly worse than the dead-inventory bug this script
 * fixes. `mintTickets` added a pre-flight that refuses before the charge, but
 * that is a net, not a licence — see the ORDERING REQUIREMENT comment in
 * packages/core/src/use-cases/orders/__tests__/seat-release-on-refund.test.ts
 * and the header of
 * packages/core/src/use-cases/orders/_shared/release-seats-for-voided-tickets.ts.
 *
 * The order is enforced in ./plan-release-stranded-seats.ts three ways:
 * statement order, an in-transaction re-read (`ticket.count({ seatId })` must
 * be 0 before the flip), and a refusal that skips the flip whenever the clear
 * did not do exactly what was expected.
 *
 * ── Safety properties ───────────────────────────────────────────────────────
 *   - Nothing is written unless `--apply` is passed. Dry run is the default.
 *   - A seat with ANY live ticket (VALID / SCANNED / LISTED — i.e.
 *     `SEAT_OWNING_TICKET_STATUSES`) is REFUSED, counted and listed. Freeing it
 *     would double-sell somebody's pass.
 *   - A SOLD/HELD seat with NO ticket at all is AMBIGUOUS: also dead
 *     inventory, but stranded by something this script did not diagnose
 *     (an abandoned mint, a hand edit). Counted and listed, never touched.
 *   - BLOCKED seats never get flipped. The dead link is cleared; the operator's
 *     block stays.
 *   - "Terminal" is `NOT SEAT_OWNING_TICKET_STATUSES` from @th/types — the same
 *     list the Prisma adapter filters `findBySeatIds` with — so the script
 *     cannot drift from the runtime definition of "occupied".
 *   - Seat history matches the forward path exactly: the CLI hands the real
 *     `makeOrderItemsRepo(tx).recordReleasedSeats` to the write routine, so a
 *     backfilled item gets the same `meta.releasedSeatId` a refund written
 *     today does.
 *   - Batched. Each batch is ONE interactive transaction, bounded by
 *     `--batch-size` (default 50, max 500). The whole table is never one
 *     statement.
 *   - Idempotent and resumable: a released seat leaves the candidate set (its
 *     ticket no longer points at it), so a second run examines 0 rows. Killing
 *     the process mid-run loses at most the in-flight batch, which rolls back.
 *   - `--apply` against a non-local database requires
 *     `--confirm-remote-host=<host>` matching the resolved hostname.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 *   - It does not refund, re-issue, or notify anyone. It returns inventory.
 *   - It does not touch orders, payouts or ledger rows. The money already
 *     moved; this is a seat map repair.
 *   - It does not reconcile capacity counters. Nothing counts seats off
 *     `Seat.status` alone today; if that changes, re-check before running.
 *
 * USAGE — run from the REPO ROOT:
 *
 *   # dry run (local dev) — prints the full plan, writes nothing
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dev?schema=public \
 *     pnpm exec tsx apps/api/src/scripts/backfill/release-stranded-seats.ts
 *
 *   # dry run scoped to one show, saving the plan as the rollback record
 *   DATABASE_URL=... pnpm exec tsx \
 *     apps/api/src/scripts/backfill/release-stranded-seats.ts \
 *     --event-id=<uuid> --plan-file=/tmp/stranded-seats.json
 *
 *   # apply (local dev)
 *   DATABASE_URL=... pnpm exec tsx \
 *     apps/api/src/scripts/backfill/release-stranded-seats.ts --apply
 *
 *   # apply (remote) — host must be named back
 *   DATABASE_URL=<url> pnpm exec tsx \
 *     apps/api/src/scripts/backfill/release-stranded-seats.ts \
 *     --apply --confirm-remote-host=<host> --limit=500
 */

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { makeOrderItemsRepo } from "@th/adapters/db/prisma/order-items";
import { getPrisma } from "@th/db";

import {
  classifySeat,
  parseBatchSize,
  parseLimit,
  parseOptionalId,
  planFor,
  releaseStrandedSeat,
  TERMINAL_TICKET_STATUS_FILTER,
  type ClaimingTicket,
  type SeatCandidate,
  type SeatReleasePlan,
  type SeatStatus,
} from "./plan-release-stranded-seats";

const SCRIPT_NAME = "release-stranded-seats";
const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
]);

/**
 * Per-batch transaction budget. A batch is up to `--batch-size` seats and each
 * seat costs ~4 round trips, so Prisma's 5s default is not enough against a
 * remote database — and a timeout mid-batch rolls the batch back, which looks
 * like "the script did nothing" to an operator watching counts.
 */
const TX_TIMEOUT_MS = 120_000;
const TX_MAX_WAIT_MS = 15_000;

type ParsedValues = {
  apply?: boolean;
  "confirm-remote-host"?: string;
  limit?: string;
  "batch-size"?: string;
  "event-id"?: string;
  "start-after"?: string;
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
      "batch-size": { type: "string" },
      "event-id": { type: "string" },
      "start-after": { type: "string" },
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
  // silently no-op, so an operator who asked for a record would get none.
  if (raw.trim() === "") {
    throw new Error("--plan-file needs a path (got an empty value)");
  }
  return raw;
}

// ALL argument handling runs inside main() (see `resolveArgs`), never at module
// evaluation: `parseArgs` with `strict: true` throws on a typo'd flag, and
// doing that at import time escapes `main().catch` and prints a raw Node stack
// trace instead of the script's own `${SCRIPT_NAME} failed:` line.
let values: ParsedValues = {};
let APPLY = false;
let LIMIT: number | undefined;
let BATCH_SIZE = 50;
let EVENT_ID: string | undefined;
let START_AFTER: string | undefined;
let PLAN_FILE: string | undefined;

function resolveArgs(): void {
  values = parseCliArgs();
  APPLY = values.apply === true;
  LIMIT = parseLimit(values.limit);
  BATCH_SIZE = parseBatchSize(values["batch-size"]);
  EVENT_ID = parseOptionalId(values["event-id"], "--event-id");
  START_AFTER = parseOptionalId(values["start-after"], "--start-after");
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

type SeatRow = {
  id: string;
  status: string;
  label: string;
  seatSection: { eventId: string; name: string; event: { title: string } };
};

function toCandidate(
  row: SeatRow,
  tickets: readonly ClaimingTicket[],
): SeatCandidate {
  return {
    seatId: row.id,
    seatStatus: row.status as SeatStatus,
    label: row.label,
    sectionName: row.seatSection.name,
    eventId: row.seatSection.eventId,
    eventTitle: row.seatSection.event.title,
    tickets,
  };
}

/** One line an operator can paste into a seat-map query. */
function describeRow(row: SeatRow): string {
  return `${row.id}  ${row.seatSection.event.title} / ${row.seatSection.name} / ${row.label}`;
}

async function main() {
  resolveArgs();
  const host = resolveDbHost();
  assertWriteAllowed(host);

  console.log(
    `${SCRIPT_NAME} — ${APPLY ? "APPLY" : "DRY RUN"} against ${host}\n` +
      (EVENT_ID ? `  scoped to event ${EVENT_ID}\n` : "") +
      `  batch size ${BATCH_SIZE}${LIMIT ? `, limit ${LIMIT}` : ""}\n`,
  );

  const prisma = getPrisma();

  const stats = {
    examined: 0,
    eligible: 0,
    eligibleFlip: 0,
    eligibleLinkOnly: 0,
    rewritten: 0,
    seatsFreed: 0,
    refusedLiveTicket: 0,
    ambiguous: 0,
    alreadyReleased: 0,
    refusedAtWrite: 0,
    batchFailed: 0,
  };

  const attention: Array<{ id: string; what: string; note: string }> = [];
  const plan: SeatReleasePlan[] = [];

  // Keyset pagination on `Seat.id`, NOT Prisma's `cursor`: an applied batch
  // takes its rows OUT of the candidate set, so a plain `take` loop would
  // either re-read forever or skip rows, and refused/ambiguous rows stay
  // candidates and would spin a naive loop. `id > lastSeen` always advances.
  let lastSeen = START_AFTER ?? "";

  for (;;) {
    const remaining = LIMIT === undefined ? BATCH_SIZE : LIMIT - stats.examined;
    if (remaining <= 0) break;
    const take = Math.min(BATCH_SIZE, remaining);

    const rows = await prisma.seat.findMany({
      where: {
        id: { gt: lastSeen },
        ...(EVENT_ID ? { seatSection: { eventId: EVENT_ID } } : {}),
        // The candidate set: a seat whose claiming ticket is TERMINAL. Written
        // as `notIn` the owning triple so the terminal set is never enumerated
        // here and cannot drift from @th/types.
        ticket: { is: { status: { notIn: TERMINAL_TICKET_STATUS_FILTER } } },
      },
      select: {
        id: true,
        status: true,
        label: true,
        seatSection: {
          select: { eventId: true, name: true, event: { select: { title: true } } },
        },
      },
      orderBy: { id: "asc" },
      take,
    });

    if (rows.length === 0) break;
    lastSeen = rows[rows.length - 1]!.id;
    stats.examined += rows.length;

    // Claiming tickets read WITHOUT the to-one relation, so the refusal below
    // is a real check and not a restatement of the @unique index.
    const claims = await prisma.ticket.findMany({
      where: { seatId: { in: rows.map((r) => r.id) } },
      select: { id: true, status: true, orderItemId: true, seatId: true },
    });
    const bySeat = new Map<string, ClaimingTicket[]>();
    for (const t of claims) {
      if (!t.seatId) continue;
      const list = bySeat.get(t.seatId) ?? [];
      list.push({ id: t.id, status: t.status, orderItemId: t.orderItemId });
      bySeat.set(t.seatId, list);
    }

    const rowById = new Map(rows.map((r) => [r.id, r]));
    const batchPlans: SeatReleasePlan[] = [];

    for (const row of rows) {
      const candidate = toCandidate(row, bySeat.get(row.id) ?? []);
      const classification = classifySeat(candidate);

      switch (classification.kind) {
        case "already-released":
          stats.alreadyReleased += 1;
          continue;
        case "refused-live-ticket":
          stats.refusedLiveTicket += 1;
          attention.push({
            id: row.id,
            what: describeRow(row),
            note: `REFUSED (live ticket) — ${classification.reason}. Tickets: ${classification.liveTicketIds.join(", ")}`,
          });
          continue;
        case "ambiguous":
          stats.ambiguous += 1;
          attention.push({
            id: row.id,
            what: describeRow(row),
            note: `AMBIGUOUS — ${classification.reason}`,
          });
          continue;
        case "eligible":
          break;
      }

      const seatPlan = planFor(candidate, classification);
      stats.eligible += 1;
      if (seatPlan.flipSeat) stats.eligibleFlip += 1;
      else stats.eligibleLinkOnly += 1;
      batchPlans.push(seatPlan);
      plan.push(seatPlan);

      console.log(
        `  ${describeRow(row)}\n` +
          `    seat ${seatPlan.seatStatus}` +
          (seatPlan.flipSeat ? " -> AVAILABLE" : " (unchanged)") +
          `, clear seatId on ${seatPlan.ticketIds.length} ticket(s): ${seatPlan.ticketIds.join(", ")}` +
          (seatPlan.note ? `\n    NOTE: ${seatPlan.note}` : ""),
      );
    }

    if (!APPLY || batchPlans.length === 0) continue;

    try {
      // ONE transaction per batch. Each seat inside it is independent, and
      // every write it makes is safe on its own — a batch that dies half way
      // rolls back, and a re-run re-examines whatever is left.
      const outcomes = await prisma.$transaction(
        async (tx) => {
          // The REAL forward-path seat-history writer, so a backfilled order
          // item carries the same `meta.releasedSeatId` a refund written today
          // does — not a second hand-rolled copy that can drift from it.
          const deps = {
            recordReleasedSeats: makeOrderItemsRepo(tx).recordReleasedSeats,
          };
          const results = [];
          for (const seatPlan of batchPlans) {
            results.push(await releaseStrandedSeat(tx, deps, seatPlan));
          }
          return results;
        },
        { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
      );

      for (const outcome of outcomes) {
        if (outcome.kind === "released") {
          stats.rewritten += 1;
          if (outcome.flippedSeat) stats.seatsFreed += 1;
        } else {
          stats.refusedAtWrite += 1;
          const row = rowById.get(outcome.seatId);
          attention.push({
            id: outcome.seatId,
            what: row ? describeRow(row) : outcome.seatId,
            note: `REFUSED AT WRITE — ${outcome.reason}`,
          });
        }
      }
    } catch (err) {
      // The batch rolled back whole. Name every seat in it: the counts alone
      // would leave an operator with no idea what to retry.
      stats.batchFailed += 1;
      for (const seatPlan of batchPlans) {
        const row = rowById.get(seatPlan.seatId);
        attention.push({
          id: seatPlan.seatId,
          what: row ? describeRow(row) : seatPlan.seatId,
          note: `BATCH FAILED (rolled back, nothing written) — ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  console.log(`\n── ${APPLY ? "Applied" : "Plan"} ─────────────────────────`);
  console.log(`  examined               ${stats.examined}  (seats whose claiming ticket is terminal)`);
  console.log(`  eligible               ${stats.eligible}`);
  console.log(`    seat -> AVAILABLE    ${stats.eligibleFlip}`);
  console.log(`    link cleared only    ${stats.eligibleLinkOnly}  (seat already AVAILABLE, or BLOCKED)`);
  console.log(`  refused (live ticket)  ${stats.refusedLiveTicket}  (somebody's pass — never freed)`);
  console.log(`  ambiguous              ${stats.ambiguous}  (review by hand)`);
  console.log(`  already released       ${stats.alreadyReleased}  (nothing to do)`);
  if (APPLY) {
    console.log(`  rewritten              ${stats.rewritten}`);
    console.log(`    seats freed          ${stats.seatsFreed}`);
    console.log(`  refused at write       ${stats.refusedAtWrite}`);
    console.log(`  batches failed         ${stats.batchFailed}`);
  } else {
    console.log(`\n  DRY RUN — nothing was written. Re-run with --apply.`);
  }
  if (LIMIT !== undefined && stats.examined >= LIMIT) {
    console.log(
      `\n  --limit ${LIMIT} reached. Re-run to continue` +
        (lastSeen ? ` (or --start-after=${lastSeen} to resume here).` : "."),
    );
  }

  if (PLAN_FILE && plan.length > 0) {
    // Wrapped: on an --apply run the rows are ALREADY rewritten by now, and the
    // attention list below is the only record of which ids failed or need a
    // human. Letting an ENOENT here reject main() would take that list with it.
    try {
      writeFileSync(PLAN_FILE, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
      console.log(
        `\n  Plan written to ${PLAN_FILE} (${plan.length} seat(s)) — keep it: ` +
          `after the write, the ticket -> seat links it names are gone.`,
      );
    } catch (err) {
      console.error(
        `\n  WARNING: could not write the plan file ${PLAN_FILE}: ` +
          `${err instanceof Error ? err.message : String(err)}\n` +
          `  The plan is printed above; copy it from the console.`,
      );
    }
  }

  // Always printed. On an --apply run this is the ONLY record of which seats
  // were refused, failed, or need a human, so suppressing it would leave an
  // operator with counts and nothing to retry.
  if (attention.length > 0) {
    console.log(`\n── Needs a human ─────────────────────────`);
    for (const item of attention) {
      console.log(`  ${item.what}\n    ${item.note}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`${SCRIPT_NAME} failed:`, err);
    process.exit(1);
  });
