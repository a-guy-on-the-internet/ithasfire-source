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
// `updatePendingItems` re-prices a cart. Its write is a compare-and-set on
// the cart state `updateOrderItems` accepts (PENDING, no PaymentIntent, no
// terms acceptance): a re-price that lands after finalize must not rewrite
// the paid order's amounts or `feePolicySnapshot`, which decides the
// organiser credit. Every case here is one the guard refuses, so the adapter
// returns before the items swap and only the Order columns the guarded UPDATE
// touches are needed (house precedent: orders-link-cancel-cas).
// ---------------------------------------------------------------------------

const TABLE_SQL = `
CREATE TYPE "OrderStatus" AS ENUM (
  'PENDING', 'PROCESSING', 'SUCCEEDED', 'PART_REFUNDED',
  'REFUNDED', 'DISPUTED', 'CANCELLED'
);

-- Every scalar column the model declares: the final \`order.update\` reads them
-- all back. Enum-typed columns other than status are TEXT here (they are only
-- read, never written, by the adapter), and no foreign keys except the one
-- the item replace needs.
CREATE TABLE "Order" (
  "id"                    TEXT NOT NULL,
  "shortId"               TEXT,
  "eventId"               TEXT,
  "kind"                  TEXT NOT NULL DEFAULT 'TICKETING',
  "buyerHumanId"          TEXT NOT NULL DEFAULT 'h-1',
  "amountGrossCents"      INTEGER NOT NULL DEFAULT 1000,
  "feesPlatformCents"     INTEGER NOT NULL DEFAULT 50,
  "taxAmountCents"        INTEGER NOT NULL DEFAULT 0,
  "currency"              VARCHAR(3) NOT NULL DEFAULT 'USD',
  "processorFeeCents"     INTEGER,
  "processorFeeReadFailures" INTEGER NOT NULL DEFAULT 0,
  "processorFeeReadFailedAt" TIMESTAMP(3),
  "status"                "OrderStatus" NOT NULL DEFAULT 'PENDING',
  "feePolicySnapshot"     JSONB NOT NULL DEFAULT '{"organiserCredit":"FULL_PRICE"}',
  "occurredAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "stripePaymentIntentId" TEXT,
  "stripeInvoiceId"       VARCHAR(255),
  "parentOrderId"         TEXT,
  "source"                TEXT NOT NULL DEFAULT 'PRIMARY',
  "nonRefundable"         BOOLEAN NOT NULL DEFAULT false,
  "compReason"            VARCHAR(500),
  "compIssuedByHumanId"   TEXT,
  "paymentChannel"        TEXT NOT NULL DEFAULT 'WEB',
  "paymentMethodType"     VARCHAR(32),
  "paymentCardChecks"     JSONB,
  "billingDescriptor"     VARCHAR(22),
  "billingAddressLine1"   TEXT,
  "billingAddressLine2"   TEXT,
  "billingCity"           TEXT,
  "billingState"          TEXT,
  "billingPostalCode"     TEXT,
  "billingCountry"        VARCHAR(2),
  "termsVersion"          TEXT,
  "termsAcceptedAt"       TIMESTAMP(3),
  "refundPolicyAckAt"     TIMESTAMP(3),
  "refundPolicyAckIp"     VARCHAR(128),
  "refundPolicyVersion"   VARCHAR(64),
  "refundPolicyText"      TEXT,
  "disputedAt"            TIMESTAMP(3),
  "disputeStatus"         TEXT,
  "checkoutIp"            VARCHAR(128),
  "stripeTaxCalculationId" TEXT,
  "taxSitusCountry"       VARCHAR(2),
  "taxSitusState"         TEXT,
  "taxSitusPostal"        TEXT,
  "taxRateSource"         TEXT,
  "paidOutAt"             TIMESTAMP(3),
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Order_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Order_stripePaymentIntentId_key" UNIQUE ("stripePaymentIntentId")
);

CREATE TABLE "OrderItem" (
  "id"                    TEXT NOT NULL,
  "orderId"               TEXT NOT NULL,
  "kind"                  TEXT NOT NULL,
  "ticketTypeId"          TEXT,
  "membershipId"          TEXT,
  "label"                 VARCHAR(64),
  "qty"                   INTEGER NOT NULL DEFAULT 1,
  "unitPriceCents"        INTEGER NOT NULL,
  "amountCents"           INTEGER NOT NULL,
  "meta"                  JSONB NOT NULL DEFAULT '{}',
  "resaleListingId"       TEXT,
  "resaleFaceValueCents"  INTEGER,
  "resaleProcessingPassThroughCents" INTEGER NOT NULL DEFAULT 0,
  "resaleProcessingFeeConfigRef" TEXT,
  "resaleSaleCutoffAt"    TIMESTAMP(3),
  "resalePayoutReleaseAt" TIMESTAMP(3),
  "resalePayoutStatus"    TEXT,
  "resalePayoutHeldAt"    TIMESTAMP(3),
  "resalePayoutHoldReason" TEXT,
  "resalePayoutNoticeSentAt" TIMESTAMP(3),
  "resalePayoutReminderSentAt" TIMESTAMP(3),
  "resalePayoutFinalNoticeSentAt" TIMESTAMP(3),
  "paidOutAt"             TIMESTAMP(3),
  "refundedAt"            TIMESTAMP(3),
  "refundedTaxCents"      INTEGER,
  "refundedPlatformFeeCents" INTEGER,
  "transferredAt"         TIMESTAMP(3),
  "status"                TEXT NOT NULL DEFAULT 'active',
  "eventShareCents"       INTEGER,
  "originalUnitPriceCents" INTEGER,
  "resaleClauseBps"       INTEGER,
  "resaleClauseCents"     INTEGER,
  "resaleClausePayer"     TEXT,
  "resaleClauseTermsId"   TEXT,
  "resaleClauseTermsVersion" INTEGER,
  "resaleClauseType"      TEXT,
  "sharePayer"            TEXT,
  CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId")
    REFERENCES "Order"("id") ON DELETE CASCADE
);
`;

