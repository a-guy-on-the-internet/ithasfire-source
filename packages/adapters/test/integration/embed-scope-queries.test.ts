import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makePlacesRepo } from "../../src/db/prisma/places";
import { makeEventsRepo } from "../../src/db/prisma/events";

/**
 * Integration coverage for the two repo methods behind the org/human embed
 * widget's `scope: "venues"` / `"all"`:
 *
 *   - PlacesRepo.listOwnedBySubject      — VERIFIED + non-revoked ownership gate
 *   - EventsRepo.listPublishedByPlaceIds — batched PUBLISHED + PUBLIC fan-in
 *
 * Why real Postgres and not just the mocked query-shape tests: a fake Prisma
 * accepts an INVALID query and can never prove a `where` clause actually
 * filters. `listOwnedBySubject`'s ownership predicate is a SECURITY boundary —
 * an unverified/provisional claim filed against a rival venue must NOT let the
 * claimant pull that venue's public calendar onto their own website — so it is
 * asserted against real SQL here.
 */

const FROM = new Date("2026-07-01T00:00:00.000Z");
const TO = new Date("2027-12-31T00:00:00.000Z");

describe("Prisma adapters integration – embed scope queries", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let orgId: string;
  let rivalOrgId: string;
  let humanId: string;

  const places: Record<string, string> = {};
  const events: Record<string, string> = {};

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const org = await prisma.organization.create({
        data: { name: "Dev QA Collective", slug: "dev-qa", status: "ACTIVE" },
      });
      orgId = org.id;

      const rival = await prisma.organization.create({
        data: { name: "Rival Presents", slug: "rival", status: "ACTIVE" },
      });
      rivalOrgId = rival.id;

      const human = await prisma.human.create({
        data: { name: "Ada Lovelace", status: "ACTIVE" },
      });
      humanId = human.id;

      const mkPlace = async (name: string, status = "ACTIVE") => {
        const p = await prisma.place!.create({
          data: { name, address: `${name} St`, status: status as any },
        });
        return p.id;
      };

      // Ownership matrix under test.
      places.verified = await mkPlace("Verified Room");
      places.provisional = await mkPlace("Provisional Room");
      places.revoked = await mkPlace("Revoked Room");
      places.suspended = await mkPlace("Suspended Room", "SUSPENDED");
      places.rival = await mkPlace("Rival Room");
      places.humanOwned = await mkPlace("Ada's Room");

      const mkOwnership = async (opts: {
        placeId: string;
        ownerType: "HUMAN" | "ORGANIZATION";
        ownerId: string;
        verified: boolean;
        revokedAt?: Date | null;
      }) => {
        await prisma.placeOwnership.create({
          data: {
            placeId: opts.placeId,
            ownerType: opts.ownerType as any,
            ownerId: opts.ownerId,
            verified: opts.verified,
            revokedAt: opts.revokedAt ?? null,
          },
        });
      };

      // VERIFIED + active → counts.
      await mkOwnership({
        placeId: places.verified!,
        ownerType: "ORGANIZATION",
        ownerId: orgId,
        verified: true,
      });
      // PROVISIONAL (unreviewed claim) → must NOT count.
      await mkOwnership({
        placeId: places.provisional!,
        ownerType: "ORGANIZATION",
        ownerId: orgId,
        verified: false,
      });
      // Soft-REVOKED → must NOT count.
      await mkOwnership({
        placeId: places.revoked!,
        ownerType: "ORGANIZATION",
        ownerId: orgId,
        verified: true,
        revokedAt: new Date("2026-06-01T00:00:00.000Z"),
      });
      // Verified but the PLACE is suspended → must NOT count.
      await mkOwnership({
        placeId: places.suspended!,
        ownerType: "ORGANIZATION",
        ownerId: orgId,
        verified: true,
      });
      // Someone else's venue → must NOT count.
      await mkOwnership({
        placeId: places.rival!,
        ownerType: "ORGANIZATION",
        ownerId: rivalOrgId,
        verified: true,
      });
      // Human-owned venue.
      await mkOwnership({
        placeId: places.humanOwned!,
        ownerType: "HUMAN",
        ownerId: humanId,
        verified: true,
      });

      const mkEvent = async (opts: {
        title: string;
        startsAt: Date;
        placeId?: string | null;
        status?: string;
        visibility?: string;
      }) => {
        const e = await prisma.event!.create({
          data: {
            title: opts.title,
            startsAt: opts.startsAt,
            endsAt: new Date(opts.startsAt.getTime() + 3 * 60 * 60 * 1000),
            status: (opts.status ?? "PUBLISHED") as any,
            visibility: (opts.visibility ?? "PUBLIC") as any,
            placeId: opts.placeId ?? null,
          },
        });
        return e.id;
      };

      // At the VERIFIED venue — created by a third party (no orgId), which is
      // exactly the case `scope: "venues"` exists to surface.
      events.atVerifiedLate = await mkEvent({
        title: "Foreign Show (late)",
        startsAt: new Date("2026-09-01T20:00:00.000Z"),
        placeId: places.verified,
      });
      events.atVerifiedEarly = await mkEvent({
        title: "Foreign Show (early)",
        startsAt: new Date("2026-08-01T20:00:00.000Z"),
        placeId: places.verified,
      });
      // Private / draft at the verified venue — must never surface publicly.
      events.privateAtVerified = await mkEvent({
        title: "Private Buyout",
        startsAt: new Date("2026-08-10T20:00:00.000Z"),
        placeId: places.verified,
        visibility: "PRIVATE",
      });
      events.draftAtVerified = await mkEvent({
        title: "Draft Show",
        startsAt: new Date("2026-08-11T20:00:00.000Z"),
        placeId: places.verified,
        status: "DRAFT",
      });
      // Outside the window (before `from`).
      events.tooOld = await mkEvent({
        title: "Ancient Show",
        startsAt: new Date("2026-01-01T20:00:00.000Z"),
        placeId: places.verified,
      });
      // At the provisional venue — reachable only if the gate leaks.
      events.atProvisional = await mkEvent({
        title: "Rival's Show At Claimed Room",
        startsAt: new Date("2026-08-05T20:00:00.000Z"),
        placeId: places.provisional,
      });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("embed scope queries setup failed:", error);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  // Guard against a vacuous green: this suite uses the repo's silent-skip
  // pattern, so assert up front that setup actually succeeded.
  test("setup completed (guards against a silently skipped suite)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  // ── listOwnedBySubject ─────────────────────────────────────────────────────

  describe("listOwnedBySubject", () => {
    test("returns ONLY places with verified, non-revoked, active ownership", async ({
      skip,
    }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }

      const repo = makePlacesRepo(prisma);
      const result = await repo.listOwnedBySubject({
        ownerType: "ORGANIZATION",
        ownerId: orgId,
      });

      // Verified room only: provisional / revoked / suspended / rival excluded.
      expect(result.map((p) => p.id)).toEqual([places.verified]);
    });

    test("EXCLUDES a provisional (unverified) claim — the rival-venue attack", async ({
      skip,
    }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }

      const repo = makePlacesRepo(prisma);
      const result = await repo.listOwnedBySubject({
        ownerType: "ORGANIZATION",
        ownerId: orgId,
      });

      expect(result.map((p) => p.id)).not.toContain(places.provisional);
    });

    test("EXCLUDES a soft-revoked ownership", async ({ skip }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }

      const repo = makePlacesRepo(prisma);
      const result = await repo.listOwnedBySubject({
        ownerType: "ORGANIZATION",
        ownerId: orgId,
      });

      expect(result.map((p) => p.id)).not.toContain(places.revoked);
    });

    test("EXCLUDES a non-ACTIVE place", async ({ skip }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }

      const repo = makePlacesRepo(prisma);
      const result = await repo.listOwnedBySubject({
        ownerType: "ORGANIZATION",
        ownerId: orgId,
      });

      expect(result.map((p) => p.id)).not.toContain(places.suspended);
    });

    test("resolves HUMAN ownership, and does not confuse it with ORG ownership", async ({
      skip,
    }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }

      const repo = makePlacesRepo(prisma);

      const asHuman = await repo.listOwnedBySubject({
        ownerType: "HUMAN",
        ownerId: humanId,
      });
      expect(asHuman.map((p) => p.id)).toEqual([places.humanOwned]);

      // Same id, wrong owner type → no match.
      const asOrg = await repo.listOwnedBySubject({
        ownerType: "ORGANIZATION",
        ownerId: humanId,
      });
      expect(asOrg).toEqual([]);
    });

    test("returns PlaceRecord DTOs with access lists, not raw Prisma models", async ({
      skip,
    }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }

      const repo = makePlacesRepo(prisma);
      const [place] = await repo.listOwnedBySubject({
        ownerType: "ORGANIZATION",
        ownerId: orgId,
      });

      expect(place).toBeDefined();
      expect(place!.orgIdsWithAccess).toEqual([orgId]);
      expect(place!.humanIdsWithAccess).toEqual([]);
      expect(place).not.toHaveProperty("ownerships");
    });
  });

  // ── listPublishedByPlaceIds ────────────────────────────────────────────────

  describe("listPublishedByPlaceIds", () => {
    test("returns PUBLISHED + PUBLIC events across places, chronologically", async ({
      skip,
    }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }

      const repo = makeEventsRepo(prisma);
      const result = await repo.listPublishedByPlaceIds({
        placeIds: [places.verified!, places.provisional!],
        from: FROM,
        to: TO,
        status: "upcoming",
      });

      const ids = result.map((e) => e.id);
      // Ascending by startsAt.
      expect(ids).toEqual([
        events.atVerifiedEarly,
        events.atProvisional,
        events.atVerifiedLate,
      ]);
    });

    test("EXCLUDES private, draft, and out-of-window events", async ({
      skip,
    }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }

      const repo = makeEventsRepo(prisma);
      const result = await repo.listPublishedByPlaceIds({
        placeIds: [places.verified!],
        from: FROM,
        to: TO,
        status: "upcoming",
      });

      const ids = result.map((e) => e.id);
      expect(ids).not.toContain(events.privateAtVerified);
      expect(ids).not.toContain(events.draftAtVerified);
      expect(ids).not.toContain(events.tooOld);
      expect(ids).toEqual([events.atVerifiedEarly, events.atVerifiedLate]);
    });

    test("returns [] for an empty placeIds without touching the DB", async ({
      skip,
    }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }

      const repo = makeEventsRepo(prisma);
      const result = await repo.listPublishedByPlaceIds({
        placeIds: [],
        from: FROM,
        to: TO,
        status: "upcoming",
      });

      expect(result).toEqual([]);
    });

    test("honors the limit cap", async ({ skip }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }

      const repo = makeEventsRepo(prisma);
      const result = await repo.listPublishedByPlaceIds({
        placeIds: [places.verified!],
        from: FROM,
        to: TO,
        status: "upcoming",
        limit: 1,
      });

      expect(result.map((e) => e.id)).toEqual([events.atVerifiedEarly]);
    });

    test("returns full EventRecord DTOs (proves the real EVENT_SELECT is valid)", async ({
      skip,
    }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }

      const repo = makeEventsRepo(prisma);
      const [event] = await repo.listPublishedByPlaceIds({
        placeIds: [places.verified!],
        from: FROM,
        to: TO,
        status: "upcoming",
      });

      expect(event).toMatchObject({
        id: events.atVerifiedEarly,
        title: "Foreign Show (early)",
        status: "PUBLISHED",
        placeId: places.verified,
      });
    });
  });

  // ── The end-to-end venue-scope shape ───────────────────────────────────────

  test("owned-venue fan-in surfaces a third party's show but not a claimed rival's", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    // Exactly what resolveVenueEvents does: owned places → batched event fan-in.
    const placesRepo = makePlacesRepo(prisma);
    const eventsRepo = makeEventsRepo(prisma);

    const owned = await placesRepo.listOwnedBySubject({
      ownerType: "ORGANIZATION",
      ownerId: orgId,
      limit: 50,
    });
    const result = await eventsRepo.listPublishedByPlaceIds({
      placeIds: owned.map((p) => p.id),
      from: FROM,
      to: TO,
      status: "upcoming",
      limit: 200,
    });

    const ids = result.map((e) => e.id);
    // A show at OUR verified room, created by someone else → included.
    expect(ids).toContain(events.atVerifiedEarly);
    // A show at a room we only PROVISIONALLY claimed → excluded.
    expect(ids).not.toContain(events.atProvisional);
    // Private/draft never leak.
    expect(ids).not.toContain(events.privateAtVerified);
    expect(ids).not.toContain(events.draftAtVerified);
  });
});
