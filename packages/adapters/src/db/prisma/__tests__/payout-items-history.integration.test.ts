import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import {
  __testOnlyPayoutHistoryHooks,
  makePayoutItemsRepo,
} from "../payout-items";

// ---------------------------------------------------------------------------
// Integration coverage for `listHistory` — the PAID half of the staff
// settlements page. Raw SQL with a two-table join, a COALESCE sort key that
// straddles both tables, a keyset cursor and a window-function total: none of
// it is provable against a mocked Prisma client, so this hits real Postgres.
//
// Same harness shape as `payee-ledger-debt-positions.integration.test.ts`:
// hand-rolled DDL for exactly the columns the statement touches, a real
// PrismaClient over PrismaPg (WITHOUT which these adapter suites silently
// skip), and a TRUNCATE between cases.
//
// The load-bearing property under test is the ORDERING CONTRACT: one column
// (`occurredAt`) drives both the sort and the date the UI renders, so a row
// can never display one instant and sort by another.
// ---------------------------------------------------------------------------

const TABLE_SQL = `
CREATE TYPE "PayeeSubjectType" AS ENUM ('ORGANIZATION', 'HUMAN');

CREATE TABLE "Payee" (
  "id" TEXT NOT NULL,
  "subjectType" "PayeeSubjectType" NOT NULL,
  "subjectId" TEXT NOT NULL,
  CONSTRAINT "Payee_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Payout" (
  "id" TEXT NOT NULL,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "canceledAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'scheduled',
  "processorBatchId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PayoutItem" (
  "id" TEXT NOT NULL,
  "payoutId" TEXT NOT NULL,
  "payeeId" TEXT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
  "amountCents" INTEGER NOT NULL,
  "connectAccountFeeCents" INTEGER NOT NULL DEFAULT 0,
  "recoveredDebtCents" INTEGER NOT NULL DEFAULT 0,
  "reserveHeldCents" INTEGER NOT NULL DEFAULT 0,
  "reserveReleasedCents" INTEGER NOT NULL DEFAULT 0,
  "plannedCreditEntryIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "plannedOrderItemIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "plannedNetCents" INTEGER NOT NULL DEFAULT 0,
  "payoutLedgerKey" TEXT,
  "stripeTransferId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "failedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "transferredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayoutItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PayoutItem_payoutId_fkey" FOREIGN KEY ("payoutId")
    REFERENCES "Payout"("id") ON DELETE CASCADE,
  CONSTRAINT "PayoutItem_payeeId_fkey" FOREIGN KEY ("payeeId")
    REFERENCES "Payee"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "PayoutItem_payoutId_payeeId_currency_key"
  ON "PayoutItem"("payoutId", "payeeId", "currency");
`;

const ORG_PAYEE = "payee_org";
const HUMAN_PAYEE = "payee_human";

const T = (iso: string) => new Date(iso);

