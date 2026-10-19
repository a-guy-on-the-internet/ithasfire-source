import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeOrdersRepo } from "../orders";

// ---------------------------------------------------------------------------
// Processor-fee sweep claim + bookkeeping (integration).
//
// Two things here are not provable against a mocked Prisma client:
//
//  1. The CLAIM FILTER's backoff and park predicates — a row that failed is
//     excluded until its last failure is older than `now − backoff`, a row at
//     the cap is excluded outright, and the ordering stays oldest-first
//     across all of it. Oldest-first alone used to hand a dead row back every
//     run; the predicates are what stop it from starving newer rows.
//  2. `recordProcessorFeeReadFailure` is a single guarded UPDATE ... RETURNING:
//     it must increment atomically, return the NEW count, and do NOTHING to a
//     row whose fee has already been stamped.
//
// THE MIGRATION SQL IS READ FROM DISK, NOT RETYPED (house precedent). The
// table is created in its pre-migration shape and the shipped bytes are
// applied on top, so what is tested is the migration that ships.
// ---------------------------------------------------------------------------

const MIGRATION_SQL = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../db/prisma/migrations/20260915190000_processor_fee_read_backoff/migration.sql",
  ),
  "utf8",
);

// Only the columns the methods touch. Prisma selects exactly what the
// `select` names, so the table need not carry the rest of Order — except
// "updatedAt": the model is @updatedAt, so every Prisma UPDATE (the stamp's
// updateMany) writes it whether asked to or not.
const TABLE_SQL = `
CREATE TYPE "OrderStatus" AS ENUM (
  'PENDING', 'PROCESSING', 'SUCCEEDED', 'PART_REFUNDED',
  'REFUNDED', 'DISPUTED', 'CANCELLED'
);

CREATE TABLE "Order" (
  "id"                    TEXT NOT NULL,
  "status"                "OrderStatus" NOT NULL DEFAULT 'PENDING',
  "currency"              VARCHAR(3) NOT NULL DEFAULT 'usd',
  "occurredAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "stripePaymentIntentId" TEXT,
  "processorFeeCents"     INTEGER,
  CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);
`;