const REPRICE = {
  amountGrossCents: 9999,
  feesPlatformCents: 777,
  currency: "CAD",
  feePolicySnapshot: { organiserCredit: "FULL_PRICE", rewritten: true },
  items: [
    {
      kind: "TICKET" as const,
      ticketTypeId: "tt-1",
      qty: 9,
      unitPriceCents: 1111,
      amountCents: 9999,
    },
  ],
};

const UNTOUCHED = {
  amountGrossCents: 1000,
  feesPlatformCents: 50,
  currency: "USD",
  feePolicySnapshot: { organiserCredit: "FULL_PRICE" },
};

describe("orders.updatePendingItems CAS (integration, real Postgres)", () => {
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
    await pool!.query(`TRUNCATE "Order" CASCADE`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  const insert = (
    id: string,
    cols: {
      status?: string;
      stripePaymentIntentId?: string | null;
      termsAcceptedAt?: Date | null;
    } = {},
  ) =>
    pool!.query(
      `INSERT INTO "Order" ("id", "status", "stripePaymentIntentId", "termsAcceptedAt")
       VALUES ($1, $2::"OrderStatus", $3, $4)`,
      [
        id,
        cols.status ?? "PENDING",
        cols.stripePaymentIntentId ?? null,
        cols.termsAcceptedAt ?? null,
      ],
    );

  const money = async (id: string) =>
    (
      await pool!.query<typeof UNTOUCHED>(
        `SELECT "amountGrossCents", "feesPlatformCents", "currency", "feePolicySnapshot"
         FROM "Order" WHERE "id" = $1`,
        [id],
      )
    ).rows[0];

  test.each(["SUCCEEDED", "PROCESSING", "CANCELLED", "REFUNDED"])(
    "a %s order is not rewritten and the call returns null",
    async (status) => {
      await insert("o-status", { status });

      const result = await orders.updatePendingItems({
        orderId: "o-status",
        ...REPRICE,
      });

      expect(result).toBeNull();
      expect(await money("o-status")).toEqual(UNTOUCHED);
    },
  );

  test("a PENDING order checkout has claimed (PaymentIntent linked) is not rewritten", async () => {
    await insert("o-pi", { stripePaymentIntentId: "pi_1" });

    const result = await orders.updatePendingItems({
      orderId: "o-pi",
      ...REPRICE,
    });

    expect(result).toBeNull();
    expect(await money("o-pi")).toEqual(UNTOUCHED);
  });

  test("a PENDING checkout order (terms accepted, PI not linked yet) is not rewritten", async () => {
    await insert("o-terms", { termsAcceptedAt: new Date() });

    const result = await orders.updatePendingItems({
      orderId: "o-terms",
      ...REPRICE,
    });

    expect(result).toBeNull();
    expect(await money("o-terms")).toEqual(UNTOUCHED);
  });

  test("a missing order returns null", async () => {
    expect(
      await orders.updatePendingItems({ orderId: "nope", ...REPRICE }),
    ).toBeNull();
  });

  const seedItems = (orderId: string) =>
    pool!.query(
      `INSERT INTO "OrderItem" ("id", "orderId", "kind", "qty", "unitPriceCents", "amountCents")
       VALUES ($1, $2, 'TICKET', 1, 500, 500), ($3, $2, 'TICKET', 1, 500, 500)`,
      [`${orderId}-old-1`, orderId, `${orderId}-old-2`],
    );

  const dbItems = async (orderId: string) =>
    (
      await pool!.query<{ id: string; qty: number; amountCents: number }>(
        `SELECT "id", "qty", "amountCents" FROM "OrderItem" WHERE "orderId" = $1`,
        [orderId],
      )
    ).rows;

  const expectRepriced = async (
    orderId: string,
    result: Awaited<ReturnType<typeof orders.updatePendingItems>>,
  ) => {
    expect(result).not.toBeNull();
    expect(result!.amountGrossCents).toBe(9999);
    expect(result!.feesPlatformCents).toBe(777);
    expect(result!.currency).toBe("CAD");
    expect(result!.items).toHaveLength(1);
    expect(result!.items[0]).toMatchObject({
      orderId,
      ticketTypeId: "tt-1",
      qty: 9,
      amountCents: 9999,
    });
    expect(result!.items.map((i) => i.id)).not.toContain(`${orderId}-old-1`);
    expect(result!.feePolicySnapshot).toMatchObject({
      organiserCredit: "FULL_PRICE",
      rewritten: true,
    });

    // Re-read from the database, not the returned record.
    expect(await money(orderId)).toEqual({
      amountGrossCents: 9999,
      feesPlatformCents: 777,
      currency: "CAD",
      feePolicySnapshot: REPRICE.feePolicySnapshot,
    });
    const rows = await dbItems(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ qty: 9, amountCents: 9999 });
    expect(rows[0]!.id).not.toMatch(/-old-/);
  };

  test("a PENDING unclaimed cart is re-priced and its items replaced (root client)", async () => {
    await insert("o-ok");
    await seedItems("o-ok");

    const result = await orders.updatePendingItems({
      orderId: "o-ok",
      ...REPRICE,
    });

    await expectRepriced("o-ok", result);
  });

  test("the same re-price works on a transaction client (no nested $transaction)", async () => {
    await insert("o-tx");
    await seedItems("o-tx");

    const result = await prisma!.$transaction((tx) =>
      makeOrdersRepo(tx).updatePendingItems({ orderId: "o-tx", ...REPRICE }),
    );

    await expectRepriced("o-tx", result);
  });

  test("a refused re-price leaves the existing items in place", async () => {
    await insert("o-keep", { status: "SUCCEEDED" });
    await seedItems("o-keep");

    expect(
      await orders.updatePendingItems({ orderId: "o-keep", ...REPRICE }),
    ).toBeNull();
    expect((await dbItems("o-keep")).map((r) => r.id).sort()).toEqual([
      "o-keep-old-1",
      "o-keep-old-2",
    ]);
  });

  test("finalize commits first → the blocked re-price re-evaluates and matches nothing", async () => {
    await insert("o-race");

    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    let finalized!: () => void;
    const finalizedApplied = new Promise<void>((r) => {
      finalized = r;
    });

    // Finalize holds the row lock in an open transaction.
    const finalizeTx = prisma!.$transaction(
      async (tx) => {
        const ok = await makeOrdersRepo(tx).markSucceededIfOpen("o-race");
        finalized();
        await released;
        return ok;
      },
      { timeout: 20_000 },
    );
    await finalizedApplied;

    let repriceDone = false;
    const reprice = orders
      .updatePendingItems({ orderId: "o-race", ...REPRICE })
      .then((r) => {
        repriceDone = true;
        return r;
      });
    await new Promise((r) => setTimeout(r, 300));
    expect(repriceDone).toBe(false);

    release();
    const [didFinalize, repriced] = await Promise.all([finalizeTx, reprice]);

    expect(didFinalize).toBe(true);
    expect(repriced).toBeNull();
    expect(await money("o-race")).toEqual(UNTOUCHED);
  });
});
