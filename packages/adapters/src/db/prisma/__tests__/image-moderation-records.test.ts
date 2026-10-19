import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeImageModerationRecordsRepo } from "../image-moderation-records";

// Standalone DDL (mirrors the migration) WITHOUT the Human FK so the table is
// self-contained — createdByHumanId is just a string here.
const TABLE_SQL = `
CREATE TABLE "image_moderation_records" (
  "id" TEXT NOT NULL,
  "storage_key" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "subject_type" TEXT,
  "subject_id" TEXT,
  "public_url" TEXT,
  "content_type" TEXT,
  "created_by_human_id" TEXT,
  "max_severity" INTEGER,
  "categories" JSONB,
  "provider" TEXT,
  "degraded" BOOLEAN NOT NULL DEFAULT false,
  "moderated_at" TIMESTAMP(3),
  "reviewed_by_human_id" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "review_note" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requeues" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "image_moderation_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "image_moderation_records_storage_key_key" ON "image_moderation_records"("storage_key");
CREATE INDEX "image_moderation_records_status_next_attempt_at_idx" ON "image_moderation_records"("status", "next_attempt_at");
CREATE INDEX "image_moderation_records_status_moderated_at_idx" ON "image_moderation_records"("status", "moderated_at");
CREATE INDEX "image_moderation_records_requeue_candidates_idx" ON "image_moderation_records" ("moderated_at") WHERE "status" = 'FLAGGED' AND "degraded" = true AND "reviewed_at" IS NULL;
`;

// WARNING: the DDL above is HAND-COPIED from
// packages/db/prisma/migrations/*/migration.sql. It is green by construction if
// it drifts from the real schema — a column this table has in production but
// not here simply is not exercised. When you touch the model, touch this too.

