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
// packages/db/prisma/migrations/20260630120000_add_pending_object_deletions.
//
// WARNING, same as the sibling image-moderation suite: this is HAND-COPIED and
// therefore green by construction if it drifts. A column the table has in
// production but not here simply is not exercised. When you touch the model,
// touch this too.
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

// The `source` a moderator REJECT stamps (`review-flagged-image.ts`, via
// `_shared/moderation-deletion-source.ts`). Written out rather than imported so
// this test pins the STRING the production writer uses — importing the constant
// would make a rename green on both sides while the dashboard silently read 0.
const MODERATION_SOURCE = "image-moderation-reject";

describe("makePendingObjectDeletionsRepo.countOutboxHealth (integration)", () => {
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

  const makeRepo = () =>
    makePendingObjectDeletionsRepo(prisma as PrismaClient);

  const NOW = new Date("2026-09-12T12:00:00.000Z");
  /** 60m of grace, matching the snapshot's default. */
  const DUE_BEFORE = new Date("2026-09-12T11:00:00.000Z");

  const seed = async (
    id: string,
    over: Record<string, unknown> = {},
  ): Promise<void> => {
    await (prisma as PrismaClient).pendingObjectDeletion.create({
      data: {
        id,
        targetKey: `events/${id}/hero.jpg`,
        targetKind: "KEY",
        status: "PENDING",
        attempts: 0,
        nextAttemptAt: new Date("2026-09-12T10:00:00.000Z"),
        source: MODERATION_SOURCE,
        sourceId: `record-${id}`,
        ...over,
      } as never,
    });
  };

  test("counts DEAD and OVERDUE rows separately", async () => {
    // They call for different responses. A DEAD row will never be retried by
    // anything — the bytes stay live until a human acts. A pile of OVERDUE rows
    // means the drain itself stopped, which affects every producer at once.
    // Summed, neither is actionable.
    await seed("dead-1", { status: "DEAD", attempts: 8, lastError: "403" });
    await seed("dead-2", { status: "DEAD", attempts: 8, lastError: "403" });
    await seed("overdue-1");

    expect(
      await makeRepo().countOutboxHealth({
        dueBefore: DUE_BEFORE,
        source: MODERATION_SOURCE,
      }),
    ).toEqual({ dead: 2, overdue: 1 });
  });

  test("does NOT count a row still inside its grace window", async () => {
    // THE reason the cutoff exists. Every freshly enqueued row has
    // `nextAttemptAt = now()`, so measuring against `now` would count the
    // outbox's normal in-flight work and the tile would be loudest on its
    // healthiest days.
    await seed("just-enqueued", { nextAttemptAt: NOW });
    await seed("backing-off", {
      nextAttemptAt: new Date("2026-09-12T14:00:00.000Z"),
    });

    expect(
      await makeRepo().countOutboxHealth({
        dueBefore: DUE_BEFORE,
        source: MODERATION_SOURCE,
      }),
    ).toEqual({ dead: 0, overdue: 0 });
  });

  test("a DEAD row is never ALSO counted as overdue", async () => {
    // Double-counting would make the two tiles add up to more than the table
    // holds, which reads as a bug in the dashboard rather than in the outbox.
    await seed("dead-and-old", {
      status: "DEAD",
      nextAttemptAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(
      await makeRepo().countOutboxHealth({
        dueBefore: DUE_BEFORE,
        source: MODERATION_SOURCE,
      }),
    ).toEqual({ dead: 1, overdue: 0 });
  });

  test("SCOPES to the moderation source — other producers do not inflate it", async () => {
    // The tile claims "images we told an uploader we removed". An event-delete
    // cascade stalling is a real problem and a different one; folding it in
    // would make the moderation number a lie in both directions.
    await seed("mine", { status: "DEAD" });
    await seed("theirs", { status: "DEAD", source: "event_delete" });
    await seed("anonymous", { status: "DEAD", source: null });

    const repo = makeRepo();

    expect(
      await repo.countOutboxHealth({
        dueBefore: DUE_BEFORE,
        source: MODERATION_SOURCE,
      }),
    ).toEqual({ dead: 1, overdue: 0 });

    // Unscoped counts the whole table, null `source` included.
    expect(await repo.countOutboxHealth({ dueBefore: DUE_BEFORE })).toEqual({
      dead: 3,
      overdue: 0,
    });
  });

  test("applies the source scope to BOTH counts or neither", async () => {
    // A dead count scoped to moderation sitting beside an overdue count over
    // the whole table would be two different questions wearing one label.
    await seed("mine-dead", { status: "DEAD" });
    await seed("theirs-overdue", { source: "event_delete" });

    expect(
      await makeRepo().countOutboxHealth({
        dueBefore: DUE_BEFORE,
        source: MODERATION_SOURCE,
      }),
    ).toEqual({ dead: 1, overdue: 0 });
  });

  test("a drained row disappears entirely — `markDeleted` hard-deletes", async () => {
    // Why there is no "still undeleted" clause in the query: the existence of a
    // row IS that condition. If this ever becomes a soft delete, the overdue
    // count silently starts including drained rows.
    await seed("drained");
    const repo = makeRepo();
    expect(
      (
        await repo.countOutboxHealth({
          dueBefore: DUE_BEFORE,
          source: MODERATION_SOURCE,
        })
      ).overdue,
    ).toBe(1);

    expect(await repo.markDeleted("drained")).toBe(1);

    expect(
      await repo.countOutboxHealth({
        dueBefore: DUE_BEFORE,
        source: MODERATION_SOURCE,
      }),
    ).toEqual({ dead: 0, overdue: 0 });
  });

  test("reports zeroes on an empty outbox", async () => {
    expect(
      await makeRepo().countOutboxHealth({
        dueBefore: DUE_BEFORE,
        source: MODERATION_SOURCE,
      }),
    ).toEqual({ dead: 0, overdue: 0 });
  });

  test("`markDead` moves a row from the overdue bucket to the dead one", async () => {
    // End-to-end through the real writer rather than a seeded status string, so
    // a change to what `markDead` writes cannot leave this count behind.
    await seed("exhausting");
    const repo = makeRepo();

    await repo.markDead({ id: "exhausting", lastError: "AccessDenied" });

    expect(
      await repo.countOutboxHealth({
        dueBefore: DUE_BEFORE,
        source: MODERATION_SOURCE,
      }),
    ).toEqual({ dead: 1, overdue: 0 });
  });
});
