import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makePlacesRepo } from "../places";

// ---------------------------------------------------------------------------
// Integration coverage for PlacesRepo.listForSitemap's entity-page hydration.
//
// A place has TWO independent slugs. `Place.slug` is a multi-segment DIRECTORY
// key (`us/tn/x--a1b2c3d4e5`) that no route resolves. `EntityPage.slug` is the
// flat value `/p/[slug]` resolves on — and `/p/[slug]` has NO uuid fallback, it
// calls `notFound()`. The sitemap job used to emit `/p/{placeId}`, so every
// place URL it published 404'd.
//
// EntityPage is POLYMORPHIC (`ownerType` + `ownerId`), so there is no Prisma
// relation to `include` — the hydration is a second, chunked query keyed on
// `(ownerType, ownerId)`. That join is exactly the thing a mocked Prisma client
// cannot exercise, which is why this hits a real Postgres.
//
// Standalone DDL mirrors only the columns the query touches.
// ---------------------------------------------------------------------------

const TABLE_SQL = `
-- EVERY enum below MUST mirror packages/db/prisma/enums.prisma EXACTLY.
--
-- This is a standalone-DDL fixture, so nothing checks it against the schema.
-- All three of these had drifted: PageVisibility omitted UNLISTED, EventStatus
-- invented a HIDDEN that does not exist while dropping CANCELLED/COMPLETED/
-- ARCHIVED, and EventVisibility invented an UNLISTED. The only symptom is a
-- Postgres 22P02 the moment a test tries to use a real value — so a drifted
-- fixture silently narrows what the suite can even EXPRESS (the eligibility
-- test below could not have said "the place's only event was CANCELLED").
CREATE TYPE "PlaceStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');
CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELLED', 'COMPLETED', 'ARCHIVED');
CREATE TYPE "EventVisibility" AS ENUM ('PUBLIC', 'PRIVATE');
CREATE TYPE "PageOwnerType" AS ENUM ('HUMAN', 'ORGANIZATION', 'PLACE');
CREATE TYPE "PageVisibility" AS ENUM ('PUBLIC', 'PRIVATE', 'UNLISTED');

CREATE TABLE "Place" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "slug" TEXT,
  "status" "PlaceStatus" NOT NULL DEFAULT 'ACTIVE',
  "listed_in_directory" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Place_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Event" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "placeId" TEXT,
  "status" "EventStatus" NOT NULL DEFAULT 'DRAFT',
  "visibility" "EventVisibility" NOT NULL DEFAULT 'PUBLIC',

  CONSTRAINT "Event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Event_placeId_fkey" FOREIGN KEY ("placeId")
    REFERENCES "Place"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "EntityPage" (
  "id" TEXT NOT NULL,
  "ownerType" "PageOwnerType" NOT NULL,
  "ownerId" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "visibility" "PageVisibility" NOT NULL DEFAULT 'PUBLIC',
  "allowFollows" BOOLEAN NOT NULL DEFAULT true,
  "showFollowerCount" BOOLEAN NOT NULL DEFAULT false,
  "templateAppliedCategories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EntityPage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EntityPage_slug_key" ON "EntityPage"("slug");
CREATE UNIQUE INDEX "EntityPage_ownerType_ownerId_key"
  ON "EntityPage"("ownerType", "ownerId");
`;