describe("makeImageModerationRecordsRepo (integration)", () => {
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
    await pool?.query(`TRUNCATE "image_moderation_records"`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  const makeRepo = () => makeImageModerationRecordsRepo(prisma as PrismaClient);

  test("create is idempotent on storageKey and RESETS a re-uploaded object to PENDING", async () => {
    const repo = makeRepo();

    const created = await repo.create({
      storageKey: "events/e1/hero.jpg",
      kind: "EVENT_HERO",
      subjectType: "EVENT",
      subjectId: "e1",
      publicUrl: "https://cdn.test/events/e1/hero.jpg",
      contentType: "image/jpeg",
      createdByHumanId: "human-1",
    });
    expect(created.status).toBe("PENDING");
    expect(created.attempts).toBe(0);

    // Provider verdict lands: FLAGGED with severities + degraded marker.
    await repo.markResult({
      storageKey: "events/e1/hero.jpg",
      status: "FLAGGED",
      maxSeverity: 6,
      categories: [{ category: "SEXUAL", severity: 6 }],
      provider: "azure-content-safety",
      degraded: true,
      moderatedAt: new Date("2026-07-08T10:00:00.000Z"),
    });

    const flagged = await repo.getByKey("events/e1/hero.jpg");
    expect(flagged?.status).toBe("FLAGGED");
    expect(flagged?.maxSeverity).toBe(6);
    expect(flagged?.categories).toEqual([{ category: "SEXUAL", severity: 6 }]);
    expect(flagged?.degraded).toBe(true);
    expect(flagged?.moderatedAt).not.toBeNull();

    // Re-upload to the SAME key: must reset to a clean PENDING to-do.
    await repo.create({
      storageKey: "events/e1/hero.jpg",
      kind: "EVENT_HERO",
      subjectType: "EVENT",
      subjectId: "e1",
      publicUrl: "https://cdn.test/events/e1/hero.jpg",
      contentType: "image/jpeg",
      createdByHumanId: "human-1",
    });

    const reset = await repo.getByKey("events/e1/hero.jpg");
    expect(reset?.status).toBe("PENDING");
    expect(reset?.attempts).toBe(0);
    expect(reset?.maxSeverity).toBeNull();
    expect(reset?.categories).toBeNull();
    expect(reset?.provider).toBeNull();
    expect(reset?.degraded).toBe(false);
    expect(reset?.moderatedAt).toBeNull();
    expect(reset?.reviewedByHumanId).toBeNull();
    expect(reset?.reviewedAt).toBeNull();
    expect(reset?.reviewNote).toBeNull();
    // Same row (upsert, not a second insert).
    expect(reset?.id).toBe(created.id);
  });

  test("review is a FLAGGED-only CAS returning the affected count", async () => {
    const repo = makeRepo();

    const created = await repo.create({
      storageKey: "events/e2/hero.jpg",
      kind: "EVENT_HERO",
      subjectType: "EVENT",
      subjectId: "e2",
    });
    await repo.markResult({
      storageKey: "events/e2/hero.jpg",
      status: "FLAGGED",
      maxSeverity: 4,
      categories: [{ category: "VIOLENCE", severity: 4 }],
      provider: "azure-content-safety",
      degraded: false,
      moderatedAt: new Date("2026-07-08T10:00:00.000Z"),
    });

    // Genuine FLAGGED→APPROVED transition → 1 affected row.
    const first = await repo.review({
      id: created.id,
      status: "APPROVED",
      reviewedByHumanId: "mod-1",
      reviewedAt: new Date("2026-07-08T11:00:00.000Z"),
      reviewNote: "looks fine",
    });
    expect(first).toBe(1);

    // Re-review of an already-decided record → 0 (no double-notify).
    const second = await repo.review({
      id: created.id,
      status: "REJECTED",
      reviewedByHumanId: "mod-2",
      reviewedAt: new Date("2026-07-08T12:00:00.000Z"),
    });
    expect(second).toBe(0);

    const after = await repo.getByKey("events/e2/hero.jpg");
    expect(after?.status).toBe("APPROVED");
    expect(after?.reviewedByHumanId).toBe("mod-1");
  });

  test("markResult only touches still-PENDING rows (no clobber of a human decision)", async () => {
    const repo = makeRepo();

    const created = await repo.create({
      storageKey: "events/e3/hero.jpg",
      kind: "EVENT_HERO",
      subjectType: "EVENT",
      subjectId: "e3",
    });

    // Machine verdict on the PENDING row → FLAGGED (this write DOES apply).
    await repo.markResult({
      storageKey: "events/e3/hero.jpg",
      status: "FLAGGED",
      maxSeverity: 4,
      categories: [{ category: "SEXUAL", severity: 4 }],
      provider: "azure-content-safety",
      degraded: false,
      moderatedAt: new Date("2026-07-08T10:00:00.000Z"),
    });

    // A human rejects it (FLAGGED→REJECTED via the CAS).
    const rejected = await repo.review({
      id: created.id,
      status: "REJECTED",
      reviewedByHumanId: "mod-1",
      reviewedAt: new Date("2026-07-08T11:00:00.000Z"),
      reviewNote: "explicit",
    });
    expect(rejected).toBe(1);

    // A slow/overlapping drain run tries to stamp a verdict AFTER the human
    // decision. Because markResult is scoped to status = PENDING, this must be a
    // no-op — it can't resurrect a REJECTED row back to FLAGGED.
    await repo.markResult({
      storageKey: "events/e3/hero.jpg",
      status: "FLAGGED",
      maxSeverity: 6,
      categories: [{ category: "VIOLENCE", severity: 6 }],
      provider: "azure-content-safety",
      degraded: true,
      moderatedAt: new Date("2026-07-08T12:00:00.000Z"),
    });

    const after = await repo.getByKey("events/e3/hero.jpg");
    expect(after?.status).toBe("REJECTED");
    expect(after?.reviewedByHumanId).toBe("mod-1");
    // The human decision's verdict fields are preserved (the late write was a
    // no-op) — severity stays 4, degraded stays false.
    expect(after?.maxSeverity).toBe(4);
    expect(after?.degraded).toBe(false);
  });
  // ───────────────────────────────────────────────────────────────────────────
  // requeueDegraded — the WHERE clause IS the safety property.
  //
  // These run against real SQL on purpose. The use-case tests can only prove
  // that parameters are forwarded; whether a human's decision survives an
  // hourly job is a property of the statement, and nothing but a database can
  // answer it.
  // ───────────────────────────────────────────────────────────────────────────

  // Seed through PRISMA, not raw pg. `moderated_at` is TIMESTAMP WITHOUT TIME
  // ZONE: the pg driver converts a JS Date to the process's LOCAL time on
  // insert, while Prisma serializes its comparison operands as UTC — so a
  // raw-SQL seed and a Prisma WHERE disagree by the local offset, and a row
  // stamped "too recent" silently compares as old enough. Production writes
  // this column through Prisma (`markResult`) and reads it through Prisma, so
  // seeding the same way is both correct and representative.
  const seed = async (
    key: string,
    over: Record<string, unknown> = {},
  ): Promise<void> => {
    await (prisma as PrismaClient).imageModerationRecord.create({
      data: {
        id: key,
        storageKey: key,
        kind: "EVENT_HERO",
        status: "FLAGGED",
        degraded: true,
        maxSeverity: 6,
        moderatedAt: new Date("2026-08-19T00:00:00.000Z"),
        reviewedAt: null,
        requeues: 0,
        attempts: 5,
        ...over,
      } as any,
    });
  };

  const statusOf = async (key: string) => {
    const r = await pool!.query(
      `SELECT status, degraded, attempts, requeues, max_severity, moderated_at
         FROM "image_moderation_records" WHERE id = $1`,
      [key],
    );
    return r.rows[0];
  };

  const REQUEUE_ARGS = {
    now: new Date("2026-08-20T18:00:00.000Z"),
    limit: 100,
    moderatedBefore: new Date("2026-08-20T17:45:00.000Z"),
    maxRequeues: 3,
  };

  test("revives a degraded row and clears its verdict, incrementing requeues", async () => {
    await seed("degraded-1");

    const moved = await makeRepo().requeueDegraded(REQUEUE_ARGS);

    expect(moved).toBe(1);
    const row = await statusOf("degraded-1");
    expect(row.status).toBe("PENDING");
    expect(row.degraded).toBe(false);
    expect(row.attempts).toBe(0);
    // Verdict fields cleared — a half-cleared row would show a stale severity
    // in the queue while claiming to be undecided.
    expect(row.max_severity).toBeNull();
    expect(row.moderated_at).toBeNull();
    // attempts reset, requeues NOT: different clocks measuring different things.
    expect(row.requeues).toBe(1);
  });

  test("NEVER revives a real content verdict (degraded = false)", async () => {
    // The single most important assertion in this file. An image the provider
    // actually scored at/above threshold must not be quietly re-scored into
    // visibility by a retry — only a human clears that.
    await seed("content-verdict", { degraded: false });

    expect(await makeRepo().requeueDegraded(REQUEUE_ARGS)).toBe(0);
    expect((await statusOf("content-verdict")).status).toBe("FLAGGED");
  });

  test("NEVER revives a human decision — APPROVED or REJECTED", async () => {
    await seed("approved", { status: "APPROVED" });
    await seed("rejected", { status: "REJECTED" });

    expect(await makeRepo().requeueDegraded(REQUEUE_ARGS)).toBe(0);
    expect((await statusOf("approved")).status).toBe("APPROVED");
    expect((await statusOf("rejected")).status).toBe("REJECTED");
  });

  test("NEVER revives a reviewed row even if it somehow stayed FLAGGED", async () => {
    // Defence in depth. Today a review always moves status off FLAGGED, so this
    // combination is unreachable — the clause exists so that a FUTURE review
    // path which leaves status alone cannot have its decision silently undone.
    await seed("reviewed-but-flagged", {
      reviewedAt: new Date("2026-08-19T12:00:00.000Z"),
    });

    expect(await makeRepo().requeueDegraded(REQUEUE_ARGS)).toBe(0);
    expect((await statusOf("reviewed-but-flagged")).status).toBe("FLAGGED");
  });

  test("stops reviving a row once it hits the requeue cap", async () => {
    // The churn guard: an object that can never be scanned (deleted event,
    // GC'd media) must stop cycling and settle as a human's problem.
    await seed("at-cap", { requeues: 3 });
    await seed("under-cap", { requeues: 2 });

    expect(await makeRepo().requeueDegraded(REQUEUE_ARGS)).toBe(1);
    expect((await statusOf("at-cap")).status).toBe("FLAGGED");
    expect((await statusOf("under-cap")).status).toBe("PENDING");
  });

  test("leaves a row that dead-lettered too recently alone", async () => {
    // Still inside its own retry window — the drain owns it, not this job.
    await seed("fresh", {
      moderatedAt: new Date("2026-08-20T17:55:00.000Z"),
    });

    expect(await makeRepo().requeueDegraded(REQUEUE_ARGS)).toBe(0);
    expect((await statusOf("fresh")).status).toBe("FLAGGED");
  });

  test("two overlapping runs cannot double-count requeues", async () => {
    // updateMany is one statement, so the selection and mutation cannot be
    // torn apart. The second run sees a PENDING row and matches nothing.
    await seed("race");
    const repo = makeRepo();

    const [a, b] = await Promise.all([
      repo.requeueDegraded(REQUEUE_ARGS),
      repo.requeueDegraded(REQUEUE_ARGS),
    ]);

    expect(a + b).toBe(1);
    expect((await statusOf("race")).requeues).toBe(1);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // countQueueHealth — five signals that must not bleed into each other.
  // ───────────────────────────────────────────────────────────────────────────

  const HEALTH_ARGS = {
    pendingDueBefore: new Date("2026-08-20T17:00:00.000Z"),
    moderatedBefore: new Date("2026-08-19T18:00:00.000Z"),
    degradedSince: new Date("2026-08-20T16:00:00.000Z"),
    maxRequeues: 3,
  };

  test("counts each failure signal independently", async () => {
    // One row per signal, plus two rows that must be counted by NOTHING.
    await seed("overdue", {
      status: "PENDING",
      degraded: false,
      maxSeverity: null,
      moderatedAt: null,
      nextAttemptAt: new Date("2026-08-20T16:30:00.000Z"),
    });
    await seed("rotting-hold", {
      degraded: false,
      moderatedAt: new Date("2026-08-18T00:00:00.000Z"),
    });
    await seed("scanner-failing", {
      moderatedAt: new Date("2026-08-20T17:30:00.000Z"),
    });
    await seed("unscannable", { requeues: 3 });

    // Neither of these is a problem: a PENDING row legitimately backing off
    // into the future, and a hold a human already decided.
    await seed("backing-off", {
      status: "PENDING",
      degraded: false,
      moderatedAt: null,
      nextAttemptAt: new Date("2026-08-20T23:00:00.000Z"),
    });
    await seed("already-approved", { status: "APPROVED", degraded: false });

    const health = await makeRepo().countQueueHealth(HEALTH_ARGS);

    expect(health).toEqual({
      pendingOverdue: 1,
      awaitingReview: 1,
      // "scanner-failing" and "unscannable" are both degraded+FLAGGED; only the
      // first is inside the recent window, only the second is at the cap.
      degradedRecent: 1,
      degradedExhausted: 1,
      orphanedRecent: 0,
    });
  });

  test("does not count a degraded row as awaiting human review", async () => {
    // The distinction the whole alert rests on: "a human must judge this" vs
    // "our scanner broke". Collapsing them would page a moderator for an outage.
    await seed("degraded-old", {
      moderatedAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    const health = await makeRepo().countQueueHealth(HEALTH_ARGS);

    expect(health.awaitingReview).toBe(0);
    expect(health.degradedExhausted).toBe(0); // requeues 0, under the cap
  });

  test("reports zeroes on an empty queue", async () => {
    expect(await makeRepo().countQueueHealth(HEALTH_ARGS)).toEqual({
      pendingOverdue: 0,
      awaitingReview: 0,
      degradedRecent: 0,
      degradedExhausted: 0,
      orphanedRecent: 0,
    });
  });

  test("counts recent ORPHANED rows, and only recent ones", async () => {
    // ORPHANED shows up on no other surface, so this count is the only thing
    // that will ever tell an operator objects are vanishing from the bucket.
    await seed("orphan-now", {
      status: "ORPHANED",
      degraded: false,
      maxSeverity: null,
      // Inside HEALTH_ARGS.degradedSince.
      moderatedAt: new Date("2026-08-20T17:00:00.000Z"),
    });
    await seed("orphan-old", {
      status: "ORPHANED",
      degraded: false,
      maxSeverity: null,
      moderatedAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    const health = await makeRepo().countQueueHealth(HEALTH_ARGS);

    expect(health.orphanedRecent).toBe(1);
    // An ORPHANED row is not a scanner failure and not a human's problem — it
    // must not inflate any of the other four signals.
    expect(health).toMatchObject({
      pendingOverdue: 0,
      awaitingReview: 0,
      degradedRecent: 0,
      degradedExhausted: 0,
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // listQueueHealthSignal — the drill-down behind each count.
  //
  // The property under test is not "the list works", it is that the list and
  // the COUNT select the same rows. Both go through one `queueHealthWhere`, so
  // the cheapest honest assertion is: for every signal, with one fixed set of
  // cutoffs, `items.length === counts[signal]`. Anyone who re-introduces a
  // second WHERE has to make that equality hold by hand, forever.
  // ───────────────────────────────────────────────────────────────────────────

  const SIGNALS = [
    "pendingOverdue",
    "awaitingReview",
    "degradedRecent",
    "degradedExhausted",
    "orphanedRecent",
  ] as const;

  /** One row in every bucket, plus two that belong to no bucket at all. */
  const seedOneOfEach = async (): Promise<void> => {
    await seed("overdue", {
      status: "PENDING",
      degraded: false,
      maxSeverity: null,
      moderatedAt: null,
      nextAttemptAt: new Date("2026-08-20T16:30:00.000Z"),
    });
    await seed("rotting-hold", {
      degraded: false,
      moderatedAt: new Date("2026-08-18T00:00:00.000Z"),
    });
    await seed("scanner-failing", {
      moderatedAt: new Date("2026-08-20T17:30:00.000Z"),
    });
    await seed("unscannable", { requeues: 3 });
    await seed("orphan-now", {
      status: "ORPHANED",
      degraded: false,
      maxSeverity: null,
      moderatedAt: new Date("2026-08-20T17:00:00.000Z"),
    });
    // Neither of these is a problem, and neither may show up in ANY bucket.
    await seed("backing-off", {
      status: "PENDING",
      degraded: false,
      moderatedAt: null,
      nextAttemptAt: new Date("2026-08-20T23:00:00.000Z"),
    });
    await seed("already-approved", { status: "APPROVED", degraded: false });
  };

  test("every bucket's list matches that bucket's count, row for row", async () => {
    await seedOneOfEach();
    const repo = makeRepo();

    const counts = await repo.countQueueHealth(HEALTH_ARGS);

    for (const signal of SIGNALS) {
      const page = await repo.listQueueHealthSignal({
        ...HEALTH_ARGS,
        signal,
        limit: 30,
      });
      expect({ signal, n: page.items.length }).toEqual({
        signal,
        n: counts[signal],
      });
    }
  });

  test("each bucket lists exactly the row that bucket is about", async () => {
    await seedOneOfEach();
    const repo = makeRepo();

    const keysFor = async (signal: (typeof SIGNALS)[number]) =>
      (
        await repo.listQueueHealthSignal({ ...HEALTH_ARGS, signal, limit: 30 })
      ).items.map((i) => i.storageKey);

    expect(await keysFor("pendingOverdue")).toEqual(["overdue"]);
    expect(await keysFor("awaitingReview")).toEqual(["rotting-hold"]);
    expect(await keysFor("degradedRecent")).toEqual(["scanner-failing"]);
    expect(await keysFor("degradedExhausted")).toEqual(["unscannable"]);
    expect(await keysFor("orphanedRecent")).toEqual(["orphan-now"]);
  });

  test("pendingOverdue orders OLDEST-due first — the row that dates the stall", async () => {
    // The four moderated buckets sort newest-decision-first, but an overdue
    // PENDING row has no `moderatedAt` at all (that IS the problem), and the
    // useful question is "how long has this been stuck", which the oldest
    // `nextAttemptAt` answers.
    const pending = (key: string, due: string) =>
      seed(key, {
        status: "PENDING",
        degraded: false,
        maxSeverity: null,
        moderatedAt: null,
        nextAttemptAt: new Date(due),
      });
    await pending("due-recent", "2026-08-20T16:50:00.000Z");
    await pending("due-ancient", "2026-08-01T00:00:00.000Z");
    await pending("due-middle", "2026-08-10T00:00:00.000Z");

    const page = await makeRepo().listQueueHealthSignal({
      ...HEALTH_ARGS,
      signal: "pendingOverdue",
      limit: 30,
    });

    expect(page.items.map((i) => i.storageKey)).toEqual([
      "due-ancient",
      "due-middle",
      "due-recent",
    ]);
  });

  test("moderated buckets order newest-first", async () => {
    await seed("old-fail", { moderatedAt: new Date("2026-08-20T16:05:00.000Z") });
    await seed("new-fail", { moderatedAt: new Date("2026-08-20T17:55:00.000Z") });
    await seed("mid-fail", { moderatedAt: new Date("2026-08-20T17:00:00.000Z") });

    const page = await makeRepo().listQueueHealthSignal({
      ...HEALTH_ARGS,
      signal: "degradedRecent",
      limit: 30,
    });

    expect(page.items.map((i) => i.storageKey)).toEqual([
      "new-fail",
      "mid-fail",
      "old-fail",
    ]);
  });

  test("pages with an opaque cursor and stops without one", async () => {
    // Same keyset convention as listFlagged: cursor is the last row's id, and
    // nextCursor is null on the final page (NOT on the last full page).
    await seed("f1", { moderatedAt: new Date("2026-08-20T17:10:00.000Z") });
    await seed("f2", { moderatedAt: new Date("2026-08-20T17:20:00.000Z") });
    await seed("f3", { moderatedAt: new Date("2026-08-20T17:30:00.000Z") });
    const repo = makeRepo();

    const first = await repo.listQueueHealthSignal({
      ...HEALTH_ARGS,
      signal: "degradedRecent",
      limit: 2,
    });
    expect(first.items.map((i) => i.storageKey)).toEqual(["f3", "f2"]);
    expect(first.nextCursor).toBe("f2"); // seed() uses the key as the id

    const second = await repo.listQueueHealthSignal({
      ...HEALTH_ARGS,
      signal: "degradedRecent",
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((i) => i.storageKey)).toEqual(["f1"]);
    expect(second.nextCursor).toBeNull();
  });

  test("degradedExhausted sorts a NULL moderatedAt LAST, not first", async () => {
    // This is the one bucket whose predicate has no `moderatedAt` clause (it
    // selects on `requeues >= cap`), so a null-moderatedAt row IS selectable.
    // Postgres `ORDER BY ... DESC` defaults to NULLS FIRST, which would float
    // that row above every real verdict and break keyset pagination against it.
    // Fixed in the orderBy only — putting a not-null clause in the shared
    // `queueHealthWhere` would change what the hourly Discord alert counts.
    await seed("exhausted-dated", {
      requeues: 3,
      moderatedAt: new Date("2026-08-19T00:00:00.000Z"),
    });
    await seed("exhausted-nulldate", { requeues: 3, moderatedAt: null });

    const repo = makeRepo();
    const page = await repo.listQueueHealthSignal({
      ...HEALTH_ARGS,
      signal: "degradedExhausted",
      limit: 30,
    });

    expect(page.items.map((i) => i.storageKey)).toEqual([
      "exhausted-dated",
      "exhausted-nulldate",
    ]);
    // And the count still sees both — the ordering fix must not have narrowed
    // the selection.
    expect((await repo.countQueueHealth(HEALTH_ARGS)).degradedExhausted).toBe(2);
  });

  test("returns an empty page, not an error, for a bucket with nothing in it", async () => {
    const page = await makeRepo().listQueueHealthSignal({
      ...HEALTH_ARGS,
      signal: "orphanedRecent",
      limit: 30,
    });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // markOrphaned — the record outlived its object (Sentry HEARTH-FIRE-WEB-20).
  //
  // Against real SQL because every claim here is a property of the statement,
  // not of the call: that the row leaves PENDING (so no drain reclaims it),
  // that it never reaches the moderator queue, that it stays out of the
  // requeue-degraded selection, and that a late write cannot clobber a human.
  // ───────────────────────────────────────────────────────────────────────────

  test("markOrphaned terminally resolves a PENDING row with no verdict", async () => {
    const repo = makeRepo();
    const key = "events/e4/hero.jpg";

    await repo.create({
      storageKey: key,
      kind: "EVENT_HERO",
      subjectType: "EVENT",
      subjectId: "e4",
    });

    await repo.markOrphaned({
      storageKey: key,
      resolvedAt: new Date("2026-09-08T10:00:00.000Z"),
      lastError: "object_not_found",
    });

    const after = await repo.getByKey(key);
    expect(after?.status).toBe("ORPHANED");
    expect(after?.lastError).toBe("object_not_found");
    expect(after?.moderatedAt).not.toBeNull();

    // No bytes were read, so NO verdict may exist on the row. `degraded` in
    // particular must stay false — a degraded orphan would be eligible for
    // requeueDegraded and would restart the churn loop this fix ends.
    expect(after?.maxSeverity).toBeNull();
    expect(after?.categories).toBeNull();
    expect(after?.provider).toBeNull();
    expect(after?.degraded).toBe(false);

    // A resolution, not a failed try: the attempt budget is untouched.
    expect(after?.attempts).toBe(0);
  });

  test("an ORPHANED row never appears in the moderator queue", async () => {
    const repo = makeRepo();

    await repo.create({
      storageKey: "events/e5/gone.jpg",
      kind: "EVENT_HERO",
      subjectType: "EVENT",
      subjectId: "e5",
    });
    await repo.markOrphaned({
      storageKey: "events/e5/gone.jpg",
      resolvedAt: new Date("2026-09-08T10:00:00.000Z"),
      lastError: "object_not_found",
    });

    // A genuine hold, so the assertion below is about EXCLUSION and not about
    // an empty table.
    await repo.create({
      storageKey: "events/e5/real.jpg",
      kind: "EVENT_HERO",
      subjectType: "EVENT",
      subjectId: "e5",
    });
    await repo.markResult({
      storageKey: "events/e5/real.jpg",
      status: "FLAGGED",
      maxSeverity: 6,
      categories: [{ category: "HATE", severity: 6 }],
      provider: "azure-content-safety",
      degraded: false,
      moderatedAt: new Date("2026-09-08T11:00:00.000Z"),
    });

    // `listFlagged` backs BOTH /moderate/images and the ModerateShell nav badge
    // count, so this one assertion covers both surfaces.
    const page = await repo.listFlagged({ limit: 30 });
    expect(page.items.map((i) => i.storageKey)).toEqual(["events/e5/real.jpg"]);
  });

  test("an ORPHANED row is never revived by requeueDegraded", async () => {
    const repo = makeRepo();
    const key = "events/e6/gone.jpg";

    await repo.create({ storageKey: key, kind: "EVENT_HERO" });
    await repo.markOrphaned({
      storageKey: key,
      resolvedAt: new Date("2026-08-19T00:00:00.000Z"),
      lastError: "object_not_found",
    });

    const moved = await repo.requeueDegraded({
      now: new Date("2026-08-20T18:00:00.000Z"),
      limit: 100,
      moderatedBefore: new Date("2026-08-20T17:45:00.000Z"),
      maxRequeues: 3,
    });

    expect(moved).toBe(0);
    expect((await repo.getByKey(key))?.status).toBe("ORPHANED");
  });

  test("markOrphaned is PENDING-scoped: it cannot clobber a human decision", async () => {
    const repo = makeRepo();
    const key = "events/e7/hero.jpg";

    const created = await repo.create({ storageKey: key, kind: "EVENT_HERO" });
    await repo.markResult({
      storageKey: key,
      status: "FLAGGED",
      maxSeverity: 4,
      categories: [{ category: "VIOLENCE", severity: 4 }],
      provider: "azure-content-safety",
      degraded: false,
      moderatedAt: new Date("2026-09-08T10:00:00.000Z"),
    });
    await repo.review({
      id: created.id,
      status: "APPROVED",
      reviewedByHumanId: "mod-1",
      reviewedAt: new Date("2026-09-08T11:00:00.000Z"),
    });

    // A slow overlapping drain run arrives late with an orphan verdict. The
    // object may have been deleted BECAUSE a moderator rejected a sibling, but
    // either way a machine write must not overwrite a human decision.
    await repo.markOrphaned({
      storageKey: key,
      resolvedAt: new Date("2026-09-08T12:00:00.000Z"),
      lastError: "object_not_found",
    });

    const after = await repo.getByKey(key);
    expect(after?.status).toBe("APPROVED");
    expect(after?.reviewedByHumanId).toBe("mod-1");
  });

  test("markOrphaned removedOnPurpose resolves the row but leaves it out of orphanedRecent", async () => {
    // A place page image deleted on purpose before its scan (moderate-image.ts
    // isRemovedPageImage) is not a storage fault: no `moderatedAt`, so the
    // storage-fault signal, which counts by it, does not see it.
    const repo = makeRepo();
    const key = "entity-pages/place/p1/2026-10-16/" + "a".repeat(32) + ".jpg";
    await repo.create({
      storageKey: key,
      kind: "PAGE_MEDIA",
      subjectType: "PLACE",
      subjectId: "p1",
    });
    await repo.markOrphaned({
      storageKey: key,
      resolvedAt: new Date("2026-08-20T17:00:00.000Z"),
      lastError: "removed_before_scan: object_not_found",
      removedOnPurpose: true,
    });

    const after = await repo.getByKey(key);
    expect(after?.status).toBe("ORPHANED");
    expect(after?.moderatedAt).toBeNull();
    expect(after?.lastError).toBe("removed_before_scan: object_not_found");
    expect((await repo.countQueueHealth(HEALTH_ARGS)).orphanedRecent).toBe(0);
  });

  test("markOrphaned on a vanished row is a silent no-op", async () => {
    await expect(
      makeRepo().markOrphaned({
        storageKey: "events/never/existed.jpg",
        resolvedAt: new Date("2026-09-08T10:00:00.000Z"),
        lastError: "object_not_found",
      }),
    ).resolves.toBeUndefined();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // countQueueTotals — the ALL-TIME counterparts to two windowed tiles.
  // ───────────────────────────────────────────────────────────────────────────

  test("counts every un-reviewed hold and every orphan, regardless of age", async () => {
    // THE comprehension trap: `awaitingReview` only counts holds older than the
    // cutoff, so six images flagged this morning read as 0 while six people
    // wait. Same for `orphanedRecent` against a table that only ever grows.
    await seed("hold-old", {
      degraded: false,
      moderatedAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    await seed("hold-fresh", {
      degraded: false,
      // INSIDE the 24h cutoff — invisible to `awaitingReview`.
      moderatedAt: new Date("2026-08-20T17:59:00.000Z"),
    });
    await seed("orphan-old", {
      status: "ORPHANED",
      degraded: false,
      maxSeverity: null,
      moderatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await seed("orphan-fresh", {
      status: "ORPHANED",
      degraded: false,
      maxSeverity: null,
      moderatedAt: new Date("2026-08-20T17:30:00.000Z"),
    });

    const repo = makeRepo();
    const health = await repo.countQueueHealth(HEALTH_ARGS);
    const totals = await repo.countQueueTotals();

    // The windowed tiles see one of each...
    expect(health.awaitingReview).toBe(1);
    expect(health.orphanedRecent).toBe(1);
    // ...the totals see both. That gap IS the feature.
    expect(totals).toEqual({ awaitingReviewAll: 2, orphanedAll: 2 });
  });

  test("the totals are a SUPERSET of the windowed counts, never a different set", async () => {
    // The relationship that matters is an inequality, and it holds because
    // these predicates DROP a clause rather than add one. A refactor that
    // "tidied" the totals into the shared `queueHealthWhere` would break this.
    await seed("a", { degraded: false, moderatedAt: new Date("2026-08-01T00:00:00.000Z") });
    await seed("b", { degraded: false, moderatedAt: new Date("2026-08-20T17:59:00.000Z") });
    await seed("c", { status: "ORPHANED", degraded: false, maxSeverity: null, moderatedAt: new Date("2026-08-20T17:59:00.000Z") });

    const repo = makeRepo();
    const health = await repo.countQueueHealth(HEALTH_ARGS);
    const totals = await repo.countQueueTotals();

    expect(totals.awaitingReviewAll).toBeGreaterThanOrEqual(
      health.awaitingReview,
    );
    expect(totals.orphanedAll).toBeGreaterThanOrEqual(health.orphanedRecent);
  });

  test("a REVIEWED hold is not awaiting anyone", async () => {
    await seed("decided", {
      status: "APPROVED",
      degraded: false,
      reviewedAt: new Date("2026-08-19T00:00:00.000Z"),
      reviewedByHumanId: "mod-1",
    });

    expect(await makeRepo().countQueueTotals()).toEqual({
      awaitingReviewAll: 0,
      orphanedAll: 0,
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // countQueueHealthByKind — the per-kind split.
  //
  // The property is not "it groups", it is that the columns SUM to the tiles.
  // Both go through `queueHealthWhere`, so anything else would mean the
  // breakdown had grown its own definition of "overdue".
  // ───────────────────────────────────────────────────────────────────────────

  test("the per-kind columns sum to the global counts, signal by signal", async () => {
    await seedOneOfEach();
    await seed("hero-extra", {
      kind: "EVENT_HERO",
      moderatedAt: new Date("2026-08-20T17:30:00.000Z"),
    });
    await seed("avatar-hold", {
      kind: "AVATAR",
      degraded: false,
      moderatedAt: new Date("2026-08-18T00:00:00.000Z"),
    });
    await seed("banner-overdue", {
      kind: "BANNER",
      status: "PENDING",
      degraded: false,
      maxSeverity: null,
      moderatedAt: null,
      nextAttemptAt: new Date("2026-08-20T16:00:00.000Z"),
    });

    const repo = makeRepo();
    const health = await repo.countQueueHealth(HEALTH_ARGS);
    const { byKind, unrecognizedKinds } = await repo.countQueueHealthByKind(
      HEALTH_ARGS,
    );

    const signals = [
      "pendingOverdue",
      "awaitingReview",
      "degradedRecent",
      "degradedExhausted",
      "orphanedRecent",
    ] as const;

    for (const signal of signals) {
      const summed =
        byKind.EVENT_HERO[signal] +
        byKind.AVATAR[signal] +
        byKind.BANNER[signal] +
        byKind.PAGE_MEDIA[signal] +
        unrecognizedKinds[signal];
      expect({ signal, summed }).toEqual({ signal, summed: health[signal] });
    }

    // And the split is actually informative, not all in one bucket.
    expect(byKind.AVATAR.awaitingReview).toBe(1);
    expect(byKind.BANNER.pendingOverdue).toBe(1);
  });

  test("is DENSE over all four kinds — a clean kind is zeroes, not absent", async () => {
    await seed("only-hero", { kind: "EVENT_HERO", requeues: 3 });

    const { byKind } = await makeRepo().countQueueHealthByKind(HEALTH_ARGS);

    expect(Object.keys(byKind).sort()).toEqual([
      "AVATAR",
      "BANNER",
      "EVENT_HERO",
      "PAGE_MEDIA",
    ]);
    expect(byKind.PAGE_MEDIA).toEqual({
      pendingOverdue: 0,
      awaitingReview: 0,
      degradedRecent: 0,
      degradedExhausted: 0,
      orphanedRecent: 0,
    });
    expect(byKind.EVENT_HERO.degradedExhausted).toBe(1);
  });

  test("a kind outside the four lands in `unrecognizedKinds`, not on the floor", async () => {
    // `kind` is an app-validated String, not a Prisma enum, so this row is
    // representable. Dropping it would make the columns quietly fail to sum to
    // the tile, and the discrepancy would read as a counting bug rather than
    // the data-quality finding it is.
    await seed("legacy-kind", { kind: "POSTER_LEGACY", requeues: 3 });

    const { byKind, unrecognizedKinds } = await makeRepo().countQueueHealthByKind(
      HEALTH_ARGS,
    );

    expect(unrecognizedKinds.degradedExhausted).toBe(1);
    expect(byKind.EVENT_HERO.degradedExhausted).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // countSeverityHistogram — aggregate only.
  // ───────────────────────────────────────────────────────────────────────────

  const HISTOGRAM_ARGS = {
    moderatedSince: new Date("2026-08-01T00:00:00.000Z"),
    moderatedBefore: new Date("2026-09-01T00:00:00.000Z"),
  };

  test("buckets scored rows by severity, ascending", async () => {
    await seed("s6-a", { maxSeverity: 6, moderatedAt: new Date("2026-08-10T00:00:00.000Z") });
    await seed("s6-b", { maxSeverity: 6, moderatedAt: new Date("2026-08-11T00:00:00.000Z") });
    await seed("s4", { maxSeverity: 4, moderatedAt: new Date("2026-08-12T00:00:00.000Z") });
    await seed("s0", { maxSeverity: 0, status: "APPROVED", degraded: false, moderatedAt: new Date("2026-08-13T00:00:00.000Z") });

    expect(await makeRepo().countSeverityHistogram(HISTOGRAM_ARGS)).toEqual([
      { severity: 0, count: 1 },
      { severity: 4, count: 1 },
      { severity: 6, count: 2 },
    ]);
  });

  test("EXCLUDES rows that were never scored — no phantom null bucket", async () => {
    // PENDING rows have no score, orphans never had bytes, and a requeue clears
    // the column. Counting them would drag the distribution down and make the
    // review threshold look better placed than it is.
    await seed("never-scanned", {
      status: "PENDING",
      degraded: false,
      maxSeverity: null,
      moderatedAt: new Date("2026-08-10T00:00:00.000Z"),
    });
    await seed("orphan", {
      status: "ORPHANED",
      degraded: false,
      maxSeverity: null,
      moderatedAt: new Date("2026-08-10T00:00:00.000Z"),
    });

    expect(await makeRepo().countSeverityHistogram(HISTOGRAM_ARGS)).toEqual([]);
  });

  test("the upper bound is EXCLUSIVE so adjacent windows never double-count", async () => {
    const boundary = new Date("2026-09-01T00:00:00.000Z");
    await seed("on-the-boundary", { maxSeverity: 2, moderatedAt: boundary });
    await seed("just-inside", {
      maxSeverity: 2,
      moderatedAt: new Date("2026-08-31T23:59:59.000Z"),
    });

    const repo = makeRepo();
    const first = await repo.countSeverityHistogram(HISTOGRAM_ARGS);
    const second = await repo.countSeverityHistogram({
      moderatedSince: boundary,
      moderatedBefore: new Date("2026-10-01T00:00:00.000Z"),
    });

    expect(first).toEqual([{ severity: 2, count: 1 }]);
    expect(second).toEqual([{ severity: 2, count: 1 }]);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // resolveUnscannable — the operator's terminal resolution.
  //
  // The WHERE is the safety property. These tests are about what it REFUSES.
  // ───────────────────────────────────────────────────────────────────────────

  const RESOLVE_ARGS = {
    maxRequeues: 3,
    resolvedByHumanId: "admin-1",
    resolvedAt: new Date("2026-09-12T12:00:00.000Z"),
  };

  test("resolves an exhausted degraded row to ORPHANED and stamps the operator", async () => {
    await seed("exhausted", { requeues: 3 });

    const moved = await makeRepo().resolveUnscannable({
      id: "exhausted",
      ...RESOLVE_ARGS,
      note: "event deleted",
    });

    expect(moved).toBe(1);
    const row = await statusOf("exhausted");
    expect(row.status).toBe("ORPHANED");
    // `degraded` stays TRUE — it is the record of WHY this row ended up here,
    // and ORPHANED already excludes it from `requeueDegraded`.
    expect(row.degraded).toBe(true);
    // `moderatedAt` is LEFT ALONE so an operator's cleanup cannot trip the
    // `orphanedRecent` storage-fault alert. Read through the repo, not the raw
    // `pg` row: these columns are `timestamp WITHOUT time zone`, and node-pg
    // reinterprets them in the RUNNER's local zone, so a raw comparison is a
    // timezone assertion wearing a moderation-logic costume.
    expect((await makeRepo().getById("exhausted"))?.moderatedAt).toEqual(
      new Date("2026-08-19T00:00:00.000Z"),
    );
    // Neither counter is touched: this is a resolution, not another try.
    expect(row.attempts).toBe(5);
    expect(row.requeues).toBe(3);

    const reviewed = await pool!.query(
      `SELECT reviewed_by_human_id, reviewed_at, review_note
         FROM "image_moderation_records" WHERE id = 'exhausted'`,
    );
    expect(reviewed.rows[0].reviewed_by_human_id).toBe("admin-1");
    expect(reviewed.rows[0].review_note).toBe("event deleted");
  });

  test("CANNOT resolve a genuine CONTENT hold, however many requeues it has", async () => {
    // THE safety property of this action. A `degraded: false` FLAGGED row is an
    // image the provider actually scored at or above threshold, waiting on a
    // moderator. If this could touch it, an ops button would be a backdoor
    // around a moderation decision — the judgement would just disappear.
    await seed("content-hold", { degraded: false, requeues: 99 });

    const moved = await makeRepo().resolveUnscannable({
      id: "content-hold",
      ...RESOLVE_ARGS,
    });

    expect(moved).toBe(0);
    const row = await statusOf("content-hold");
    expect(row.status).toBe("FLAGGED");
    expect(row.degraded).toBe(false);
  });

  test("CANNOT resolve a row still inside the requeue budget", async () => {
    await seed("still-retrying", { requeues: 1 });

    expect(
      await makeRepo().resolveUnscannable({
        id: "still-retrying",
        ...RESOLVE_ARGS,
      }),
    ).toBe(0);
    expect((await statusOf("still-retrying")).status).toBe("FLAGGED");
  });

  test("CANNOT resolve an APPROVED or REJECTED terminal row", async () => {
    await seed("approved", {
      status: "APPROVED",
      degraded: false,
      requeues: 9,
      reviewedAt: new Date("2026-08-19T00:00:00.000Z"),
    });
    await seed("rejected", {
      status: "REJECTED",
      degraded: false,
      requeues: 9,
      reviewedAt: new Date("2026-08-19T00:00:00.000Z"),
    });

    const repo = makeRepo();
    expect(
      await repo.resolveUnscannable({ id: "approved", ...RESOLVE_ARGS }),
    ).toBe(0);
    expect(
      await repo.resolveUnscannable({ id: "rejected", ...RESOLVE_ARGS }),
    ).toBe(0);
  });

  test("is idempotent — the second click affects nothing", async () => {
    await seed("twice", { requeues: 3 });
    const repo = makeRepo();

    expect(await repo.resolveUnscannable({ id: "twice", ...RESOLVE_ARGS })).toBe(1);
    expect(
      await repo.resolveUnscannable({
        id: "twice",
        ...RESOLVE_ARGS,
        resolvedByHumanId: "admin-2",
      }),
    ).toBe(0);
    // The FIRST operator stays on the row.
    const reviewed = await pool!.query(
      `SELECT reviewed_by_human_id FROM "image_moderation_records" WHERE id = 'twice'`,
    );
    expect(reviewed.rows[0].reviewed_by_human_id).toBe("admin-1");
  });

  test("two concurrent resolutions produce exactly one transition", async () => {
    await seed("race-resolve", { requeues: 3 });
    const repo = makeRepo();

    const [a, b] = await Promise.all([
      repo.resolveUnscannable({ id: "race-resolve", ...RESOLVE_ARGS }),
      repo.resolveUnscannable({ id: "race-resolve", ...RESOLVE_ARGS }),
    ]);

    expect(a + b).toBe(1);
  });

  test("leaves the record OUT of degradedExhausted once resolved", async () => {
    await seed("clears-tile", { requeues: 3 });
    const repo = makeRepo();
    expect((await repo.countQueueHealth(HEALTH_ARGS)).degradedExhausted).toBe(1);

    await repo.resolveUnscannable({ id: "clears-tile", ...RESOLVE_ARGS });

    expect((await repo.countQueueHealth(HEALTH_ARGS)).degradedExhausted).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // requeueForRescan — the operator's re-scan. Machine states only.
  // ───────────────────────────────────────────────────────────────────────────

  const RESCAN_NOW = new Date("2026-09-12T12:00:00.000Z");

  test("REFUSES to re-scan a REJECTED record — that would revive a human decision", async () => {
    // A clean re-score lands on APPROVED, which read-time gating passes. An ops
    // button must not be able to put rejected content back into circulation.
    await seed("rejected-row", {
      status: "REJECTED",
      degraded: false,
      reviewedAt: new Date("2026-08-19T00:00:00.000Z"),
      reviewedByHumanId: "mod-1",
    });

    const moved = await makeRepo().requeueForRescan({
      id: "rejected-row",
      now: RESCAN_NOW,
    });

    expect(moved).toBe(0);
    const row = await statusOf("rejected-row");
    expect(row.status).toBe("REJECTED");
  });

  test("REFUSES to re-scan an APPROVED record", async () => {
    await seed("approved-row", {
      status: "APPROVED",
      degraded: false,
      reviewedAt: new Date("2026-08-19T00:00:00.000Z"),
    });

    expect(
      await makeRepo().requeueForRescan({ id: "approved-row", now: RESCAN_NOW }),
    ).toBe(0);
    expect((await statusOf("approved-row")).status).toBe("APPROVED");
  });

  test("REFUSES to re-scan a FLAGGED CONTENT hold (degraded:false)", async () => {
    // FLAGGED alone decides nothing: degraded means the scanner broke
    // (rescannable), not-degraded means the provider scored it and a moderator
    // owns the decision. Re-scanning the latter clears the verdict out from
    // under the review queue.
    await seed("content-hold-rescan", { degraded: false, maxSeverity: 6 });

    expect(
      await makeRepo().requeueForRescan({
        id: "content-hold-rescan",
        now: RESCAN_NOW,
      }),
    ).toBe(0);
    const row = await statusOf("content-hold-rescan");
    expect(row.status).toBe("FLAGGED");
    expect(row.max_severity).toBe(6);
  });

  test("re-scans a degraded FLAGGED row back to a clean PENDING", async () => {
    await seed("degraded-rescan", { requeues: 3, attempts: 22 });

    expect(
      await makeRepo().requeueForRescan({
        id: "degraded-rescan",
        now: RESCAN_NOW,
      }),
    ).toBe(1);

    const row = await statusOf("degraded-rescan");
    expect(row.status).toBe("PENDING");
    expect(row.degraded).toBe(false);
    expect(row.attempts).toBe(0);
    expect(row.max_severity).toBeNull();
    expect(row.moderated_at).toBeNull();
    // `requeues` is NOT incremented: that counter bounds the AUTOMATION's churn
    // loop, and an operator spending out of its budget would let a human
    // quietly exhaust it.
    expect(row.requeues).toBe(3);

    // Through the repo, not raw `pg` — see the timezone note above.
    const rescanned = await makeRepo().getById("degraded-rescan");
    expect(rescanned?.nextAttemptAt).toEqual(RESCAN_NOW);
    expect(rescanned?.lastError).toBeNull();
  });

  test("re-scans an ORPHANED row — the object may have come back", async () => {
    await seed("orphan-rescan", {
      status: "ORPHANED",
      degraded: false,
      maxSeverity: null,
    });

    expect(
      await makeRepo().requeueForRescan({ id: "orphan-rescan", now: RESCAN_NOW }),
    ).toBe(1);
    expect((await statusOf("orphan-rescan")).status).toBe("PENDING");
  });

  test("re-scans a PENDING row (a no-op-ish re-time), and leaves DESCRIPTIVE columns alone", async () => {
    await seed("pending-rescan", {
      status: "PENDING",
      degraded: false,
      maxSeverity: null,
      moderatedAt: null,
      kind: "AVATAR",
      subjectType: "HUMAN",
      subjectId: "human-9",
      publicUrl: "https://cdn.test/avatar.png",
      createdByHumanId: "human-9",
    });

    expect(
      await makeRepo().requeueForRescan({
        id: "pending-rescan",
        now: RESCAN_NOW,
      }),
    ).toBe(1);

    // Nothing about the OBJECT changed — only our reading of it.
    const row = await makeRepo().getById("pending-rescan");
    expect(row).toMatchObject({
      kind: "AVATAR",
      subjectType: "HUMAN",
      subjectId: "human-9",
      publicUrl: "https://cdn.test/avatar.png",
      createdByHumanId: "human-9",
      status: "PENDING",
    });
  });

  test("a vanished row is a 0-row no-op, not a throw", async () => {
    expect(
      await makeRepo().requeueForRescan({ id: "nope", now: RESCAN_NOW }),
    ).toBe(0);
  });
});
