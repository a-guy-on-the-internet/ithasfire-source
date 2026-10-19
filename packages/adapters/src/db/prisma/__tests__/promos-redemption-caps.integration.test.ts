import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makePromosRepo } from "../promos";

// ---------------------------------------------------------------------------
// Promo caps against REAL Postgres (money audit 2026-09-08 #8).
//
// What only a real database can prove here:
//   * the stats SQL — a UNION of two ledgers with an anti-join, an enum
//     `::text` compare, a `timestamp(3)` bound from a JS Date, and a
//     `COUNT(*) FILTER` against a possibly-NULL bound human;
//   * that `pg_advisory_xact_lock` actually serialises two concurrent
//     `$transaction` callbacks so the second one COUNTS the first one's hold
//     and rejects, instead of both passing a cap of 1.
//
// Tables are created with Prisma's default naming for exactly the columns
// and constraints the adapter touches (the `@@map`ped Coupon* names, the
// `source_xor` CHECK, the per-source uniques). `Order` is the two columns
// the hold leg's open-cart EXISTS reads (`id`, `status`) with the REAL
// `OrderStatus` members, so the enum `::text IN (...)` compare runs against
// Postgres. FKs to Order / Human / MembershipBenefit are omitted — nothing
// under test reads through them, and holds on a missing order are a case.
//
// SEEDS PASS TIMESTAMPS AS ISO STRINGS, NOT `Date`s. node-pg serialises a
// Date as LOCAL wall-clock with an offset, and a `TIMESTAMP(3)` (no tz)
// column discards the offset — on a UTC-4 machine a 12:15Z hold lands as
// 08:15 and reads as expired against the adapter's UTC-bound `now`. Prisma
// binds Dates as UTC, so the adapter's own writes are unaffected; only the
// raw seeds need the literal.
// ---------------------------------------------------------------------------