describe("PlacesRepo.listForSitemap — entity-page slug (integration)", () => {
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
    await pool?.query(`TRUNCATE "Event", "EntityPage", "Place" CASCADE`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  let seq = 0;

  async function insertPlaceWithPublishedEvent(opts: {
    /** The multi-segment DIRECTORY key. Never a URL. */
    directorySlug?: string | null;
    /** The flat EntityPage slug, or null for "this venue has no page". */
    pageSlug?: string | null;
    /** Status of the place's single event. Defaults to PUBLISHED. */
    eventStatus?:
      | "DRAFT"
      | "PUBLISHED"
      | "CANCELLED"
      | "COMPLETED"
      | "ARCHIVED";
    /** Owner-set page visibility. Carried to core, which owns the policy. */
    pageVisibility?: "PUBLIC" | "PRIVATE" | "UNLISTED";
    status?: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
    published?: boolean;
  }) {
    const id = `00000000-0000-4000-8000-0000000000${String(seq++).padStart(2, "0")}`;
    await pool!.query(
      `INSERT INTO "Place" ("id", "name", "address", "slug", "status")
       VALUES ($1, $2, $3, $4, $5)`,
      [
        id,
        `Place ${id}`,
        "1 Main St",
        opts.directorySlug === undefined
          ? `us/tn/place-${id}--a1b2c3d4e5`
          : opts.directorySlug,
        opts.status ?? "ACTIVE",
      ],
    );
    await pool!.query(
      `INSERT INTO "Event" ("id", "title", "placeId", "status", "visibility")
       VALUES ($1, $2, $3, $4, 'PUBLIC')`,
      [
        `evt-${id}`,
        "Show",
        id,
        opts.eventStatus ?? (opts.published === false ? "DRAFT" : "PUBLISHED"),
      ],
    );
    if (opts.pageSlug != null) {
      await pool!.query(
        `INSERT INTO "EntityPage" ("id", "ownerType", "ownerId", "slug", "visibility")
         VALUES ($1, 'PLACE', $2, $3, $4::"PageVisibility")`,
        [`page-${id}`, id, opts.pageSlug, opts.pageVisibility ?? "PUBLIC"],
      );
    }
    return id;
  }

  test("hydrates each place's EntityPage slug as pageSlug", async () => {
    const id = await insertPlaceWithPublishedEvent({
      pageSlug: "the-basement-east-a1b2c3d4",
    });

    const repo = makePlacesRepo(prisma!);
    const rows = await repo.listForSitemap();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.placeId).toBe(id);
    expect(rows[0]!.pageSlug).toBe("the-basement-east-a1b2c3d4");
    expect(rows[0]!.pageVisibility).toBe("PUBLIC");
    // The routable slug must never be the directory key.
    expect(rows[0]!.pageSlug).not.toContain("/");
  });

  test("returns a NULL pageSlug — not the Place slug — for a venue with no entity page", async () => {
    await insertPlaceWithPublishedEvent({ pageSlug: null });

    const repo = makePlacesRepo(prisma!);
    const rows = await repo.listForSitemap();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.pageSlug).toBeNull();
    expect(rows[0]!.pageVisibility).toBeNull();
  });

  // The repo carries the FACTS (slug + visibility); core owns the policy that
  // turns them into a publishable URL. A non-PUBLIC page keeps its slug in the
  // database, which is exactly the trap — so the row must arrive labelled, not
  // pre-filtered into looking like "no page at all".
  test.each(["PRIVATE", "UNLISTED"] as const)(
    "carries a %s page's slug AND its visibility, so core can refuse to publish it",
    async (pageVisibility) => {
      await insertPlaceWithPublishedEvent({
        pageSlug: "hidden-venue-22222222",
        pageVisibility,
      });

      const repo = makePlacesRepo(prisma!);
      const rows = await repo.listForSitemap();

      expect(rows).toHaveLength(1);
      expect(rows[0]!.pageSlug).toBe("hidden-venue-22222222");
      expect(rows[0]!.pageVisibility).toBe(pageVisibility);
    },
  );

  test("never picks up another owner type's page with the same ownerId", async () => {
    const id = await insertPlaceWithPublishedEvent({ pageSlug: null });
    // A HUMAN page whose ownerId collides with the place id. The lookup is
    // keyed on (ownerType, ownerId), so this must not leak in.
    await pool!.query(
      `INSERT INTO "EntityPage" ("id", "ownerType", "ownerId", "slug")
       VALUES ('page-human-collision', 'HUMAN', $1, 'a-human-page-deadbeef')`,
      [id],
    );

    const repo = makePlacesRepo(prisma!);
    const rows = await repo.listForSitemap();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.pageSlug).toBeNull();
    expect(rows[0]!.pageVisibility).toBeNull();
  });

  test("maps every place to its OWN page across a multi-row batch", async () => {
    const a = await insertPlaceWithPublishedEvent({ pageSlug: "venue-a-1111" });
    const b = await insertPlaceWithPublishedEvent({ pageSlug: "venue-b-2222" });
    const c = await insertPlaceWithPublishedEvent({ pageSlug: null });

    const repo = makePlacesRepo(prisma!);
    const rows = await repo.listForSitemap();

    const byId = new Map(rows.map((r) => [r.placeId, r.pageSlug]));
    expect(byId.get(a)).toBe("venue-a-1111");
    expect(byId.get(b)).toBe("venue-b-2222");
    expect(byId.get(c)).toBeNull();
  });

  test("keeps the existing eligibility gate: ACTIVE places with a PUBLISHED public event", async () => {
    await insertPlaceWithPublishedEvent({ pageSlug: "listed-1111" });
    await insertPlaceWithPublishedEvent({
      pageSlug: "archived-2222",
      status: "ARCHIVED",
    });
    await insertPlaceWithPublishedEvent({
      pageSlug: "draft-only-3333",
      published: false,
    });

    const repo = makePlacesRepo(prisma!);
    const rows = await repo.listForSitemap();

    expect(rows.map((r) => r.pageSlug)).toEqual(["listed-1111"]);
  });

  // Only expressible once EventStatus mirrors the real enum — the fixture used
  // to declare a HIDDEN that does not exist and omit CANCELLED entirely.
  test.each(["CANCELLED", "COMPLETED", "ARCHIVED"] as const)(
    "a place whose only event is %s is not sitemap-eligible",
    async (eventStatus) => {
      await insertPlaceWithPublishedEvent({
        pageSlug: `only-${eventStatus.toLowerCase()}-1111`,
        eventStatus,
      });

      const repo = makePlacesRepo(prisma!);
      await expect(repo.listForSitemap()).resolves.toEqual([]);
    },
  );
});
