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

import { makeCreditsRepo } from "../credits";

// ---------------------------------------------------------------------------
// `releaseForOrder` — giving a dead PENDING order's platform credit back.
//
// Checkout SPENDS credit (`redeemConditional` is a real `balanceCents -= n`,
// REDEEMED at zero, plus a `UserCreditRedemption` row on the order). Every
// other reservation a cart takes has a release path; credit had none, so a
// card decline followed by a retry silently burned a staff-granted goodwill
// credit. This is the release, and it is one CTE with `FOR UPDATE` and a
// `releasedAt IS NULL` replay guard — none of which is provable against a
// mocked client.
//
// THE MIGRATION SQL IS READ FROM DISK. `releasedAt` is added by the exact
// bytes that will run on prod.
// ---------------------------------------------------------------------------

const MIGRATION_SQL = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../db/prisma/migrations/20260908120000_user_credit_redemption_released_at/migration.sql",
  ),
  "utf8",
);

/**
 * The two credit tables with Prisma's default mapping, copied from
 * `20260601020000_user_credit`. `UserCreditRedemption` is created WITHOUT
 * `releasedAt` on purpose — the migration under test adds it. Foreign keys to
 * Human / Order are omitted: the release never touches those tables.
 */
const TABLE_SQL = `
CREATE TYPE "UserCreditStatus" AS ENUM ('ACTIVE', 'REDEEMED', 'EXPIRED', 'REVOKED');
CREATE TYPE "UserCreditSourceType" AS ENUM ('SIGNUP_BONUS', 'REFERRAL', 'REFUND_GOODWILL', 'PLATFORM_CAMPAIGN', 'PARTNER_SPIFF', 'MANUAL_STAFF_GRANT');

CREATE TABLE "UserCredit" (
    "id" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
    "balanceCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceType" "UserCreditSourceType" NOT NULL,
    "grantedByHumanId" TEXT,
    "sourceRef" TEXT,
    "status" "UserCreditStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserCredit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserCreditRedemption" (
    "id" TEXT NOT NULL,
    "creditId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refundedAt" TIMESTAMP(3),
    CONSTRAINT "UserCreditRedemption_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserCreditRedemption_orderId_idx" ON "UserCreditRedemption"("orderId");
CREATE UNIQUE INDEX "UserCreditRedemption_creditId_orderId_key" ON "UserCreditRedemption"("creditId", "orderId");
ALTER TABLE "UserCreditRedemption" ADD CONSTRAINT "UserCreditRedemption_creditId_fkey" FOREIGN KEY ("creditId") REFERENCES "UserCredit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
`;

const HUMAN_ID = "human-1";
const ORDER_A = "order-a";
const ORDER_B = "order-b";

type CreditRow = {
  id: string;
  balanceCents: number;
  status: string;
  expiresAt: Date | null;
};

type RedemptionRow = {
  creditId: string;
  orderId: string;
  amountCents: number;
  releasedAt: Date | null;
  refundedAt: Date | null;
};

