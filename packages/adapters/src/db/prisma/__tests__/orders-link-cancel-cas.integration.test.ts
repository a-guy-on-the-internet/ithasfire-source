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
// createCheckout links its PaymentIntent AFTER the order commits, so between
// the commit and the link a PENDING order with no PI is visible to the
// cancellers (retire / releaseCartHold / the cart reaper). Correctness rests
// on two single-statement CASes on the same row:
//
//   linkPaymentIntentIfPending   PENDING ∧ (PI IS NULL ∨ PI = p) → PI := p
//   cancelPendingOrder(expected) PENDING ∧ PI = expected        → CANCELLED
//
// Under READ COMMITTED, an UPDATE blocked on a row lock re-evaluates its WHERE
// against the row the other transaction committed. So whichever CAS commits
// first, the other must match nothing — never "cancelled with a live PI" and
// never "linked onto a cancelled order". That is a property of Postgres, not
// of a mocked client, hence a real database here.
//
// Only the columns the methods touch (house precedent:
// orders-processor-fee.integration.test.ts). `updatedAt` because the model is
// @updatedAt, so every Prisma UPDATE writes it; the PI column is UNIQUE as in
// the real schema.
// ---------------------------------------------------------------------------

const TABLE_SQL = `
CREATE TYPE "OrderStatus" AS ENUM (
  'PENDING', 'PROCESSING', 'SUCCEEDED', 'PART_REFUNDED',
  'REFUNDED', 'DISPUTED', 'CANCELLED'
);

CREATE TABLE "Order" (
  "id"                    TEXT NOT NULL,
  "status"                "OrderStatus" NOT NULL DEFAULT 'PENDING',
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "stripePaymentIntentId" TEXT,
  CONSTRAINT "Order_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Order_stripePaymentIntentId_key" UNIQUE ("stripePaymentIntentId")
);
`;

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("orders link vs cancel CAS (integration, real Postgres)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let orders: ReturnType<typeof makeOrdersRepo>;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl, max: 6 });
    await pool.query(TABLE_SQL);
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

  const insertPending = (id: string) =>
    pool!.query(`INSERT INTO "Order" ("id") VALUES ($1)`, [id]);

  const row = async (id: string) =>
    (
      await pool!.query<{
        status: string;
        stripePaymentIntentId: string | null;
      }>(
        `SELECT "status", "stripePaymentIntentId" FROM "Order" WHERE "id" = $1`,
        [id],
      )
    ).rows[0];

  /**
   * Runs `first` inside an open transaction (so it holds the row lock),
   * starts `second` on another connection — which must BLOCK on that lock —
   * then commits `first` and lets `second` re-evaluate.
   */
  async function interleave<A, B>(
    first: (repo: ReturnType<typeof makeOrdersRepo>) => Promise<A>,
    second: () => Promise<B>,
  ): Promise<{ first: A; second: B; secondBlocked: boolean }> {
    const firstApplied = deferred();
    const release = deferred();
    const firstTx = prisma!.$transaction(
      async (tx) => {
        const result = await first(makeOrdersRepo(tx));
        firstApplied.resolve();
        await release.promise;
        return result;
      },
      { timeout: 20_000 },
    );
    await firstApplied.promise;

    let secondDone = false;
    const secondCall = second().then((r) => {
      secondDone = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    const secondBlocked = !secondDone;

    release.resolve();
    const [a, b] = await Promise.all([firstTx, secondCall]);
    return { first: a, second: b, secondBlocked };
  }

  test("link commits first → the reader-of-'no PI' cancel matches nothing", async () => {
    await insertPending("o1");

    const r = await interleave(
      (repo) => repo.linkPaymentIntentIfPending("o1", "pi_1"),
      () => orders.cancelPendingOrder("o1", { expectedPaymentIntentId: null }),
    );

    expect(r.secondBlocked).toBe(true);
    expect(r.first).toBe(true);
    expect(r.second).toBe(false);
    expect(await row("o1")).toEqual({
      status: "PENDING",
      stripePaymentIntentId: "pi_1",
    });
  });

  test("cancel commits first → the link matches nothing (no PI on a CANCELLED order)", async () => {
    await insertPending("o2");

    const r = await interleave(
      (repo) =>
        repo.cancelPendingOrder("o2", { expectedPaymentIntentId: null }),
      () => orders.linkPaymentIntentIfPending("o2", "pi_2"),
    );

    expect(r.secondBlocked).toBe(true);
    expect(r.first).toBe(true);
    expect(r.second).toBe(false);
    expect(await row("o2")).toEqual({
      status: "CANCELLED",
      stripePaymentIntentId: null,
    });
  });

  test("cancel commits first → a stale finalize cannot mark the order SUCCEEDED", async () => {
    await insertPending("o3");

    const r = await interleave(
      (repo) =>
        repo.cancelPendingOrder("o3", { expectedPaymentIntentId: null }),
      () => orders.markSucceededIfOpen("o3"),
    );

    expect(r.secondBlocked).toBe(true);
    expect(r.second).toBe(false);
    expect((await row("o3"))!.status).toBe("CANCELLED");
  });

  test("free-running race: exactly one of link / cancel wins, every time", async () => {
    for (let i = 0; i < 40; i++) {
      const id = `race-${i}`;
      await insertPending(id);

      const [linked, cancelled] = await Promise.all([
        orders.linkPaymentIntentIfPending(id, `pi_race_${i}`),
        orders.cancelPendingOrder(id, { expectedPaymentIntentId: null }),
      ]);

      expect(linked !== cancelled).toBe(true);
      expect(await row(id)).toEqual(
        linked
          ? { status: "PENDING", stripePaymentIntentId: `pi_race_${i}` }
          : { status: "CANCELLED", stripePaymentIntentId: null },
      );
    }
  });
});