describe("payout-items listHistory (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let repo: ReturnType<typeof makePayoutItemsRepo>;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(TABLE_SQL);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    repo = makePayoutItemsRepo(prisma);
  }, 300_000);

  beforeEach(async () => {
    __testOnlyPayoutHistoryHooks.beforeQuery = null;
    await pool!.query(`TRUNCATE "PayoutItem", "Payout", "Payee"`);
    await pool!.query(
      `INSERT INTO "Payee" ("id", "subjectType", "subjectId") VALUES
        ($1, 'ORGANIZATION', 'org_1'),
        ($2, 'HUMAN', 'human_1')`,
      [ORG_PAYEE, HUMAN_PAYEE],
    );
  });

  // Tearing a Testcontainers Postgres down routinely outruns vitest's 10s
  // default hook timeout, failing a suite whose every test already passed.
  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  async function insertPayout(opts: {
    id: string;
    scheduledFor: Date;
    status?: string;
    processorBatchId?: string | null;
  }) {
    await pool!.query(
      `INSERT INTO "Payout" ("id","scheduledFor","status","processorBatchId")
       VALUES ($1, $2::timestamp, $3, $4)`,
      [
        opts.id,
        opts.scheduledFor.toISOString(),
        opts.status ?? "completed",
        opts.processorBatchId ?? null,
      ],
    );
  }

  // Timestamps go over the wire as ISO strings, not JS Dates: the columns are
  // TIMESTAMP(3) WITHOUT time zone and node-pg serialises a Date in the
  // process's LOCAL zone, which would shift every pinned instant by the box's
  // UTC offset.
  async function insertItem(opts: {
    id: string;
    payoutId: string;
    payeeId?: string;
    currency?: string;
    amountCents?: number;
    connectAccountFeeCents?: number;
    recoveredDebtCents?: number;
    reserveHeldCents?: number;
    reserveReleasedCents?: number;
    plannedNetCents?: number;
    status?: string;
    transferredAt?: Date | null;
    failedAt?: Date | null;
    failureReason?: string | null;
    stripeTransferId?: string | null;
    /** Post-cutover rows carry one; pre-cutover rows do not. */
    payoutLedgerKey?: string | null;
  }) {
    await pool!.query(
      `INSERT INTO "PayoutItem"
        ("id","payoutId","payeeId","currency","amountCents",
         "connectAccountFeeCents","recoveredDebtCents","reserveHeldCents",
         "reserveReleasedCents","plannedNetCents","status","transferredAt",
         "failedAt","failureReason","stripeTransferId","payoutLedgerKey")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamp,$13::timestamp,$14,$15,$16)`,
      [
        opts.id,
        opts.payoutId,
        opts.payeeId ?? ORG_PAYEE,
        opts.currency ?? "usd",
        opts.amountCents ?? 50_000,
        opts.connectAccountFeeCents ?? 0,
        opts.recoveredDebtCents ?? 0,
        opts.reserveHeldCents ?? 0,
        opts.reserveReleasedCents ?? 0,
        opts.plannedNetCents ?? opts.amountCents ?? 50_000,
        opts.status ?? "transferred",
        opts.transferredAt ? opts.transferredAt.toISOString() : null,
        opts.failedAt ? opts.failedAt.toISOString() : null,
        opts.failureReason ?? null,
        opts.stripeTransferId ?? null,
        // Default POST-cutover, so existing cases keep a recorded net.
        opts.payoutLedgerKey === undefined
          ? `payout:${opts.id}`
          : opts.payoutLedgerKey,
      ],
    );
  }

  test("returns when / how much / to whom with every deduction, joined to the Payee subject", async () => {
    await insertPayout({
      id: "po_1",
      scheduledFor: T("2026-09-08T05:00:00.000Z"),
      processorBatchId: "batch_1",
    });
    await insertItem({
      id: "pi_1",
      payoutId: "po_1",
      amountCents: 50_000,
      connectAccountFeeCents: 200,
      reserveHeldCents: 1_000,
      reserveReleasedCents: 250,
      plannedNetCents: 49_050,
      status: "transferred",
      transferredAt: T("2026-09-09T05:00:00.000Z"),
      stripeTransferId: "tr_123",
    });

    const page = await repo.listHistory({});

    expect(page.total).toBe(1);
    expect(page.pageInfo.hasNextPage).toBe(false);
    expect(page.pageInfo.nextCursor).toBeNull();
    expect(page.items[0]).toEqual({
      id: "pi_1",
      payoutId: "po_1",
      payeeId: ORG_PAYEE,
      subjectType: "ORGANIZATION",
      subjectId: "org_1",
      currency: "usd",
      amountCents: 50_000,
      connectAccountFeeCents: 200,
      recoveredDebtCents: 0,
      reserveHeldCents: 1_000,
      reserveReleasedCents: 250,
      netCents: 49_050,
      status: "transferred",
      transferredAt: T("2026-09-09T05:00:00.000Z"),
      failedAt: null,
      failureReason: null,
      stripeTransferId: "tr_123",
      occurredAt: T("2026-09-09T05:00:00.000Z"),
      scheduledFor: T("2026-09-08T05:00:00.000Z"),
      payoutStatus: "completed",
      processorBatchId: "batch_1",
      createdAt: expect.any(Date),
    });

    // The arithmetic the UI shows as gross → net must hold on the real row.
    const row = page.items[0]!;
    expect(
      row.amountCents -
        row.recoveredDebtCents -
        row.reserveHeldCents -
        row.connectAccountFeeCents +
        row.reserveReleasedCents,
    ).toBe(row.netCents);
  });

  test("a transferred item dates on transferredAt; a pending or failed one dates on its batch's scheduledFor", async () => {
    await insertPayout({ id: "po_old", scheduledFor: T("2026-09-01T05:00:00.000Z") });
    await insertPayout({
      id: "po_tonight",
      scheduledFor: T("2026-09-10T05:00:00.000Z"),
      status: "running",
    });
    // Transferred a week ago, from the OLD batch.
    await insertItem({
      id: "pi_done",
      payoutId: "po_old",
      status: "transferred",
      transferredAt: T("2026-09-02T05:00:00.000Z"),
      stripeTransferId: "tr_old",
    });
    // In flight tonight — no transferredAt at all.
    await insertItem({
      id: "pi_pending",
      payoutId: "po_tonight",
      status: "pending",
      transferredAt: null,
    });
    await insertItem({
      id: "pi_failed",
      payoutId: "po_tonight",
      payeeId: HUMAN_PAYEE,
      status: "failed",
      transferredAt: null,
      failedAt: T("2026-09-10T05:10:00.000Z"),
      failureReason: "account_closed",
    });

    const page = await repo.listHistory({});

    // Money in flight sorts ABOVE settled history — the documented choice.
    expect(page.items.map((r) => r.id)).toEqual([
      "pi_pending",
      "pi_failed",
      "pi_done",
    ]);
    expect(page.items[0]!.occurredAt).toEqual(T("2026-09-10T05:00:00.000Z"));
    expect(page.items[1]).toMatchObject({
      occurredAt: T("2026-09-10T05:00:00.000Z"),
      failureReason: "account_closed",
      subjectType: "HUMAN",
      subjectId: "human_1",
    });
    expect(page.items[2]!.occurredAt).toEqual(T("2026-09-02T05:00:00.000Z"));
  });

  test("a PRE-CUTOVER backfilled zero reports netCents as NULL; a real net does not", async () => {
    // `plannedNetCents` was added `INTEGER NOT NULL DEFAULT 0`, so rows
    // written before that migration carry a zero they never earned. Showing
    // it would report a transferred $500 as "Sent $0.00" — money that
    // demonstrably moved, rendered as nothing sent.
    await insertPayout({ id: "po_old", scheduledFor: T("2026-08-01T05:00:00.000Z") });

    // (a) pre-cutover AND zero — indistinguishable from the backfill.
    await insertItem({
      id: "pi_backfilled",
      payoutId: "po_old",
      amountCents: 50_000,
      plannedNetCents: 0,
      status: "transferred",
      transferredAt: T("2026-08-01T06:00:00.000Z"),
      stripeTransferId: "tr_old",
      payoutLedgerKey: null,
    });
    // (b) post-cutover AND zero — a fully-withheld item. Genuinely $0.00.
    await insertItem({
      id: "pi_withheld",
      payoutId: "po_old",
      payeeId: HUMAN_PAYEE,
      amountCents: 50_000,
      plannedNetCents: 0,
      status: "transferred",
      transferredAt: T("2026-08-01T07:00:00.000Z"),
      stripeTransferId: "tr_new",
    });
    // (c) NO ledger key but a NON-ZERO net — no backfill can produce this,
    // so it is a real number. This is the shape the dev seed writes.
    await insertPayout({ id: "po_seed", scheduledFor: T("2026-08-02T05:00:00.000Z") });
    await insertItem({
      id: "pi_seedlike",
      payoutId: "po_seed",
      amountCents: 50_000,
      plannedNetCents: 49_800,
      status: "transferred",
      transferredAt: T("2026-08-02T06:00:00.000Z"),
      stripeTransferId: "tr_seedlike",
      payoutLedgerKey: null,
    });

    const page = await repo.listHistory({});
    const byId = new Map(page.items.map((r) => [r.id, r]));

    expect(byId.get("pi_backfilled")!.netCents).toBeNull();
    expect(byId.get("pi_withheld")!.netCents).toBe(0);
    expect(byId.get("pi_seedlike")!.netCents).toBe(49_800);
    // Gross is untouched throughout: it was never backfilled.
    expect(byId.get("pi_backfilled")!.amountCents).toBe(50_000);
  });

  test("the status filter narrows both the rows AND the total", async () => {
    await insertPayout({ id: "po_1", scheduledFor: T("2026-09-08T05:00:00.000Z") });
    await insertItem({
      id: "pi_a",
      payoutId: "po_1",
      status: "transferred",
      transferredAt: T("2026-09-08T06:00:00.000Z"),
    });
    await insertItem({
      id: "pi_b",
      payoutId: "po_1",
      payeeId: HUMAN_PAYEE,
      status: "failed",
      failedAt: T("2026-09-08T06:00:00.000Z"),
      failureReason: "insufficient_funds",
    });

    const all = await repo.listHistory({ status: "all" });
    expect(all.total).toBe(2);

    const failed = await repo.listHistory({ status: "failed" });
    expect(failed.total).toBe(1);
    expect(failed.items.map((r) => r.id)).toEqual(["pi_b"]);

    const transferred = await repo.listHistory({ status: "transferred" });
    expect(transferred.total).toBe(1);
    expect(transferred.items.map((r) => r.id)).toEqual(["pi_a"]);

    const pending = await repo.listHistory({ status: "pending" });
    expect(pending.total).toBe(0);
    expect(pending.items).toEqual([]);
    expect(pending.pageInfo.nextCursor).toBeNull();
  });

  test("the keyset cursor walks every row exactly once, including ties on the sort instant", async () => {
    await insertPayout({ id: "po_1", scheduledFor: T("2026-09-08T05:00:00.000Z") });
    // Five items, two of which share transferredAt to the millisecond — the
    // tiebreak on `id` is what keeps the cursor from skipping or repeating.
    const TIE = T("2026-09-08T06:00:00.000Z");
    await insertItem({ id: "pi_1", payoutId: "po_1", transferredAt: TIE });
    await insertItem({
      id: "pi_2",
      payoutId: "po_1",
      payeeId: HUMAN_PAYEE,
      transferredAt: TIE,
    });
    await insertPayout({ id: "po_2", scheduledFor: T("2026-09-07T05:00:00.000Z") });
    await insertItem({
      id: "pi_3",
      payoutId: "po_2",
      transferredAt: T("2026-09-07T06:00:00.000Z"),
    });
    await insertItem({
      id: "pi_4",
      payoutId: "po_2",
      payeeId: HUMAN_PAYEE,
      transferredAt: T("2026-09-06T06:00:00.000Z"),
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: Awaited<ReturnType<typeof repo.listHistory>> =
        await repo.listHistory({ limit: 2, cursor });
      seen.push(...page.items.map((r) => r.id));
      cursor = page.pageInfo.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toEqual(["pi_2", "pi_1", "pi_3", "pi_4"]);
    expect(new Set(seen).size).toBe(4);
  });

  test("the keyset walks rows spaced ONE HOUR apart exactly once", async () => {
    // Tight spacing on purpose. The cursor used to bind a JS `Date`, which
    // node-pg renders in the NODE PROCESS's zone with an offset
    // (measured: a UTC instant of 05:00 serialises as
    // "2026-09-07T22:00:00.000-07:00" under TZ=US/Pacific), and a bare
    // `::timestamp` cast then DROPS the offset — moving the page boundary
    // hours earlier and skipping every row in between.
    //
    // The other keyset test spaces its rows a DAY apart, which is wider
    // than any offset, so it could never see this. One-hour spacing means
    // any box with a non-zero UTC offset catches it end to end. The
    // process-independent gate is the `buildPayoutHistorySql` binding
    // assertion in payout-items.test.ts — a UTC box cannot see this one.
    const hours = [1, 2, 3, 4, 5, 6];
    for (const [i, hour] of hours.entries()) {
      const at = T(`2026-09-08T0${hour}:00:00.000Z`);
      // One item per batch: PayoutItem is unique on
      // (payoutId, payeeId, currency).
      await insertPayout({ id: `po_tz_${i}`, scheduledFor: at });
      await insertItem({
        id: `pi_tz_${i}`,
        payoutId: `po_tz_${i}`,
        payeeId: i % 2 === 0 ? ORG_PAYEE : HUMAN_PAYEE,
        transferredAt: at,
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 12; guard += 1) {
      const page: Awaited<ReturnType<typeof repo.listHistory>> =
        await repo.listHistory({ limit: 2, cursor });
      seen.push(...page.items.map((r) => r.id));
      cursor = page.pageInfo.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toEqual([
      "pi_tz_5",
      "pi_tz_4",
      "pi_tz_3",
      "pi_tz_2",
      "pi_tz_1",
      "pi_tz_0",
    ]);
    expect(new Set(seen).size).toBe(6);
  });
  test("a cursor that fails to decode restarts from the top instead of throwing", async () => {
    await insertPayout({ id: "po_1", scheduledFor: T("2026-09-08T05:00:00.000Z") });
    await insertItem({
      id: "pi_1",
      payoutId: "po_1",
      transferredAt: T("2026-09-08T06:00:00.000Z"),
    });

    const restarted = await repo.listHistory({ cursor: "not-a-cursor" });
    expect(restarted.items.map((r) => r.id)).toEqual(["pi_1"]);
  });

  test("the limit is clamped and `hasNextPage` reflects the extra row, not the page", async () => {
    await insertPayout({ id: "po_1", scheduledFor: T("2026-09-08T05:00:00.000Z") });
    await insertItem({
      id: "pi_1",
      payoutId: "po_1",
      transferredAt: T("2026-09-08T06:00:00.000Z"),
    });
    await insertItem({
      id: "pi_2",
      payoutId: "po_1",
      payeeId: HUMAN_PAYEE,
      transferredAt: T("2026-09-08T07:00:00.000Z"),
    });

    const page = await repo.listHistory({ limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.pageInfo.limit).toBe(1);
    expect(page.pageInfo.hasNextPage).toBe(true);
    expect(page.pageInfo.nextCursor).not.toBeNull();
    // `total` counts every row at or after the cursor, not the page.
    expect(page.total).toBe(2);

    const clamped = await repo.listHistory({ limit: 10_000 });
    expect(clamped.pageInfo.limit).toBe(200);

    const floored = await repo.listHistory({ limit: 0 });
    expect(floored.pageInfo.limit).toBe(1);
  });

  test("an empty ledger of payouts reports an empty page, not a throw", async () => {
    const page = await repo.listHistory({});
    expect(page).toMatchObject({
      items: [],
      total: 0,
      pageInfo: { nextCursor: null, hasNextPage: false },
    });
  });

  test("a read on a TransactionClient is REFUSED — SET LOCAL must never leak onto a caller's transaction", async () => {
    await expect(
      prisma!.$transaction(async (tx) => makePayoutItemsRepo(tx).listHistory({})),
    ).rejects.toMatchObject({
      code: "INTERNAL",
      message: "payout_items_history_requires_top_level_client",
    });
  });

  test("a read that outruns its statement budget degrades to SERVICE_UNAVAILABLE, not a hang", async () => {
    await insertPayout({ id: "po_1", scheduledFor: T("2026-09-08T05:00:00.000Z") });
    await insertItem({
      id: "pi_1",
      payoutId: "po_1",
      transferredAt: T("2026-09-08T06:00:00.000Z"),
    });

    // Slow FOR REAL, inside the read's own transaction and after its SET
    // LOCAL, so Postgres cancels with 57014 exactly as it would on a
    // pathological history. A bare 1ms budget was tried first and flaked:
    // this query sometimes finishes inside 1ms, so the assertion passed
    // for the wrong reason.
    __testOnlyPayoutHistoryHooks.beforeQuery = async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_sleep(2)`);
    };

    const err = await repo.listHistory({ statementTimeoutMs: 200 }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "payout_items_history_timeout",
    });
  }, 60_000);

  // ── Payee narrowing (the organiser-facing slice) ──────────────────────────
  //
  // The organiser "Payouts sent" view is THIS read narrowed to the org's own
  // payee — the same statement, never a second one. The unit tests in
  // payout-items.test.ts assert the bytes; these assert the rows, and above
  // all that the narrowing reaches `total` and the cursor rather than just
  // the visible page.

  test("payeeIds narrows the page, the total AND the cursor to that payee", async () => {
    await insertPayout({ id: "po_1", scheduledFor: T("2026-09-08T05:00:00.000Z") });
    // A payee gets AT MOST ONE item per (payout, currency) — `PayoutItem` is
    // unique on ("payoutId","payeeId",currency). Two rows for one payee means
    // two payout batches, which is also what an organiser's history really is.
    await insertPayout({ id: "po_2", scheduledFor: T("2026-09-08T05:30:00.000Z") });
    await insertItem({
      id: "pi_mine_1",
      payoutId: "po_1",
      transferredAt: T("2026-09-08T06:00:00.000Z"),
    });
    await insertItem({
      id: "pi_mine_2",
      payoutId: "po_2",
      transferredAt: T("2026-09-08T07:00:00.000Z"),
    });
    await insertItem({
      id: "pi_theirs",
      payoutId: "po_1",
      payeeId: HUMAN_PAYEE,
      transferredAt: T("2026-09-08T08:00:00.000Z"),
    });

    const all = await repo.listHistory({});
    expect(all.total).toBe(3);

    const mine = await repo.listHistory({ payeeIds: [ORG_PAYEE] });
    expect(mine.items.map((r) => r.id)).toEqual(["pi_mine_2", "pi_mine_1"]);
    // The filter must live in `base`, above COUNT(*) OVER (): a `total` of 3
    // here would print the PLATFORM's payout count on one organiser's page.
    expect(mine.total).toBe(2);

    // And the keyset pages the FILTERED set — the other payee's row must not
    // reappear on page two.
    const first = await repo.listHistory({ payeeIds: [ORG_PAYEE], limit: 1 });
    expect(first.items.map((r) => r.id)).toEqual(["pi_mine_2"]);
    expect(first.total).toBe(2);
    expect(first.pageInfo.hasNextPage).toBe(true);
    const second = await repo.listHistory({
      payeeIds: [ORG_PAYEE],
      limit: 1,
      cursor: first.pageInfo.nextCursor,
    });
    expect(second.items.map((r) => r.id)).toEqual(["pi_mine_1"]);
    expect(second.pageInfo.hasNextPage).toBe(false);
  });

  test("an EXPLICIT empty payeeIds returns NO rows — never the whole platform", async () => {
    // The failure mode: an org with no Payee row yet passes `[]`, and a
    // coalesce-to-undefined bug shows them every payout on the platform.
    await insertPayout({ id: "po_1", scheduledFor: T("2026-09-08T05:00:00.000Z") });
    await insertItem({
      id: "pi_1",
      payoutId: "po_1",
      transferredAt: T("2026-09-08T06:00:00.000Z"),
    });

    const none = await repo.listHistory({ payeeIds: [] });
    expect(none.items).toEqual([]);
    expect(none.total).toBe(0);
    expect(none.pageInfo.nextCursor).toBeNull();

    // Omitted is the OPPOSITE — the full staff read.
    expect((await repo.listHistory({ payeeIds: undefined })).total).toBe(1);
  });

  test("payeeIds ANDs with status rather than replacing it", async () => {
    await insertPayout({ id: "po_1", scheduledFor: T("2026-09-08T05:00:00.000Z") });
    // Second batch: one payee cannot hold two items in one payout (unique on
    // "payoutId","payeeId",currency), so its succeeded and failed rows are
    // necessarily from different runs.
    await insertPayout({ id: "po_2", scheduledFor: T("2026-09-08T05:30:00.000Z") });
    await insertItem({
      id: "pi_mine_ok",
      payoutId: "po_1",
      status: "transferred",
      transferredAt: T("2026-09-08T06:00:00.000Z"),
    });
    await insertItem({
      id: "pi_mine_failed",
      payoutId: "po_2",
      status: "failed",
      failedAt: T("2026-09-08T07:00:00.000Z"),
      failureReason: "insufficient_funds",
    });
    await insertItem({
      id: "pi_theirs_failed",
      payoutId: "po_1",
      payeeId: HUMAN_PAYEE,
      status: "failed",
      failedAt: T("2026-09-08T08:00:00.000Z"),
      failureReason: "insufficient_funds",
    });

    const page = await repo.listHistory({
      payeeIds: [ORG_PAYEE],
      status: "failed",
    });
    expect(page.items.map((r) => r.id)).toEqual(["pi_mine_failed"]);
    expect(page.total).toBe(1);
  });
});
