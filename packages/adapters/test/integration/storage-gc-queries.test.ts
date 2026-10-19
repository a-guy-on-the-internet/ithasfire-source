import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeImagesRepo } from "../../src/db/prisma/images";
import { makeEventsRepo } from "../../src/db/prisma/events";
import { makeEventEditSuggestionsRepo } from "../../src/db/prisma/event-edit-suggestions";
import { makeJobCursorsRepo } from "../../src/db/prisma/job-cursors";

/**
 * The three queries behind the storage GC, exercised against a real Postgres.
 *
 * These decide whether a blob is permanently deleted from R2, so "it
 * typechecks" is not adequate evidence — a wrong predicate here destroys a
 * customer's images, which is exactly what the `attached: false` version did in
 * production on 2026-08-08. Every assertion below is about the ROWS the
 * database actually returns.
 */
describe("Prisma adapters integration – storage GC queries", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  // Set when the integration environment fails to come up, so the canary
  // below reports THAT instead of a bare ReferenceError. Mirrors the 36
  // sibling suites; this file and storage-gc-queries were the two that
  // got the canary without the variable it asserts on.
  let runtimeError: Error | null = null;
  /** Container/migrate could not start — no Docker. Legitimate skip. */
  let containerError: Error | null = null;
  /**
   * The container came up but building the fixtures threw. That is a REAL
   * failure and must not masquerade as a skip — a silently-skipped suite is
   * how a GC test suite ends up proving nothing at all.
   */
  let fixtureError: Error | null = null;

  let eventId = "";
  let otherEventId = "";
  let humanId = "";

  // Image ids, all created with the DEFAULT `attached: false` — i.e. exactly
  // the state every real organizer upload is in.
  let heroImageId = "";
  let bodyImageId = "";
  let orphanImageId = "";
  let freshImageId = "";
  let softDeletedImageId = "";
  let unfinalizedHeroEventId = "";

  const OLD = new Date("2026-01-01T00:00:00.000Z");
  const CUTOFF = new Date("2026-06-01T00:00:00.000Z");
  const FRESH = new Date("2026-07-01T00:00:00.000Z");

  async function makeImage(
    key: string,
    createdAt: Date,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const img = await prisma!.image.create({
      data: {
        ownerType: "EVENT",
        ownerId: eventId,
        eventId,
        key,
        publicUrl: `https://cdn.example.com/${key}`,
        uploadedAt: createdAt,
        createdByHumanId: humanId,
        // Explicit so the keyset-cursor assertions have deterministic ordering
        // (the column has @default(now())).
        createdAt,
        // `attached` deliberately left at its default (false) — the state every
        // real organizer upload is in.
        ...extra,
      },
    });
    return img.id;
  }

  beforeAll(async () => {
    try {
      // ONLY the container start may be classified as "no Docker". A failing
      // migration or client construction is a REAL failure and must not skip.
      try {
        pg = await startPostgresContainer();
      } catch (error) {
        containerError = error as Error;
        return;
      }

      try {
        await runPrismaMigrateDeploy(pg.databaseUrl);
        process.env.DATABASE_URL = pg.databaseUrl;
        pool = new Pool({ connectionString: pg.databaseUrl });
        prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

        const human = await prisma.human.create({
          data: { name: "GC Tester", status: "ACTIVE" },
        });
        humanId = human.id;

        const event = await prisma.event.create({
          data: {
            title: "GC Event",
            startsAt: new Date("2026-08-01T20:00:00.000Z"),
            endsAt: new Date("2026-08-01T23:00:00.000Z"),
            status: "PUBLISHED",
            humanId: human.id,
          },
        });
        eventId = event.id;

        const other = await prisma.event.create({
          data: {
            title: "GC Event Without Media",
            startsAt: new Date("2026-08-02T20:00:00.000Z"),
            endsAt: new Date("2026-08-02T23:00:00.000Z"),
            status: "PUBLISHED",
            humanId: human.id,
          },
        });
        otherEventId = other.id;

        heroImageId = await makeImage("events/gc/hero.jpg", OLD);
        bodyImageId = await makeImage("events/gc/body.jpg", OLD);
        orphanImageId = await makeImage("events/gc/orphan.jpg", OLD);
        freshImageId = await makeImage("events/gc/fresh.jpg", FRESH);
        softDeletedImageId = await makeImage("events/gc/gone.jpg", OLD, {
          deletedAt: new Date("2026-02-01T00:00:00.000Z"),
        });

        // An event whose hero points at a REQUESTED-but-never-finalized upload:
        // `requestEventImageUpload` creates the row with publicUrl "" and
        // uploadedAt null, and the builder save path accepts any uuid.
        const unfinalizedEvent = await prisma.event.create({
          data: {
            title: "GC Event With Unfinalized Hero",
            startsAt: new Date("2026-08-03T20:00:00.000Z"),
            endsAt: new Date("2026-08-03T23:00:00.000Z"),
            status: "PUBLISHED",
            humanId: human.id,
          },
        });
        unfinalizedHeroEventId = unfinalizedEvent.id;
        const unfinalized = await prisma.image.create({
          data: {
            ownerType: "EVENT",
            ownerId: unfinalizedEvent.id,
            eventId: unfinalizedEvent.id,
            key: "events/gc/pending.jpg",
            publicUrl: "",
            uploadedAt: null,
            createdAt: OLD,
            createdByHumanId: human.id,
          },
        });
        await prisma.event.update({
          where: { id: unfinalizedEvent.id },
          data: { heroImageId: unfinalized.id },
        });

        await prisma.event.update({
          where: { id: eventId },
          data: {
            heroImageId,
            body: {
              sections: [
                {
                  layout: {
                    columns: [
                      {
                        blocks: [
                          { type: "image", asset: { assetId: bodyImageId } },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          },
        });
      } catch (error) {
        fixtureError = error as Error;
        // eslint-disable-next-line no-console
        console.error("storage-gc-queries fixture setup failed:", error);
      }
      // Generous: container pull + `prisma migrate deploy` on a cold cache can
      // run several minutes on a loaded machine.
    } catch (error) {
      runtimeError = error as Error;
    }
  }, 600_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    // Stopping the container routinely exceeds vitest's 10s default hook
    // timeout, which fails the SUITE after every test has already passed.
    if (pg) await pg.stop();
  }, 120_000);

  test("integration environment is up (canary — do not skip)", ({ skip }) => {
    if (containerError) {
      skip();
      return;
    }
    expect(fixtureError).toBeNull();
    expect(prisma).toBeDefined();
  });

  // ── images.listSweepCandidates ─────────────────────────────────────────

  test("listSweepCandidates returns aged rows regardless of `attached`", async ({
    skip,
  }) => {
    if (containerError) {
      skip();
      return;
    }
    expect(fixtureError, "fixture setup threw — this is a real failure, not a skip").toBeNull();
    if (!prisma) throw new Error("prisma client missing");
    const repo = makeImagesRepo(prisma);

    const rows = await repo.listSweepCandidates({
      createdBefore: CUTOFF,
      limit: 100,
    });
    const ids = rows.map((r) => r.id);

    // Every one of these has attached=false — the old query would have
    // returned them too, but as "orphans" ready to delete. Here they are only
    // CANDIDATES; reachability is decided upstream.
    expect(ids).toContain(heroImageId);
    expect(ids).toContain(bodyImageId);
    expect(ids).toContain(orphanImageId);
  });

  test("listSweepCandidates excludes rows younger than the cutoff", async ({
    skip,
  }) => {
    if (containerError) {
      skip();
      return;
    }
    expect(fixtureError, "fixture setup threw — this is a real failure, not a skip").toBeNull();
    if (!prisma) throw new Error("prisma client missing");
    const rows = await makeImagesRepo(prisma).listSweepCandidates({
      createdBefore: CUTOFF,
      limit: 100,
    });
    expect(rows.map((r) => r.id)).not.toContain(freshImageId);
  });

  test("listSweepCandidates excludes already soft-deleted rows", async ({
    skip,
  }) => {
    if (containerError) {
      skip();
      return;
    }
    expect(fixtureError, "fixture setup threw — this is a real failure, not a skip").toBeNull();
    if (!prisma) throw new Error("prisma client missing");
    const rows = await makeImagesRepo(prisma).listSweepCandidates({
      createdBefore: CUTOFF,
      limit: 100,
    });
    expect(rows.map((r) => r.id)).not.toContain(softDeletedImageId);
  });

  test("listSweepCandidates honours the limit", async ({ skip }) => {
    if (containerError) {
      skip();
      return;
    }
    expect(fixtureError, "fixture setup threw — this is a real failure, not a skip").toBeNull();
    if (!prisma) throw new Error("prisma client missing");
    const rows = await makeImagesRepo(prisma).listSweepCandidates({
      createdBefore: CUTOFF,
      limit: 2,
    });
    expect(rows).toHaveLength(2);
  });

  test("listSweepCandidates advances past a keyset cursor", async ({ skip }) => {
    if (containerError) {
      skip();
      return;
    }
    expect(fixtureError, "fixture setup threw — this is a real failure, not a skip").toBeNull();
    if (!prisma) throw new Error("prisma client missing");
    const repo = makeImagesRepo(prisma);

    const first = await repo.listSweepCandidates({
      createdBefore: CUTOFF,
      limit: 1,
    });
    expect(first).toHaveLength(1);

    const second = await repo.listSweepCandidates({
      createdBefore: CUTOFF,
      limit: 1,
      after: { createdAt: first[0]!.createdAt, id: first[0]!.id },
    });

    // Without this the sweep re-reads the same retained row forever and no
    // newer orphan is ever examined.
    expect(second).toHaveLength(1);
    expect(second[0]!.id).not.toBe(first[0]!.id);
  });

  test("listSweepCandidates paging enumerates every candidate exactly once", async ({
    skip,
  }) => {
    if (containerError) {
      skip();
      return;
    }
    expect(fixtureError, "fixture setup threw — this is a real failure, not a skip").toBeNull();
    if (!prisma) throw new Error("prisma client missing");
    const repo = makeImagesRepo(prisma);

    const seen: string[] = [];
    let cursor: { createdAt: Date; id: string } | null = null;
    for (let page = 0; page < 20; page++) {
      const rows = await repo.listSweepCandidates({
        createdBefore: CUTOFF,
        limit: 1,
        after: cursor,
      });
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.id));
      const last = rows[rows.length - 1]!;
      cursor = { createdAt: last.createdAt, id: last.id };
    }

    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect(seen).toContain(heroImageId);
    expect(seen).toContain(bodyImageId);
    expect(seen).toContain(orphanImageId);
    expect(seen).not.toContain(softDeletedImageId);
    expect(seen).not.toContain(freshImageId);
  });

  // ── eventEditSuggestions.listPendingReferenceFields ────────────────────

  test("listPendingReferenceFields returns PENDING fields and ignores reviewed ones", async ({
    skip,
  }) => {
    if (containerError) {
      skip();
      return;
    }
    expect(fixtureError, "fixture setup threw — this is a real failure, not a skip").toBeNull();
    if (!prisma) throw new Error("prisma client missing");

    const pending = await prisma.eventEditSuggestion.create({
      data: {
        eventId,
        status: "PENDING",
        fields: { heroImageId: orphanImageId },
        baseVersion: {},
      },
    });
    const approved = await prisma.eventEditSuggestion.create({
      data: {
        eventId,
        status: "APPROVED",
        fields: { heroImageId: "some-approved-image" },
        baseVersion: {},
      },
    });

    try {
      const rows = await makeEventEditSuggestionsRepo(
        prisma,
      ).listPendingReferenceFields([eventId]);

      expect(rows).toHaveLength(1);
      expect(rows[0]!.eventId).toBe(eventId);
      // This is the id that must survive the sweep while review is pending.
      expect(JSON.stringify(rows[0]!.fields)).toContain(orphanImageId);
    } finally {
      await prisma.eventEditSuggestion.deleteMany({
        where: { id: { in: [pending.id, approved.id] } },
      });
    }
  });

  test("listPendingReferenceFields short-circuits on an empty id list", async ({
    skip,
  }) => {
    if (containerError) {
      skip();
      return;
    }
    expect(fixtureError, "fixture setup threw — this is a real failure, not a skip").toBeNull();
    if (!prisma) throw new Error("prisma client missing");
    expect(
      await makeEventEditSuggestionsRepo(prisma).listPendingReferenceFields([]),
    ).toEqual([]);
  });

  // ── jobCursors (the sweep's cross-run resume point) ────────────────────
  //
  // These run against real Postgres on purpose. The core tests drive a
  // `vi.fn()` fake that happily accepts any value, so they cannot see that
  // Prisma REJECTS a plain `null` for a nullable Json column — which is
  // exactly how the wrap-to-null broke without any test noticing.

  test("jobCursors round-trips a cursor value", async ({ skip }) => {
    if (containerError) {
      skip();
      return;
    }
    expect(fixtureError, "fixture setup threw — this is a real failure, not a skip").toBeNull();
    if (!prisma) throw new Error("prisma client missing");
    const repo = makeJobCursorsRepo(prisma);

    expect(await repo.get("test.cursor.roundtrip")).toBeNull();

    await repo.set("test.cursor.roundtrip", {
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "img-1",
    });

    expect(await repo.get("test.cursor.roundtrip")).toEqual({
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "img-1",
    });
  });

  test("jobCursors CLEARS a cursor to null without throwing", async ({
    skip,
  }) => {
    if (containerError) {
      skip();
      return;
    }
    expect(fixtureError, "fixture setup threw — this is a real failure, not a skip").toBeNull();
    if (!prisma) throw new Error("prisma client missing");
    const repo = makeJobCursorsRepo(prisma);

    await repo.set("test.cursor.clear", { createdAt: "x", id: "y" });
    // This is the wrap-to-start path. A plain `null` here throws
    // PrismaClientValidationError; it needs Prisma.DbNull.
    await expect(repo.set("test.cursor.clear", null)).resolves.toBeUndefined();
    expect(await repo.get("test.cursor.clear")).toBeNull();
  });

  test("jobCursors does NOT disturb the `enabled` kill switch", async ({
    skip,
  }) => {
    if (containerError) {
      skip();
      return;
    }
    expect(fixtureError, "fixture setup threw — this is a real failure, not a skip").toBeNull();
    if (!prisma) throw new Error("prisma client missing");
    const repo = makeJobCursorsRepo(prisma);

    // An operator has disabled the job.
    await prisma.jobState.upsert({
      where: { jobName: "test.cursor.enabled" },
      create: { jobName: "test.cursor.enabled", enabled: false },
      update: { enabled: false },
    });

    await repo.set("test.cursor.enabled", { createdAt: "x", id: "y" });
    await repo.set("test.cursor.enabled", null);

    const row = await prisma.jobState.findUnique({
      where: { jobName: "test.cursor.enabled" },
    });
    // Silently re-enabling a job someone turned off would be its own incident.
    expect(row?.enabled).toBe(false);
  });

  // ── events.listMediaReferenceSets ──────────────────────────────────────

  test("listMediaReferenceSets returns the raw hero FK and body JSON", async ({
    skip,
  }) => {
    if (containerError) {
      skip();
      return;
    }
    expect(fixtureError, "fixture setup threw — this is a real failure, not a skip").toBeNull();
    if (!prisma) throw new Error("prisma client missing");
    const sets = await makeEventsRepo(prisma).listMediaReferenceSets([eventId]);

    expect(sets).toHaveLength(1);
    expect(sets[0]!.eventId).toBe(eventId);
    expect(sets[0]!.heroImageId).toBe(heroImageId);
    // The body must survive the round-trip intact — the GC walks it.
    expect(JSON.stringify(sets[0]!.bodies)).toContain(bodyImageId);
    // Every JSON column that could mention an image id is carried, not just
    // the builder body.
    expect(sets[0]!.bodies.length).toBeGreaterThanOrEqual(2);
  });

  test("listMediaReferenceSets returns nulls for an event with no media", async ({
    skip,
  }) => {
    if (containerError) {
      skip();
      return;
    }
    expect(fixtureError, "fixture setup threw — this is a real failure, not a skip").toBeNull();
    if (!prisma) throw new Error("prisma client missing");
    const sets = await makeEventsRepo(prisma).listMediaReferenceSets([
      otherEventId,
    ]);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.eventId).toBe(otherEventId);
    expect(sets[0]!.heroImageId).toBeNull();
    expect(sets[0]!.bodies.every((b) => b === null)).toBe(true);
  });

  test("listMediaReferenceSets OMITS unknown event ids rather than inventing empties", async ({
    skip,
  }) => {
    if (containerError) {
      skip();
      return;
    }
    expect(fixtureError, "fixture setup threw — this is a real failure, not a skip").toBeNull();
    if (!prisma) throw new Error("prisma client missing");
    const missing = "00000000-0000-4000-8000-000000000000";
    const sets = await makeEventsRepo(prisma).listMediaReferenceSets([
      eventId,
      missing,
    ]);

    // This is the contract the sweep depends on: a missing event must be
    // ABSENT, so the caller can tell "no references" from "could not read",
    // and skip the delete in the second case.
    expect(sets.map((s) => s.eventId)).toEqual([eventId]);
  });

  test("listMediaReferenceSets short-circuits on an empty id list", async ({
    skip,
  }) => {
    if (containerError) {
      skip();
      return;
    }
    expect(fixtureError, "fixture setup threw — this is a real failure, not a skip").toBeNull();
    if (!prisma) throw new Error("prisma client missing");
    expect(await makeEventsRepo(prisma).listMediaReferenceSets([])).toEqual([]);
  });

  // ── images.getPrimaryImageRefs ─────────────────────────────────────────

  test("getPrimaryImageRefs resolves the hero even though attached is false", async ({
    skip,
  }) => {
    if (containerError) {
      skip();
      return;
    }
    expect(fixtureError, "fixture setup threw — this is a real failure, not a skip").toBeNull();
    if (!prisma) throw new Error("prisma client missing");
    // The second production bug: this query filtered `attached: true`, so for
    // every real event it returned NOTHING and search cards / gated previews
    // silently lost their image.
    const refs = await makeImagesRepo(prisma).getPrimaryImageRefs([eventId]);

    expect(refs.get(eventId)).toEqual({
      publicUrl: `https://cdn.example.com/events/gc/hero.jpg`,
      key: "events/gc/hero.jpg",
    });
  });

  test("getPrimaryImageRefs omits an unfinalized hero rather than serving an empty url", async ({
    skip,
  }) => {
    if (containerError) {
      skip();
      return;
    }
    expect(fixtureError, "fixture setup threw — this is a real failure, not a skip").toBeNull();
    if (!prisma) throw new Error("prisma client missing");

    const refs = await makeImagesRepo(prisma).getPrimaryImageRefs([
      unfinalizedHeroEventId,
    ]);

    // publicUrl is "" until finalize; surfacing it would render a broken image
    // on search cards and the gated preview.
    expect(refs.has(unfinalizedHeroEventId)).toBe(false);
  });

  test("getPrimaryImageRefs omits an event with no hero", async ({ skip }) => {
    if (containerError) {
      skip();
      return;
    }
    expect(fixtureError, "fixture setup threw — this is a real failure, not a skip").toBeNull();
    if (!prisma) throw new Error("prisma client missing");
    const refs = await makeImagesRepo(prisma).getPrimaryImageRefs([
      otherEventId,
    ]);
    expect(refs.has(otherEventId)).toBe(false);
  });

  test("getPrimaryImageRefs treats a soft-deleted hero as no hero", async ({
    skip,
  }) => {
    if (containerError) {
      skip();
      return;
    }
    expect(fixtureError, "fixture setup threw — this is a real failure, not a skip").toBeNull();
    if (!prisma) throw new Error("prisma client missing");
    const repo = makeImagesRepo(prisma);
    await prisma.image.update({
      where: { id: heroImageId },
      data: { deletedAt: new Date() },
    });

    try {
      const refs = await repo.getPrimaryImageRefs([eventId]);
      expect(refs.has(eventId)).toBe(false);
    } finally {
      await prisma.image.update({
        where: { id: heroImageId },
        data: { deletedAt: null },
      });
    }
  });

  test("getPrimaryImageRefs short-circuits on an empty id list", async ({
    skip,
  }) => {
    if (containerError) {
      skip();
      return;
    }
    expect(fixtureError, "fixture setup threw — this is a real failure, not a skip").toBeNull();
    if (!prisma) throw new Error("prisma client missing");
    expect(
      (await makeImagesRepo(prisma).getPrimaryImageRefs([])).size,
    ).toBe(0);
  });
});
