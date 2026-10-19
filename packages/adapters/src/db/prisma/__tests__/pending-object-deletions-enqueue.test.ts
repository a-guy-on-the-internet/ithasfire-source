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

describe("makePendingObjectDeletionsRepo.enqueueMany notBefore (integration)", () => {
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

  test("a notBefore row is not due until then; a plain row is due now", async () => {
    const later = new Date(Date.now() + 75 * 60 * 1000);
    await repo().enqueueMany([
      { targetKey: "k/original.jpg", targetKind: "KEY", source: "now", sourceId: "img-1" },
      {
        targetKey: "k/original.jpg",
        targetKind: "KEY",
        source: "later",
        sourceId: "img-1",
        notBefore: later,
      },
    ]);

    const dueNow = await repo().listDue({ now: new Date(Date.now() + 1000), limit: 10 });
    expect(dueNow.map((r) => r.source)).toEqual(["now"]);

    const dueLater = await repo().listDue({
      now: new Date(later.getTime() + 1000),
      limit: 10,
    });
    expect(dueLater.map((r) => r.source).sort()).toEqual(["later", "now"]);
    expect(dueLater.find((r) => r.source === "later")?.nextAttemptAt).toEqual(later);
  });

  test("keeps a caller-chosen id, so the caller can remove the row it fulfilled", async () => {
    const id = "6f1c2b9e-0d8a-4a7e-9b2f-3c4d5e6f7a8b";
    await repo().enqueueMany([
      { id, targetKey: "k/original.jpg", targetKind: "KEY", source: "now", sourceId: "img-1" },
      { targetKey: "k/other.jpg", targetKind: "KEY", source: "now", sourceId: "img-2" },
    ]);
    const due = await repo().listDue({ now: new Date(Date.now() + 1000), limit: 10 });
    expect(due.map((r) => r.id)).toContain(id);
    expect(await repo().markDeleted(id)).toBe(1);
    const left = await repo().listDue({ now: new Date(Date.now() + 1000), limit: 10 });
    expect(left.map((r) => r.targetKey)).toEqual(["k/other.jpg"]);
  });

  test("enqueueOnce: the first insert wins, a second returns the row that holds the id", async () => {
    const id = "upload-claim:abc";
    const first = await repo().enqueueOnce({
      id,
      targetKey: "k/upload.jpg",
      targetKind: "KEY",
      source: "avatar_upload_original_after_presign",
      sourceId: "k/copy-1.jpg",
    });
    const second = await repo().enqueueOnce({
      id,
      targetKey: "k/upload.jpg",
      targetKind: "KEY",
      source: "avatar_upload_refused",
    });

    expect(first).toEqual({ inserted: true });
    expect(second).toMatchObject({
      inserted: false,
      existing: { id, source: "avatar_upload_original_after_presign", sourceId: "k/copy-1.jpg" },
    });
    expect((await repo().getById(id))?.source).toBe("avatar_upload_original_after_presign");
    expect(await repo().getById("upload-claim:missing")).toBeNull();
  });

  test("enqueueOnce inside a transaction: a taken id does not abort it", async () => {
    const id = "upload-claim:tx";
    await repo().enqueueOnce({ id, targetKey: "k/u.jpg", targetKind: "KEY", source: "a" });

    await (prisma as PrismaClient).$transaction(async (tx) => {
      const txRepo = makePendingObjectDeletionsRepo(tx as never);
      const again = await txRepo.enqueueOnce({ id, targetKey: "k/u.jpg", targetKind: "KEY", source: "b" });
      expect(again.inserted).toBe(false);
      // The transaction is still usable after the conflict.
      await txRepo.enqueueMany([{ targetKey: "k/after.jpg", targetKind: "KEY", source: "after" }]);
    });

    const due = await repo().listDue({ now: new Date(Date.now() + 1000), limit: 10 });
    expect(due.map((r) => r.source).sort()).toEqual(["a", "after"]);
  });

  test("enqueueOnce: of concurrent inserts of one id, exactly one wins", async () => {
    const id = "upload-claim:race";
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        (prisma as PrismaClient).$transaction((tx) =>
          makePendingObjectDeletionsRepo(tx as never).enqueueOnce({
            id,
            targetKey: "k/race.jpg",
            targetKind: "KEY",
            source: `racer-${i}`,
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.inserted)).toHaveLength(1);
    const winner = (await repo().getById(id))?.source;
    for (const r of results) {
      if (!r.inserted) expect(r.existing?.source).toBe(winner);
    }
  });
});