describe("releaseForOrder (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(TABLE_SQL);
    await pool.query(MIGRATION_SQL);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 300_000);

  beforeEach(async () => {
    await pool!.query(`TRUNCATE "UserCreditRedemption", "UserCredit" CASCADE`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  const repo = () => makeCreditsRepo(prisma!);

  async function seedCredit(input: {
    id: string;
    amountCents: number;
    expiresAt?: Date | null;
  }) {
    await pool!.query(
      `INSERT INTO "UserCredit"
         ("id","humanId","amountCents","balanceCents","reason","sourceType",
          "status","expiresAt","updatedAt")
       VALUES ($1,$2,$3,$3,'goodwill','MANUAL_STAFF_GRANT','ACTIVE',$4,NOW())`,
      [input.id, HUMAN_ID, input.amountCents, input.expiresAt ?? null],
    );
  }

  /** Exactly what `applyAvailableCredits` does at checkout, via the adapter. */
  async function spend(creditId: string, orderId: string, cents: number) {
    const debit = await repo().redeemConditional({
      creditId,
      requestedCents: cents,
    });
    expect(debit.appliedCents).toBe(cents);
    await repo().recordRedemption({
      creditId,
      orderId,
      amountCents: debit.appliedCents,
    });
  }

  async function credit(id: string): Promise<CreditRow> {
    const { rows } = await pool!.query(
      `SELECT "id","balanceCents","status","expiresAt" FROM "UserCredit" WHERE "id" = $1`,
      [id],
    );
    return rows[0] as CreditRow;
  }

  async function redemption(
    creditId: string,
    orderId: string,
  ): Promise<RedemptionRow> {
    const { rows } = await pool!.query(
      `SELECT "creditId","orderId","amountCents","releasedAt","refundedAt"
       FROM "UserCreditRedemption" WHERE "creditId" = $1 AND "orderId" = $2`,
      [creditId, orderId],
    );
    return rows[0] as RedemptionRow;
  }

  test("redeem 2000 then release: balance back, ACTIVE again, redemption marked released", async () => {
    await seedCredit({ id: "c-1", amountCents: 2000 });
    await spend("c-1", ORDER_A, 2000);

    // The state the bug leaves behind: spent to zero, REDEEMED.
    expect(await credit("c-1")).toMatchObject({
      balanceCents: 0,
      status: "REDEEMED",
    });

    const result = await repo().releaseForOrder(ORDER_A);

    expect(result).toEqual({ releasedCents: 2000, creditIds: ["c-1"] });
    expect(await credit("c-1")).toMatchObject({
      balanceCents: 2000,
      status: "ACTIVE",
    });
    const row = await redemption("c-1", ORDER_A);
    expect(row.releasedAt).toBeInstanceOf(Date);
    expect(row.refundedAt).toBeNull();

    // And it is spendable again, by the predicate checkout actually uses.
    const active = await repo().listActiveForHuman({
      humanId: HUMAN_ID,
      currency: "usd",
    });
    expect(active.map((c) => c.id)).toEqual(["c-1"]);
  });

  test("a second release is a no-op: nothing restored twice", async () => {
    await seedCredit({ id: "c-1", amountCents: 2000 });
    await spend("c-1", ORDER_A, 2000);

    const first = await repo().releaseForOrder(ORDER_A);
    const second = await repo().releaseForOrder(ORDER_A);

    expect(first.releasedCents).toBe(2000);
    expect(second).toEqual({ releasedCents: 0, creditIds: [] });
    expect((await credit("c-1")).balanceCents).toBe(2000);
  });

  test("an order with no redemptions releases nothing", async () => {
    await seedCredit({ id: "c-1", amountCents: 2000 });

    expect(await repo().releaseForOrder("order-unknown")).toEqual({
      releasedCents: 0,
      creditIds: [],
    });
    expect((await credit("c-1")).balanceCents).toBe(2000);
  });

  test("two credits on one order are both restored, and only that order's", async () => {
    // FIFO against expiry drains c-1 completely and takes 1500 of c-2.
    await seedCredit({ id: "c-1", amountCents: 500 });
    await seedCredit({ id: "c-2", amountCents: 3000 });
    await spend("c-1", ORDER_A, 500);
    await spend("c-2", ORDER_A, 1500);
    // A different order's redemption on the same credit must be left alone.
    await spend("c-2", ORDER_B, 1000);

    const result = await repo().releaseForOrder(ORDER_A);

    expect(result.releasedCents).toBe(2000);
    expect([...result.creditIds].sort()).toEqual(["c-1", "c-2"]);
    expect(await credit("c-1")).toMatchObject({
      balanceCents: 500,
      status: "ACTIVE",
    });
    // 3000 - 1500 - 1000 = 500, + 1500 released = 2000. Order B still spent.
    expect(await credit("c-2")).toMatchObject({
      balanceCents: 2000,
      status: "ACTIVE",
    });
    expect((await redemption("c-2", ORDER_B)).releasedAt).toBeNull();
  });

  test("a credit that expired while it was spent gets its balance back but is NOT spendable", async () => {
    // Mirrors `listActiveForHuman`: spendable = ACTIVE AND balance > 0 AND
    // (expiresAt IS NULL OR expiresAt > now). Restoring the cents keeps the
    // ledger honest; the status follows the expiry rather than blindly
    // resurrecting a credit whose window has closed. `now` is the CALLER's
    // clock, bound as a parameter, so this matches the JS-Date comparison
    // the read side makes.
    const expiresAt = new Date("2026-03-01T00:00:00.000Z");
    await seedCredit({ id: "c-1", amountCents: 2000, expiresAt });
    await spend("c-1", ORDER_A, 2000);

    const result = await repo().releaseForOrder(ORDER_A, {
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(result).toEqual({ releasedCents: 2000, creditIds: ["c-1"] });
    expect(await credit("c-1")).toMatchObject({
      balanceCents: 2000,
      status: "EXPIRED",
    });
    const active = await repo().listActiveForHuman({
      humanId: HUMAN_ID,
      currency: "usd",
    });
    expect(active).toEqual([]);
  });

  test("the caller's clock, not the server's, decides whether the window has closed", async () => {
    // Same credit, released by a caller whose clock sits BEFORE expiry: the
    // credit is ACTIVE again even though the database's own NOW() is past
    // the window. This is what makes the release consistent with a use case
    // that reads `deps.clock.now()` everywhere else.
    const expiresAt = new Date("2026-03-01T00:00:00.000Z");
    await seedCredit({ id: "c-1", amountCents: 2000, expiresAt });
    await spend("c-1", ORDER_A, 2000);

    const result = await repo().releaseForOrder(ORDER_A, {
      now: new Date("2026-02-01T00:00:00.000Z"),
    });

    expect(result).toEqual({ releasedCents: 2000, creditIds: ["c-1"] });
    expect(await credit("c-1")).toMatchObject({
      balanceCents: 2000,
      status: "ACTIVE",
    });
  });

  test("a redemption already reversed by a refund is not restored again", async () => {
    await seedCredit({ id: "c-1", amountCents: 2000 });
    await spend("c-1", ORDER_A, 2000);
    // Simulate the refund path having already given the cents back.
    await pool!.query(
      `UPDATE "UserCreditRedemption" SET "refundedAt" = NOW() WHERE "orderId" = $1`,
      [ORDER_A],
    );
    await pool!.query(
      `UPDATE "UserCredit" SET "balanceCents" = 2000, "status" = 'ACTIVE' WHERE "id" = 'c-1'`,
    );

    expect(await repo().releaseForOrder(ORDER_A)).toEqual({
      releasedCents: 0,
      creditIds: [],
    });
    expect((await credit("c-1")).balanceCents).toBe(2000);
  });

  test("a REVOKED credit gets its cents back on the ledger but stays REVOKED", async () => {
    await seedCredit({ id: "c-1", amountCents: 2000 });
    await spend("c-1", ORDER_A, 2000);
    await pool!.query(
      `UPDATE "UserCredit" SET "status" = 'REVOKED' WHERE "id" = 'c-1'`,
    );

    const result = await repo().releaseForOrder(ORDER_A);

    expect(result.releasedCents).toBe(2000);
    expect(await credit("c-1")).toMatchObject({
      balanceCents: 2000,
      status: "REVOKED",
    });
  });

  test("two concurrent releases of the same order restore the cents exactly once", async () => {
    // The reaper and a buyer-initiated release can race on the same cart.
    // FOR UPDATE serialises them; the loser re-evaluates `releasedAt IS NULL`
    // against the winner's committed row and finds nothing to do.
    await seedCredit({ id: "c-1", amountCents: 2000 });
    await spend("c-1", ORDER_A, 2000);

    const release = () =>
      prisma!.$transaction(
        async (tx) => {
          const r = await makeCreditsRepo(tx).releaseForOrder(ORDER_A);
          // Hold the lock long enough for the other side to queue behind it.
          await new Promise((resolve) => setTimeout(resolve, 150));
          return r;
        },
        { timeout: 10_000 },
      );

    const [a, b] = await Promise.all([release(), release()]);

    expect(a.releasedCents + b.releasedCents).toBe(2000);
    expect([a.creditIds.length, b.creditIds.length].sort()).toEqual([0, 1]);
    expect(await credit("c-1")).toMatchObject({
      balanceCents: 2000,
      status: "ACTIVE",
    });
  });
});
