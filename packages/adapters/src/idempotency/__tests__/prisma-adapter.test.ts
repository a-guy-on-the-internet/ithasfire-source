import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { PrismaIdempotencyAdapter } from "../prisma-adapter";

const IDEMPOTENCY_TABLE_SQL = `
CREATE TABLE "Idempotency" (
  "key" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'in_progress',
  "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "resultJson" JSONB,
  "errorText" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Idempotency_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "Idempotency_status_expiresAt_idx" ON "Idempotency"("status", "expiresAt");
`;

describe("PrismaIdempotencyAdapter", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(IDEMPOTENCY_TABLE_SQL);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 300_000);

  beforeEach(async () => {
    await pool?.query(`TRUNCATE "Idempotency"`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  test("status reports in_progress / succeeded without claiming, and null when expired or absent", async () => {
    const adapter = makeAdapter(prisma);

    await expect(adapter.status("s:none")).resolves.toBeNull();
    await expect(adapter.begin("s:1", 60, "owner")).resolves.toBe(true);
    await expect(adapter.status("s:1")).resolves.toBe("in_progress");
    // status() never claims: the owner can still release its own claim.
    await expect(adapter.release("s:1", "owner")).resolves.toBe(true);
    await expect(adapter.begin("s:1", 60)).resolves.toBe(true);
    await adapter.commit("s:1", { ok: true });
    await expect(adapter.status("s:1")).resolves.toBe("succeeded");
    await adapter.commit("s:expired", { ok: true }, -1);
    await expect(adapter.status("s:expired")).resolves.toBeNull();
  });

  test("begin returns false while an active claim exists", async () => {
    const adapter = makeAdapter(prisma);

    await expect(adapter.begin("active", 60)).resolves.toBe(true);
    await expect(adapter.begin("active", 60)).resolves.toBe(false);
  });

  test("commit stores a replayable successful result", async () => {
    const adapter = makeAdapter(prisma);

    await expect(adapter.begin("checkout:1", 60)).resolves.toBe(true);
    await adapter.commit("checkout:1", { orderId: "order-1", ok: true });

    await expect(adapter.begin("checkout:1", 60)).resolves.toBe(false);
    await expect(
      adapter.get<{ orderId: string; ok: boolean }>("checkout:1"),
    ).resolves.toEqual({
      orderId: "order-1",
      ok: true,
    });
  });

  test("commit normalizes JSON like the Redis adapter", async () => {
    const adapter = makeAdapter(prisma);
    const occurredAt = new Date("2026-05-13T12:34:56.000Z");

    await adapter.commit("json-normalization", {
      occurredAt,
      nested: { kept: true, omitted: undefined },
      list: [occurredAt, undefined],
    });

    await expect(adapter.get("json-normalization")).resolves.toEqual({
      occurredAt: "2026-05-13T12:34:56.000Z",
      nested: { kept: true },
      list: ["2026-05-13T12:34:56.000Z", null],
    });
  });

  test("begin reclaims expired rows", async () => {
    const adapter = makeAdapter(prisma);
    const past = new Date(Date.now() - 1_000);

    await prisma!.idempotency.create({
      data: {
        key: "test:expired",
        status: "succeeded",
        lockedAt: past,
        expiresAt: past,
        resultJson: { stale: true },
        errorText: "old-error",
      },
    });

    await expect(adapter.begin("expired", 60)).resolves.toBe(true);
    const row = await prisma!.idempotency.findUniqueOrThrow({
      where: { key: "test:expired" },
    });
    expect(row.status).toBe("in_progress");
    expect(row.resultJson).toBeNull();
    expect(row.errorText).toBeNull();
    expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  test("fail records an error and does not replay a result", async () => {
    const adapter = makeAdapter(prisma);

    await expect(adapter.begin("failure", 60)).resolves.toBe(true);
    await adapter.fail("failure", "provider unavailable");

    await expect(adapter.get("failure")).resolves.toBeNull();
    const row = await prisma!.idempotency.findUniqueOrThrow({
      where: { key: "test:failure" },
    });
    expect(row.status).toBe("failed");
    expect(row.errorText).toBe("provider unavailable");
  });

  test("namespaces isolate physical keys", async () => {
    const alpha = makeAdapter(prisma, "alpha");
    const beta = makeAdapter(prisma, "beta");

    await expect(alpha.begin("same-key", 60)).resolves.toBe(true);
    await expect(beta.begin("same-key", 60)).resolves.toBe(true);
    await alpha.commit("same-key", { namespace: "alpha" });
    await beta.commit("same-key", { namespace: "beta" });

    await expect(alpha.get("same-key")).resolves.toEqual({
      namespace: "alpha",
    });
    await expect(beta.get("same-key")).resolves.toEqual({ namespace: "beta" });
    await expect(prisma!.idempotency.count()).resolves.toBe(2);
  });

  test("run executes once, then replays the cached result", async () => {
    const adapter = makeAdapter(prisma);
    const fn = vi.fn(async () => ({ receiptId: "receipt-1" }));

    await expect(adapter.run("replay", 60, fn, 60)).resolves.toEqual({
      fresh: true,
      result: { receiptId: "receipt-1" },
    });
    await expect(adapter.run("replay", 60, fn, 60)).resolves.toEqual({
      fresh: false,
      result: { receiptId: "receipt-1" },
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // Redis expires its own keys; Postgres does not. Without a sweep these rows
  // accumulate forever and `resultJson` caches whole success payloads, so the
  // space is real. Reads already filter on `expiresAt`, so correctness never
  // depended on this — only footprint does.
  describe("purgeExpired", () => {
    const countRows = async () => {
      const rows = await pool!.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "Idempotency"`,
      );
      return Number(rows.rows[0]!.count);
    };

    test("deletes rows past expiry at any status, and keeps live ones", async () => {
      const adapter = makeAdapter(prisma);
      const past = new Date(Date.now() - 60_000).toISOString();
      const future = new Date(Date.now() + 600_000).toISOString();

      await pool!.query(
        `INSERT INTO "Idempotency" ("key","status","expiresAt","updatedAt") VALUES
           ('test:gone-succeeded','succeeded',$1,now()),
           ('test:gone-failed','failed',$1,now()),
           ('test:gone-inflight','in_progress',$1,now()),
           ('test:live','succeeded',$2,now()),
           ('test:forever','succeeded',NULL,now())`,
        [past, future],
      );
      expect(await countRows()).toBe(5);

      await expect(adapter.purgeExpired()).resolves.toBe(3);

      const left = await pool!.query<{ key: string }>(
        `SELECT "key" FROM "Idempotency" ORDER BY "key"`,
      );
      // `expiresAt: null` means keep indefinitely and must survive.
      expect(left.rows.map((r) => r.key)).toEqual([
        "test:forever",
        "test:live",
      ]);
    });

    test("respects the batch limit so one call can't emit an unbounded DELETE", async () => {
      const adapter = makeAdapter(prisma);
      const past = new Date(Date.now() - 60_000).toISOString();

      const values = Array.from(
        { length: 10 },
        (_, i) => `('test:b${i}','succeeded','${past}',now())`,
      ).join(",");
      await pool!.query(
        `INSERT INTO "Idempotency" ("key","status","expiresAt","updatedAt") VALUES ${values}`,
      );

      await expect(adapter.purgeExpired(4)).resolves.toBe(4);
      expect(await countRows()).toBe(6);

      // Draining loop terminates: the final pass comes back short.
      await expect(adapter.purgeExpired(4)).resolves.toBe(4);
      await expect(adapter.purgeExpired(4)).resolves.toBe(2);
      await expect(adapter.purgeExpired(4)).resolves.toBe(0);
      expect(await countRows()).toBe(0);
    });

    test("purging does not resurrect a still-valid cached result", async () => {
      const adapter = makeAdapter(prisma);

      await adapter.commit("checkout:keep", { orderId: "order-9" }, 600);
      await expect(adapter.purgeExpired()).resolves.toBe(0);
      await expect(adapter.get("checkout:keep")).resolves.toEqual({
        orderId: "order-9",
      });
    });
  });
});

function makeAdapter(
  prisma: PrismaClient | undefined,
  namespace = "test",
): PrismaIdempotencyAdapter {
  if (!prisma) throw new Error("Prisma test client was not initialized");
  return new PrismaIdempotencyAdapter(prisma, namespace);
}