const TABLE_SQL = `
CREATE TYPE "CouponKind"       AS ENUM ('PERCENT', 'AMOUNT');
CREATE TYPE "CouponScope"      AS ENUM ('GLOBAL', 'ORG', 'EVENT', 'TICKET_TYPE', 'HUMAN');
CREATE TYPE "CouponStatus"     AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "CouponHoldStatus" AS ENUM ('PENDING', 'CONFIRMED', 'RELEASED');
CREATE TYPE "OrderStatus"      AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'PART_REFUNDED', 'REFUNDED', 'DISPUTED', 'CANCELLED');

CREATE TABLE "Order" (
  "id"     TEXT NOT NULL,
  "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
  CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Coupon" (
  "id"                     TEXT NOT NULL,
  "code"                   TEXT NOT NULL,
  "codeNormalized"         TEXT NOT NULL,
  "kind"                   "CouponKind" NOT NULL,
  "value"                  INTEGER NOT NULL,
  "currency"               VARCHAR(3) NOT NULL DEFAULT 'usd',
  "scope"                  "CouponScope" NOT NULL,
  "scopeId"                TEXT,
  "startsAt"               TIMESTAMP(3),
  "endsAt"                 TIMESTAMP(3),
  "maxRedemptions"         INTEGER,
  "maxRedemptionsPerHuman" INTEGER,
  "minOrderCents"          INTEGER NOT NULL DEFAULT 0,
  "maxDiscountCents"       INTEGER,
  "stackable"              BOOLEAN NOT NULL DEFAULT false,
  "isPublic"               BOOLEAN NOT NULL DEFAULT false,
  "status"                 "CouponStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "coupon_code_normalized_unique" ON "Coupon"("codeNormalized");

CREATE TABLE "CouponRedemption" (
  "id"                  TEXT NOT NULL,
  "couponId"            TEXT,
  "membershipBenefitId" TEXT,
  "orderId"             TEXT NOT NULL,
  "humanId"             TEXT NOT NULL,
  "code"                TEXT NOT NULL,
  "amountDiscountCents" INTEGER NOT NULL,
  "redeemedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId")
    REFERENCES "Coupon"("id") ON DELETE CASCADE,
  CONSTRAINT "CouponRedemption_source_xor"
    CHECK (num_nonnulls("couponId", "membershipBenefitId") <= 1)
);
CREATE UNIQUE INDEX "CouponRedemption_couponId_orderId_key"
  ON "CouponRedemption"("couponId", "orderId");
CREATE UNIQUE INDEX "CouponRedemption_membershipBenefitId_orderId_key"
  ON "CouponRedemption"("membershipBenefitId", "orderId");
CREATE INDEX "CouponRedemption_couponId_humanId_idx"
  ON "CouponRedemption"("couponId", "humanId");

CREATE TABLE "CouponHold" (
  "id"                  TEXT NOT NULL,
  "couponId"            TEXT,
  "membershipBenefitId" TEXT,
  "orderId"             TEXT NOT NULL,
  "humanId"             TEXT NOT NULL,
  "idempotencyKey"      TEXT NOT NULL,
  "code"                TEXT NOT NULL,
  "amountDiscountCents" INTEGER NOT NULL,
  "status"              "CouponHoldStatus" NOT NULL DEFAULT 'PENDING',
  "expiresAt"           TIMESTAMP(3) NOT NULL,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CouponHold_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CouponHold_couponId_fkey" FOREIGN KEY ("couponId")
    REFERENCES "Coupon"("id") ON DELETE CASCADE,
  CONSTRAINT "CouponHold_source_xor"
    CHECK (num_nonnulls("couponId", "membershipBenefitId") = 1)
);
CREATE UNIQUE INDEX "CouponHold_couponId_idempotencyKey_key"
  ON "CouponHold"("couponId", "idempotencyKey");
CREATE UNIQUE INDEX "CouponHold_membershipBenefitId_idempotencyKey_key"
  ON "CouponHold"("membershipBenefitId", "idempotencyKey");
CREATE INDEX "CouponHold_orderId_idx"   ON "CouponHold"("orderId");
CREATE INDEX "CouponHold_expiresAt_idx" ON "CouponHold"("expiresAt");
`;

const PROMO_ID = "44444444-4444-4444-8444-444444444444";
const HUMAN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HUMAN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2026-09-08T12:00:00.000Z");
const LIVE_UNTIL = new Date("2026-09-08T12:15:00.000Z");
const DEAD_SINCE = new Date("2026-09-08T11:45:00.000Z");

