import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makePendingObjectDeletionsRepo } from "../pending-object-deletions";

// Standalone DDL, copied from
// packages/db/prisma/migrations/20260630120000_add_pending_object_deletions
// (same HAND-COPIED caveat as pending-object-deletions-outbox-health.test.ts).
const TABLE_SQL = `
CREATE TABLE "pending_object_deletion" (
  "id" TEXT NOT NULL,
  "target_key" TEXT NOT NULL,
  "target_kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" TEXT,
  "source_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pending_object_deletion_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pending_object_deletion_status_next_attempt_at_idx" ON "pending_object_deletion"("status", "next_attempt_at");
`;

/**
 * cancelPending (page editor: a save that references an image a Discard
 * queued withdraws the delete intent). Constructed with a PrismaPg adapter,
 * so the suite runs rather than silently skipping.
 */
describe("makePendingObjectDeletionsRepo.cancelPending (integration)", () => {
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
    await pool?.query(`TRUNCATE "pending_object_deletion"`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  const repo = () => makePendingObjectDeletionsRepo(prisma as PrismaClient);
  const SOURCE = "page_draft_discard";
  const later = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

  async function rows(): Promise<{ id: string; target_key: string; source: string | null; status: string }[]> {
    const result = await pool!.query(
      `SELECT id, target_key, source, status FROM "pending_object_deletion" ORDER BY id`,
    );
    return result.rows;
  }

  test("removes only PENDING rows of that source for the listed keys", async () => {
    await repo().enqueueMany([
      { id: "a", targetKey: "k/1.jpg", targetKind: "KEY", source: SOURCE, notBefore: later() },
      { id: "b", targetKey: "k/2.jpg", targetKind: "KEY", source: SOURCE, notBefore: later() },
      // Same key, another producer: untouched.
      { id: "c", targetKey: "k/1.jpg", targetKind: "KEY", source: "human_delete" },
      // Same source, a key not listed: untouched.
      { id: "d", targetKey: "k/3.jpg", targetKind: "KEY", source: SOURCE },
      // Same source and key, but DEAD: untouched (an ops record).
      { id: "e", targetKey: "k/2.jpg", targetKind: "KEY", source: SOURCE },
    ]);
    await repo().markDead({ id: "e", lastError: "gone for good" });

    const removed = await repo().cancelPending({
      source: SOURCE,
      targetKeys: ["k/1.jpg", "k/2.jpg"],
    });

    expect(removed).toBe(2);
    expect((await rows()).map((row) => [row.id, row.status])).toEqual([
      ["c", "PENDING"],
      ["d", "PENDING"],
      ["e", "DEAD"],
    ]);
  });

  test("an empty key list removes nothing and returns 0", async () => {
    await repo().enqueueMany([
      { id: "a", targetKey: "k/1.jpg", targetKind: "KEY", source: SOURCE },
    ]);
    expect(await repo().cancelPending({ source: SOURCE, targetKeys: [] })).toBe(0);
    expect(await rows()).toHaveLength(1);
  });

  test("inside a transaction it rolls back with the caller", async () => {
    await repo().enqueueMany([
      { id: "a", targetKey: "k/1.jpg", targetKind: "KEY", source: SOURCE },
    ]);
    await expect(
      (prisma as PrismaClient).$transaction(async (tx) => {
        const removed = await makePendingObjectDeletionsRepo(tx as never).cancelPending({
          source: SOURCE,
          targetKeys: ["k/1.jpg"],
        });
        expect(removed).toBe(1);
        throw new Error("caller failed");
      }),
    ).rejects.toThrow("caller failed");
    expect(await rows()).toHaveLength(1);
  });
});