const NOW = new Date("2026-09-15T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const BACKOFF = 6 * HOUR;
const MAX = 3; // small cap so the park case is cheap to reach

describe("orders processor-fee sweep claim + bookkeeping (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let orders: ReturnType<typeof makeOrdersRepo>;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(TABLE_SQL);
    await pool.query(MIGRATION_SQL);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    orders = makeOrdersRepo(prisma);
  }, 300_000);

  beforeEach(async () => {
    await pool!.query(`TRUNCATE "Order"`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  async function order(opts: {
    id: string;
    occurredAt: Date;
    status?: string;
    intent?: string | null;
    feeCents?: number | null;
    failures?: number;
    failedAt?: Date | null;
  }) {
    // TIMESTAMP(3) is tz-NAIVE and Prisma reads/writes it as UTC, but
    // node-pg serialises a JS Date in HOST-LOCAL time. Go through
    // timestamptz → AT TIME ZONE 'UTC' with ISO strings so the stored naive
    // value is the UTC instant regardless of the host's zone.
    await pool!.query(
      `INSERT INTO "Order"
         ("id","status","occurredAt","stripePaymentIntentId","processorFeeCents",
          "processorFeeReadFailures","processorFeeReadFailedAt")
       VALUES ($1, $2::"OrderStatus", ($3::timestamptz AT TIME ZONE 'UTC'), $4, $5, $6,
               ($7::timestamptz AT TIME ZONE 'UTC'))`,
      [
        opts.id,
        opts.status ?? "SUCCEEDED",
        opts.occurredAt.toISOString(),
        opts.intent === undefined ? `pi_${opts.id}` : opts.intent,
        opts.feeCents ?? null,
        opts.failures ?? 0,
        opts.failedAt ? opts.failedAt.toISOString() : null,
      ],
    );
  }

  async function row(id: string) {
    // Same trap on the way out: read the naive column back AS UTC so node-pg
    // hands us the instant Prisma wrote, not a host-local reinterpretation.
    const res = await pool!.query<{
      processorFeeCents: number | null;
      processorFeeReadFailures: number;
      processorFeeReadFailedAt: Date | null;
    }>(
      `SELECT "processorFeeCents",
              "processorFeeReadFailures",
              ("processorFeeReadFailedAt" AT TIME ZONE 'UTC') AS "processorFeeReadFailedAt"
       FROM "Order" WHERE "id" = $1`,
      [id],
    );
    return res.rows[0]!;
  }

  const claim = () =>
    orders.listOrdersMissingProcessorFee({
      limit: 10,
      now: NOW,
      retryBackoffMs: BACKOFF,
      maxFailures: MAX,
    });

  // ── The migration's defaults: an existing row is "never failed" ───────────

  test("a pre-existing row claims as before — 0 failures, no timestamp", async () => {
    await order({ id: "a", occurredAt: new Date("2026-09-01T00:00:00Z") });
    const rows = await claim();
    expect(rows).toEqual([
      {
        id: "a",
        stripePaymentIntentId: "pi_a",
        currency: "usd",
        occurredAt: new Date("2026-09-01T00:00:00Z"),
        processorFeeReadFailures: 0,
      },
    ]);
  });

  // ── Backoff ───────────────────────────────────────────────────────────────

  test("a row that failed inside the backoff window is skipped; outside it is claimed", async () => {
    // Failed one hour ago: still cooling off.
    await order({
      id: "recent",
      occurredAt: new Date("2026-09-01T00:00:00Z"),
      failures: 1,
      failedAt: new Date(NOW.getTime() - 1 * HOUR),
    });
    // Failed seven hours ago: past the six-hour window.
    await order({
      id: "stale",
      occurredAt: new Date("2026-09-02T00:00:00Z"),
      failures: 1,
      failedAt: new Date(NOW.getTime() - 7 * HOUR),
    });
    // Never failed.
    await order({ id: "fresh", occurredAt: new Date("2026-09-03T00:00:00Z") });

    const ids = (await claim()).map((r) => r.id);
    expect(ids).toEqual(["stale", "fresh"]);
    expect(ids).not.toContain("recent");
  });

  test("a failure EXACTLY on the boundary is still backed off (strict less-than)", async () => {
    await order({
      id: "edge",
      occurredAt: new Date("2026-09-01T00:00:00Z"),
      failures: 1,
      failedAt: new Date(NOW.getTime() - BACKOFF),
    });
    expect(await claim()).toEqual([]);
  });

  // ── Park ──────────────────────────────────────────────────────────────────

  test("a row at the cap is parked even once its backoff has long expired", async () => {
    await order({
      id: "dead",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      failures: MAX,
      failedAt: new Date("2026-02-01T00:00:00Z"),
    });
    await order({
      id: "over",
      occurredAt: new Date("2026-01-02T00:00:00Z"),
      failures: MAX + 5,
      failedAt: new Date("2026-02-01T00:00:00Z"),
    });
    await order({
      id: "one-short",
      occurredAt: new Date("2026-01-03T00:00:00Z"),
      failures: MAX - 1,
      failedAt: new Date("2026-02-01T00:00:00Z"),
    });

    const ids = (await claim()).map((r) => r.id);
    expect(ids).toEqual(["one-short"]);
  });

  test("THE BUG: dead rows no longer occupy the page — newer rows are reached", async () => {
    // Twelve permanently failing rows older than everything else, a page of
    // ten. Before: the page was those ten dead rows, every hour, forever.
    for (let i = 0; i < 12; i += 1) {
      await order({
        id: `dead_${i}`,
        occurredAt: new Date(2026, 0, 1 + i),
        failures: MAX,
        failedAt: new Date("2026-06-01T00:00:00Z"),
      });
    }
    await order({ id: "newest", occurredAt: new Date("2026-09-10T00:00:00Z") });

    const ids = (await claim()).map((r) => r.id);
    expect(ids).toEqual(["newest"]);
  });

  test("ordering stays oldest-first across never-failed and retry-eligible rows", async () => {
    await order({ id: "c", occurredAt: new Date("2026-09-03T00:00:00Z") });
    await order({
      id: "a",
      occurredAt: new Date("2026-09-01T00:00:00Z"),
      failures: 2,
      failedAt: new Date("2026-09-01T01:00:00Z"),
    });
    await order({ id: "b", occurredAt: new Date("2026-09-02T00:00:00Z") });

    expect((await claim()).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  test("the other claim predicates are untouched: stamped, intent-less and uncharged rows stay out", async () => {
    await order({ id: "stamped", occurredAt: new Date("2026-09-01T00:00:00Z"), feeCents: 30 });
    await order({ id: "no-intent", occurredAt: new Date("2026-09-01T00:00:00Z"), intent: null });
    await order({ id: "pending", occurredAt: new Date("2026-09-01T00:00:00Z"), status: "PENDING" });
    await order({ id: "cancelled", occurredAt: new Date("2026-09-01T00:00:00Z"), status: "CANCELLED" });
    await order({ id: "disputed", occurredAt: new Date("2026-09-02T00:00:00Z"), status: "DISPUTED" });

    expect((await claim()).map((r) => r.id)).toEqual(["disputed"]);
  });

  test("omitted backoff / cap fall back to the shared defaults (6h, 24)", async () => {
    await order({
      id: "five-hours",
      occurredAt: new Date("2026-09-01T00:00:00Z"),
      failures: 1,
      failedAt: new Date(NOW.getTime() - 5 * HOUR),
    });
    await order({
      id: "seven-hours",
      occurredAt: new Date("2026-09-02T00:00:00Z"),
      failures: 23,
      failedAt: new Date(NOW.getTime() - 7 * HOUR),
    });
    await order({
      id: "capped",
      occurredAt: new Date("2026-09-03T00:00:00Z"),
      failures: 24,
      failedAt: new Date(NOW.getTime() - 7 * HOUR),
    });

    const rows = await orders.listOrdersMissingProcessorFee({ limit: 10, now: NOW });
    expect(rows.map((r) => r.id)).toEqual(["seven-hours"]);
  });

  // ── recordProcessorFeeReadFailure ─────────────────────────────────────────

  test("records a failure: increments the count, stamps the time, returns the NEW count", async () => {
    await order({ id: "x", occurredAt: new Date("2026-09-01T00:00:00Z") });

    const first = await orders.recordProcessorFeeReadFailure({
      orderId: "x",
      failedAt: NOW,
    });
    expect(first).toBe(1);
    expect(await row("x")).toEqual({
      processorFeeCents: null,
      processorFeeReadFailures: 1,
      processorFeeReadFailedAt: NOW,
    });

    const later = new Date(NOW.getTime() + 7 * HOUR);
    const second = await orders.recordProcessorFeeReadFailure({
      orderId: "x",
      failedAt: later,
    });
    expect(second).toBe(2);
    expect(await row("x")).toMatchObject({
      processorFeeReadFailures: 2,
      processorFeeReadFailedAt: later,
    });
  });

  test("RACE-SAFE: a row stamped by a concurrent run is never marked failed", async () => {
    // Claimed while NULL, then a peer sweep stamped it before our failure
    // landed. The bookkeeping must not touch a measured row.
    await order({ id: "won", occurredAt: new Date("2026-09-01T00:00:00Z") });
    const didStamp = await orders.stampProcessorFee({ orderId: "won", feeCents: 59 });
    expect(didStamp).toBe(true);

    const count = await orders.recordProcessorFeeReadFailure({
      orderId: "won",
      failedAt: NOW,
    });

    expect(count).toBe(0);
    expect(await row("won")).toEqual({
      processorFeeCents: 59,
      processorFeeReadFailures: 0,
      processorFeeReadFailedAt: null,
    });
  });

  test("an unknown order records nothing and returns 0", async () => {
    expect(
      await orders.recordProcessorFeeReadFailure({ orderId: "nope", failedAt: NOW }),
    ).toBe(0);
  });

  test("a stamp after failures leaves the bookkeeping as history and the row leaves the claim set", async () => {
    await order({
      id: "recovered",
      occurredAt: new Date("2026-09-01T00:00:00Z"),
      failures: 2,
      failedAt: new Date(NOW.getTime() - 7 * HOUR),
    });
    expect((await claim()).map((r) => r.id)).toEqual(["recovered"]);

    expect(await orders.stampProcessorFee({ orderId: "recovered", feeCents: 41 })).toBe(true);

    expect(await claim()).toEqual([]);
    // History, not reset: nothing reads it after a stamp, and it may be
    // useful forensics.
    expect(await row("recovered")).toMatchObject({
      processorFeeCents: 41,
      processorFeeReadFailures: 2,
    });
  });
});