describe("promo redemption caps (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(TABLE_SQL);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 300_000);

  beforeEach(async () => {
    await pool!.query(
      `TRUNCATE "CouponHold", "CouponRedemption", "Coupon", "Order" CASCADE`,
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  async function seedPromo(caps: {
    maxRedemptions?: number | null;
    maxRedemptionsPerHuman?: number | null;
  }) {
    await pool!.query(
      `INSERT INTO "Coupon"
         ("id","code","codeNormalized","kind","value","scope",
          "maxRedemptions","maxRedemptionsPerHuman","updatedAt")
       VALUES ($1,'flash10','FLASH10','AMOUNT',500,'GLOBAL',$2,$3,$4)`,
      [
        PROMO_ID,
        caps.maxRedemptions ?? null,
        caps.maxRedemptionsPerHuman ?? null,
        NOW.toISOString(),
      ],
    );
  }

  async function seedHold(hold: {
    id: string;
    orderId: string;
    humanId: string;
    status?: "PENDING" | "CONFIRMED" | "RELEASED";
    expiresAt?: Date;
  }) {
    await pool!.query(
      `INSERT INTO "CouponHold"
         ("id","couponId","orderId","humanId","idempotencyKey","code",
          "amountDiscountCents","status","expiresAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,'FLASH10',500,$6::"CouponHoldStatus",$7,$8)`,
      [
        hold.id,
        PROMO_ID,
        hold.orderId,
        hold.humanId,
        `order:${hold.orderId}:promo:${PROMO_ID}`,
        hold.status ?? "PENDING",
        (hold.expiresAt ?? LIVE_UNTIL).toISOString(),
        NOW.toISOString(),
      ],
    );
  }

  type OrderStatus =
    | "PENDING"
    | "PROCESSING"
    | "SUCCEEDED"
    | "PART_REFUNDED"
    | "REFUNDED"
    | "DISPUTED"
    | "CANCELLED";

  async function seedOrder(order: { id: string; status: OrderStatus }) {
    await pool!.query(
      `INSERT INTO "Order" ("id","status") VALUES ($1,$2::"OrderStatus")`,
      [order.id, order.status],
    );
  }

  async function seedRedemption(redemption: {
    id: string;
    orderId: string;
    humanId: string;
  }) {
    await pool!.query(
      `INSERT INTO "CouponRedemption"
         ("id","couponId","orderId","humanId","code","amountDiscountCents","redeemedAt")
       VALUES ($1,$2,$3,$4,'FLASH10',500,$5)`,
      [
        redemption.id,
        PROMO_ID,
        redemption.orderId,
        redemption.humanId,
        NOW.toISOString(),
      ],
    );
  }

  const stats = (humanId?: string, excludeOrderId?: string) =>
    makePromosRepo(prisma!).getRedemptionStats({
      promoId: PROMO_ID,
      humanId,
      now: NOW,
      excludeOrderId,
    });

  const holdInput = (orderId: string, humanId: string) => ({
    promoId: PROMO_ID,
    orderId,
    humanId,
    idempotencyKey: `order:${orderId}:promo:${PROMO_ID}`,
    code: "FLASH10",
    amountDiscountCents: 500,
    expiresAt: LIVE_UNTIL,
  });

  describe("getRedemptionStats", () => {
    test("a confirmed redemption AND a live pending hold both count", async () => {
      await seedPromo({ maxRedemptions: 10 });
      await seedRedemption({ id: "r-1", orderId: "o-paid", humanId: HUMAN_A });
      await seedHold({ id: "h-1", orderId: "o-pending", humanId: HUMAN_B });

      // BEFORE this change: 1 — the pending hold was invisible to the cap.
      expect(await stats(HUMAN_B)).toEqual({
        totalRedemptions: 2,
        redemptionsForHuman: 1,
      });
    });

    test("an EXPIRED pending hold does not count (caller's clock decides)", async () => {
      await seedPromo({ maxRedemptions: 10 });
      await seedHold({
        id: "h-dead",
        orderId: "o-dead",
        humanId: HUMAN_A,
        expiresAt: DEAD_SINCE,
      });

      expect(await stats(HUMAN_A)).toEqual({
        totalRedemptions: 0,
        redemptionsForHuman: 0,
      });
      // Same row, a clock 30 minutes earlier: now it IS live.
      const earlier = await makePromosRepo(prisma!).getRedemptionStats({
        promoId: PROMO_ID,
        humanId: HUMAN_A,
        now: new Date("2026-09-08T11:30:00.000Z"),
      });
      expect(earlier).toEqual({ totalRedemptions: 1, redemptionsForHuman: 1 });
    });

    // ── The cart's lifetime is the hold's authority ─────────────────────
    // Hold TTL is 15 min; the cart reaper's is 20 min and it only cancels on
    // its next pass. In that gap a PENDING cart with a live PaymentIntent
    // carries an EXPIRED hold that `confirmHoldsForOrder` will still confirm
    // when payment lands. Ignoring it let a second checkout take the last
    // slot on a cap of one — two redemptions.
    describe("an expired PENDING hold still counts while its order is open", () => {
      test("order PENDING → counts (total 1, forHuman 1)", async () => {
        await seedPromo({ maxRedemptions: 10 });
        await seedOrder({ id: "o-open", status: "PENDING" });
        await seedHold({
          id: "h-stale",
          orderId: "o-open",
          humanId: HUMAN_A,
          expiresAt: DEAD_SINCE,
        });

        expect(await stats(HUMAN_A)).toEqual({
          totalRedemptions: 1,
          redemptionsForHuman: 1,
        });
      });

      test("order PROCESSING (delayed-notification payment) → counts", async () => {
        await seedPromo({ maxRedemptions: 10 });
        await seedOrder({ id: "o-ach", status: "PROCESSING" });
        await seedHold({
          id: "h-stale",
          orderId: "o-ach",
          humanId: HUMAN_A,
          expiresAt: DEAD_SINCE,
        });

        expect(await stats(HUMAN_A)).toEqual({
          totalRedemptions: 1,
          redemptionsForHuman: 1,
        });
      });

      test("order CANCELLED → does NOT count", async () => {
        await seedPromo({ maxRedemptions: 10 });
        await seedOrder({ id: "o-cancelled", status: "CANCELLED" });
        await seedHold({
          id: "h-stale",
          orderId: "o-cancelled",
          humanId: HUMAN_A,
          expiresAt: DEAD_SINCE,
        });

        expect(await stats(HUMAN_A)).toEqual({
          totalRedemptions: 0,
          redemptionsForHuman: 0,
        });
      });

      test("no order row at all → does NOT count", async () => {
        await seedPromo({ maxRedemptions: 10 });
        await seedHold({
          id: "h-orphan",
          orderId: "o-missing",
          humanId: HUMAN_A,
          expiresAt: DEAD_SINCE,
        });

        expect(await stats(HUMAN_A)).toEqual({
          totalRedemptions: 0,
          redemptionsForHuman: 0,
        });
      });

      test("excludeOrderId still drops the buyer's OWN expired-but-open hold", async () => {
        await seedPromo({ maxRedemptionsPerHuman: 1 });
        await seedOrder({ id: "o-mine", status: "PENDING" });
        await seedHold({
          id: "h-mine",
          orderId: "o-mine",
          humanId: HUMAN_A,
          expiresAt: DEAD_SINCE,
        });

        expect(await stats(HUMAN_A)).toEqual({
          totalRedemptions: 1,
          redemptionsForHuman: 1,
        });
        expect(await stats(HUMAN_A, "o-mine")).toEqual({
          totalRedemptions: 0,
          redemptionsForHuman: 0,
        });
      });
    });

    test("RELEASED and CONFIRMED holds do not count as holds", async () => {
      await seedPromo({ maxRedemptions: 10 });
      await seedHold({ id: "h-rel", orderId: "o-rel", humanId: HUMAN_A, status: "RELEASED" });
      // CONFIRMED with no redemption row is a mid-confirm state; the
      // redemption upsert is what makes it count. Not double-counted either way.
      await seedHold({ id: "h-conf", orderId: "o-conf", humanId: HUMAN_A, status: "CONFIRMED" });

      expect(await stats(HUMAN_A)).toEqual({
        totalRedemptions: 0,
        redemptionsForHuman: 0,
      });
    });

    test("a hold whose order already has a redemption counts ONCE", async () => {
      await seedPromo({ maxRedemptions: 10 });
      // A PENDING hold left behind on an order that confirmed (status flip
      // and redemption upsert happen in one tx, but be paranoid about it).
      await seedHold({ id: "h-1", orderId: "o-1", humanId: HUMAN_A });
      await seedRedemption({ id: "r-1", orderId: "o-1", humanId: HUMAN_A });

      expect(await stats(HUMAN_A)).toEqual({
        totalRedemptions: 1,
        redemptionsForHuman: 1,
      });
    });

    test("anonymous caller: total still counts everyone, per-human leg is 0", async () => {
      await seedPromo({ maxRedemptions: 10 });
      await seedRedemption({ id: "r-1", orderId: "o-1", humanId: HUMAN_A });
      await seedHold({ id: "h-2", orderId: "o-2", humanId: HUMAN_B });

      expect(await stats(undefined)).toEqual({
        totalRedemptions: 2,
        redemptionsForHuman: 0,
      });
    });

    test("excludeOrderId leaves the buyer's OWN live hold out — a 1-per-person code stays theirs while they edit the cart", async () => {
      await seedPromo({ maxRedemptionsPerHuman: 1 });
      await seedHold({ id: "h-mine", orderId: "o-mine", humanId: HUMAN_A });

      // Without the exclusion their own hold fills the cap (the bug this guards).
      expect(await stats(HUMAN_A)).toEqual({
        totalRedemptions: 1,
        redemptionsForHuman: 1,
      });
      expect(await stats(HUMAN_A, "o-mine")).toEqual({
        totalRedemptions: 0,
        redemptionsForHuman: 0,
      });
    });

    test("excludeOrderId drops ONLY that order: a DIFFERENT pending order's hold still counts", async () => {
      await seedPromo({ maxRedemptionsPerHuman: 1 });
      await seedHold({ id: "h-mine", orderId: "o-mine", humanId: HUMAN_A });
      await seedHold({ id: "h-theirs", orderId: "o-theirs", humanId: HUMAN_B });

      // Excluding some other order of the buyer's leaves their real hold in place.
      expect(await stats(HUMAN_A, "o-elsewhere")).toEqual({
        totalRedemptions: 2,
        redemptionsForHuman: 1,
      });
      // Excluding their own order keeps the stranger's hold in the total.
      expect(await stats(HUMAN_A, "o-mine")).toEqual({
        totalRedemptions: 1,
        redemptionsForHuman: 0,
      });
    });

    test("excludeOrderId never drops a CONFIRMED redemption — a paid order is a real redemption", async () => {
      await seedPromo({ maxRedemptionsPerHuman: 1 });
      await seedRedemption({ id: "r-paid", orderId: "o-paid", humanId: HUMAN_A });

      expect(await stats(HUMAN_A, "o-paid")).toEqual({
        totalRedemptions: 1,
        redemptionsForHuman: 1,
      });
    });
  });

  describe("createHolds", () => {
    test("rejects with promo_max_redeemed once live holds fill the cap", async () => {
      await seedPromo({ maxRedemptions: 1 });
      await seedHold({ id: "h-1", orderId: "o-1", humanId: HUMAN_A });

      await expect(
        prisma!.$transaction((tx) =>
          makePromosRepo(tx).createHolds([holdInput("o-2", HUMAN_B)], { now: NOW }),
        ),
      ).rejects.toMatchObject({ code: "conflict", message: "promo_max_redeemed" });

      const { rows } = await pool!.query(`SELECT COUNT(*)::int AS n FROM "CouponHold"`);
      expect(rows[0].n).toBe(1);
    });

    test("rejects with promo_redeemed_by_human on a second live hold for the same human (two events at once)", async () => {
      await seedPromo({ maxRedemptionsPerHuman: 1 });
      await seedHold({ id: "h-1", orderId: "o-event-1", humanId: HUMAN_A });

      await expect(
        prisma!.$transaction((tx) =>
          makePromosRepo(tx).createHolds([holdInput("o-event-2", HUMAN_A)], { now: NOW }),
        ),
      ).rejects.toMatchObject({ code: "conflict", message: "promo_redeemed_by_human" });

      // A DIFFERENT human is still fine — the cap is per human.
      const [hold] = await prisma!.$transaction((tx) =>
        makePromosRepo(tx).createHolds([holdInput("o-event-3", HUMAN_B)], { now: NOW }),
      );
      expect(hold?.humanId).toBe(HUMAN_B);
    });

    test("an expired hold frees its slot", async () => {
      await seedPromo({ maxRedemptions: 1 });
      await seedHold({ id: "h-dead", orderId: "o-dead", humanId: HUMAN_A, expiresAt: DEAD_SINCE });

      const [hold] = await prisma!.$transaction((tx) =>
        makePromosRepo(tx).createHolds([holdInput("o-2", HUMAN_B)], { now: NOW }),
      );
      expect(hold?.orderId).toBe("o-2");
    });

    test("REJECTS a second checkout when the human's only prior hold is expired but its cart is still PENDING (the double-redemption)", async () => {
      await seedPromo({ maxRedemptionsPerHuman: 1 });
      // Minute 16: the first cart is past the 15-min hold TTL, not yet past
      // the 20-min cart TTL, and its PaymentIntent may still succeed.
      await seedOrder({ id: "o-first", status: "PENDING" });
      await seedHold({
        id: "h-first",
        orderId: "o-first",
        humanId: HUMAN_A,
        expiresAt: DEAD_SINCE,
      });

      await expect(
        prisma!.$transaction((tx) =>
          makePromosRepo(tx).createHolds([holdInput("o-second", HUMAN_A)], { now: NOW }),
        ),
      ).rejects.toMatchObject({ code: "conflict", message: "promo_redeemed_by_human" });

      const { rows } = await pool!.query(`SELECT COUNT(*)::int AS n FROM "CouponHold"`);
      expect(rows[0].n).toBe(1);
    });

    test("idempotent re-entry returns the existing hold instead of tripping the cap", async () => {
      await seedPromo({ maxRedemptions: 1, maxRedemptionsPerHuman: 1 });
      const first = await prisma!.$transaction((tx) =>
        makePromosRepo(tx).createHolds([holdInput("o-1", HUMAN_A)], { now: NOW }),
      );
      const again = await prisma!.$transaction((tx) =>
        makePromosRepo(tx).createHolds([holdInput("o-1", HUMAN_A)], { now: NOW }),
      );

      expect(again[0]?.id).toBe(first[0]?.id);
      const { rows } = await pool!.query(`SELECT COUNT(*)::int AS n FROM "CouponHold"`);
      expect(rows[0].n).toBe(1);
    });

    test("RACE: two concurrent transactions against maxRedemptions=1 — exactly one hold, the other rejects", async () => {
      await seedPromo({ maxRedemptions: 1 });

      // The first transaction keeps itself open AFTER inserting so the second
      // is provably queued on the advisory lock — not merely running later.
      // Without the lock, both would count 0 and both would insert.
      const attempt = (orderId: string, humanId: string, linger: number) =>
        prisma!.$transaction(
          async (tx) => {
            const holds = await makePromosRepo(tx).createHolds(
              [holdInput(orderId, humanId)],
              { now: NOW },
            );
            await sleep(linger);
            return holds;
          },
          { timeout: 10_000 },
        );

      const results = await Promise.allSettled([
        attempt("o-race-1", HUMAN_A, 400),
        (async () => {
          await sleep(50); // let the first one grab the lock
          return attempt("o-race-2", HUMAN_B, 0);
        })(),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({
        code: "conflict",
        message: "promo_max_redeemed",
      });

      const { rows } = await pool!.query(
        `SELECT "orderId" FROM "CouponHold" ORDER BY "orderId"`,
      );
      expect(rows.map((r) => r.orderId)).toEqual(["o-race-1"]);
    });

    test("membership-benefit holds are uncapped and untouched by the lock", async () => {
      // No Coupon row at all — a benefit hold must not look one up.
      const [hold] = await prisma!.$transaction((tx) =>
        makePromosRepo(tx).createHolds(
          [
            {
              membershipBenefitId: "33333333-3333-4333-8333-333333333333",
              orderId: "o-member",
              humanId: HUMAN_A,
              idempotencyKey: "order:o-member:benefit:33333333-3333-4333-8333-333333333333",
              code: "benefit:33333333-3333-4333-8333-333333333333",
              amountDiscountCents: 500,
              expiresAt: LIVE_UNTIL,
            },
          ],
          { now: NOW },
        ),
      );
      expect(hold?.membershipBenefitId).toBe("33333333-3333-4333-8333-333333333333");
      expect(hold?.promoId).toBeNull();
    });
  });
});
