import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeOrdersRepo } from "../orders";

// ---------------------------------------------------------------------------
// `listCashSalesForEvent` against real Postgres: the keyset cursor must walk
// an event's cash sales exactly once, newest first, including two sales
// recorded in the same millisecond (TIMESTAMP(3), as the real column), and
// the nested item / promo-code / ticket-count selects must run as one read.
//
// Only the columns the method touches (house precedent:
// orders-link-cancel-cas.integration.test.ts). That doubles as the PII
// check: the Order table here has NO buyer, billing or IP columns, so a
// select that reached for one would fail with "column does not exist".
// ---------------------------------------------------------------------------

const TABLE_SQL = `
CREATE TYPE "OrderStatus" AS ENUM (
  'PENDING', 'PROCESSING', 'SUCCEEDED', 'PART_REFUNDED',
  'REFUNDED', 'DISPUTED', 'CANCELLED'
);
CREATE TYPE "PaymentChannel" AS ENUM ('WEB', 'POS', 'CASH');

CREATE TABLE "Order" (
  "id"                TEXT NOT NULL,
  "eventId"           TEXT,
  "status"            "OrderStatus" NOT NULL DEFAULT 'PENDING',
  "paymentChannel"    "PaymentChannel" NOT NULL DEFAULT 'WEB',
  "occurredAt"        TIMESTAMP(3) NOT NULL,
  "amountGrossCents"  INTEGER NOT NULL,
  "feesPlatformCents" INTEGER NOT NULL DEFAULT 0,
  "taxAmountCents"    INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderItem" (
  "id"          TEXT NOT NULL,
  "orderId"     TEXT NOT NULL REFERENCES "Order"("id") ON DELETE CASCADE,
  "kind"        TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "meta"        JSONB NOT NULL DEFAULT '{}',
  "refundedAt"  TIMESTAMP(3),
  CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Ticket" (
  "id"      TEXT NOT NULL,
  "orderId" TEXT REFERENCES "Order"("id") ON DELETE SET NULL,
  CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CouponRedemption" (
  "id"         TEXT NOT NULL,
  "couponId"   TEXT,
  "orderId"    TEXT NOT NULL REFERENCES "Order"("id") ON DELETE CASCADE,
  "code"       TEXT NOT NULL,
  "redeemedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);
`;

const EVENT = "event-1";
const OTHER_EVENT = "event-2";
const base = Date.parse("2026-10-07T21:00:00.000Z");
const at = (minute: number) => new Date(base + minute * 60_000);
/**
 * Raw inserts pass ISO strings, not Dates: node-pg renders a Date in the
 * process's local zone, and TIMESTAMP(3) has no zone, so Prisma (which reads
 * it as UTC) would see it shifted. Postgres drops the `Z` on this cast.
 */
const iso = (d: Date) => d.toISOString();

describe("listCashSalesForEvent (integration, real Postgres)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let orders: ReturnType<typeof makeOrdersRepo>;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl, max: 4 });
    await pool.query(TABLE_SQL);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    orders = makeOrdersRepo(prisma);
  }, 300_000);

  beforeEach(async () => {
    await pool!.query(
      `TRUNCATE "CouponRedemption", "Ticket", "OrderItem", "Order"`,
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  async function insertOrder(o: {
    id: string;
    occurredAt: Date;
    eventId?: string;
    status?: string;
    channel?: string;
    gross?: number;
    tax?: number;
    tickets?: number;
  }) {
    await pool!.query(
      `INSERT INTO "Order" ("id", "eventId", "status", "paymentChannel", "occurredAt", "amountGrossCents", "taxAmountCents")
       VALUES ($1, $2, $3::"OrderStatus", $4::"PaymentChannel", $5, $6, $7)`,
      [
        o.id,
        o.eventId ?? EVENT,
        o.status ?? "SUCCEEDED",
        o.channel ?? "CASH",
        iso(o.occurredAt),
        o.gross ?? 2500,
        o.tax ?? 0,
      ],
    );
    for (let i = 0; i < (o.tickets ?? 1); i++) {
      await pool!.query(`INSERT INTO "Ticket" ("id", "orderId") VALUES ($1, $2)`, [
        `${o.id}-t${i}`,
        o.id,
      ]);
    }
  }

  test("walks every cash sale of the event once, newest first, across a same-millisecond tie", async () => {
    await insertOrder({ id: "o-a", occurredAt: at(1) });
    await insertOrder({ id: "o-b", occurredAt: at(2) });
    await insertOrder({ id: "o-c", occurredAt: at(3) });
    await insertOrder({ id: "o-d", occurredAt: at(3) });
    await insertOrder({ id: "o-e", occurredAt: at(4), status: "REFUNDED" });
    // Never listed: a rolled-back attempt, a card sale, another event.
    await insertOrder({ id: "o-pending", occurredAt: at(5), status: "PENDING" });
    await insertOrder({ id: "o-card", occurredAt: at(5), channel: "POS" });
    await insertOrder({ id: "o-other", occurredAt: at(5), eventId: OTHER_EVENT });

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await orders.listCashSalesForEvent({
        eventId: EVENT,
        cursor,
        limit: 2,
      });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((r) => r.orderId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(seen).toEqual(["o-e", "o-d", "o-c", "o-b", "o-a"]);
    expect(pages).toBe(3);
  });

  test("returns the money columns, every item, the ticket count and typed codes in redemption order", async () => {
    await insertOrder({ id: "o-1", occurredAt: at(1), gross: 4500, tax: 439, tickets: 2 });
    await pool!.query(
      `INSERT INTO "OrderItem" ("id", "orderId", "kind", "amountCents", "meta", "refundedAt") VALUES
       ('i-1', 'o-1', 'ticket', 2500, '{"buyerTotalCents":2500}', $1),
       ('i-2', 'o-1', 'ticket', 2500, '{"buyerTotalCents":2500}', $1),
       ('i-3', 'o-1', 'discount', -500, '{"code":"save5"}', NULL)`,
      [iso(at(9))],
    );
    await pool!.query(
      `INSERT INTO "CouponRedemption" ("id", "couponId", "orderId", "code", "redeemedAt") VALUES
       ('r-2', 'promo-2', 'o-1', 'LATER', $2),
       ('r-1', 'promo-1', 'o-1', 'SAVE5', $1),
       ('r-3', NULL, 'o-1', 'benefit:abc', $1)`,
      [iso(at(1)), iso(at(2))],
    );

    const page = await orders.listCashSalesForEvent({
      eventId: EVENT,
      cursor: null,
      limit: 25,
    });

    expect(page).toEqual({
      items: [
        {
          orderId: "o-1",
          status: "SUCCEEDED",
          occurredAt: at(1),
          amountGrossCents: 4500,
          feesPlatformCents: 0,
          taxAmountCents: 439,
          ticketCount: 2,
          items: [
            { kind: "ticket", amountCents: 2500, meta: { buyerTotalCents: 2500 }, refundedAt: at(9) },
            { kind: "ticket", amountCents: 2500, meta: { buyerTotalCents: 2500 }, refundedAt: at(9) },
            { kind: "discount", amountCents: -500, meta: { code: "save5" }, refundedAt: null },
          ],
          // The membership benefit's internal marker is not a code.
          promoCodes: ["SAVE5", "LATER"],
        },
      ],
      nextCursor: null,
    });
  });
});
