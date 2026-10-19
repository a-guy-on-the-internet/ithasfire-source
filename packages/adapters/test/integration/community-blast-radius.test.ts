import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEventsRepo } from "../../src/db/prisma/events";
import { makeOrdersRepo } from "../../src/db/prisma/orders";
import { makeAnalyticsRepo } from "../../src/db/prisma/analytics";

/**
 * Blast-radius integration test for community-managed listings (spec
 * 2026-07-01, FR-011 / FR-012 / HIGH-severity Model-A risk).
 *
 * Model A puts ownerless COMMUNITY rows in the SAME Event table as owned,
 * money-bearing events. This suite proves — against a real Postgres with the
 * real migrations — that a PUBLISHED COMMUNITY event:
 *
 *  1. IS first-class in every public discovery/search/detail read
 *     (no owner assumed, no NPE), and
 *  2. is INVISIBLE to every owner-scoped query (dashboards, "my events",
 *     org/human order lists, org analytics aggregates), and
 *  3. can never be referenced by the money pipeline (check constraint +
 *     order-derived settlement construction).
 *
 * Use-case-level guards (EVENT_NOT_TICKETED on checkout/ticket-types/publish,
 * direct-edit rejection, FR-008 review authz) are covered separately in
 * packages/core: orders/__tests__/rsvp-event-guards.test.ts,
 * ticket-types/__tests__/upsert-ticket-type-rsvp-guard.test.ts,
 * events/__tests__/publish-event-rsvp-guard.test.ts,
 * events/__tests__/community-direct-edit-guard.test.ts,
 * resale/__tests__/create-resale-checkout-rsvp-guard.test.ts and
 * community/__tests__/{submit,review}-event-edit-suggestion.test.ts.
 */

const STARTS_AFTER = new Date("2027-01-01T00:00:00.000Z");
const EVENT_STARTS_AT = new Date("2027-06-01T20:00:00.000Z");
const EVENT_ENDS_AT = new Date("2027-06-01T23:00:00.000Z");
const CATEGORY_SLUG = "blast-radius-open-mics";
const REGION_CODE = "us-tx"; // stored lowercase; queries normalize input
const COMMUNITY_TITLE = "Blast Radius Community Open Mic";
const COMMUNITY_SLUG =
  "event/us/austin/blast-radius-community-open-mic-2027-06-01-2000--brc123";

describe("Prisma adapters integration – community blast radius", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let orgId: string;
  let ownerHumanId: string;
  let buyerHumanId: string;
  let categoryId: string;
  let communityEventId: string;
  let orgEventId: string;
  let humanEventId: string;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      // The repo's Prisma client runs in driver-adapter ("client" engine)
      // mode, so a bare `new PrismaClient()` throws — construct it the way
      // packages/db/src/index.ts does, with a pg Pool adapter.
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const org = await prisma.organization.create({
        data: { name: "Blast Radius Collective", slug: "blast-radius-co" },
      });
      orgId = org.id;

      const owner = await prisma.human.create({
        data: { name: "Personal Owner", status: "ACTIVE" },
      });
      ownerHumanId = owner.id;

      const buyer = await prisma.human.create({
        data: { name: "Ticket Buyer", status: "ACTIVE" },
      });
      buyerHumanId = buyer.id;

      const category = await prisma.category.create({
        data: { slug: CATEGORY_SLUG, name: "Blast Radius Open Mics" },
      });
      categoryId = category.id;

      // One PUBLISHED event per ownership shape, all sharing the same
      // category / region / country so every discovery query sees all three.
      const orgEvent = await prisma.event.create({
        data: {
          title: "Blast Radius Org Gala",
          startsAt: EVENT_STARTS_AT,
          endsAt: EVENT_ENDS_AT,
          status: "PUBLISHED",
          visibility: "PUBLIC",
          orgId,
          categoryId,
          countryCode: "US",
          regionCode: REGION_CODE,
          slug: "event/us/austin/blast-radius-org-gala-2027-06-01-2000--bro123",
          shortId: "bro123",
          publishedAt: new Date(),
        },
      });
      orgEventId = orgEvent.id;

      const humanEvent = await prisma.event.create({
        data: {
          title: "Blast Radius House Show",
          startsAt: EVENT_STARTS_AT,
          endsAt: EVENT_ENDS_AT,
          status: "PUBLISHED",
          visibility: "PUBLIC",
          humanId: ownerHumanId,
          categoryId,
          countryCode: "US",
          regionCode: REGION_CODE,
          slug: "event/us/austin/blast-radius-house-show-2027-06-01-2000--brh123",
          shortId: "brh123",
          publishedAt: new Date(),
        },
      });
      humanEventId = humanEvent.id;

      // The COMMUNITY listing goes through the REAL ownerless create path
      // (FR-005) — the same adapter method createCommunityListing uses.
      const eventsRepo = makeEventsRepo(prisma);
      const communityEvent = await eventsRepo.createCommunityListing({
        title: COMMUNITY_TITLE,
        startsAt: EVENT_STARTS_AT,
        endsAt: EVENT_ENDS_AT,
        timezone: "America/Chicago",
        addressText: "123 Main St, Austin, TX",
        countryCode: "US",
        region: "TX",
        locality: "Austin",
        postalCode: "78701",
        lat: 30.27,
        lng: -97.74,
        geohash6: "9v6kpr",
        categoryId,
        slug: COMMUNITY_SLUG,
        shortId: "brc123",
        regionCode: REGION_CODE,
        attendanceMode: "RSVP",
        stewardship: "COMMUNITY",
        status: "PUBLISHED",
        publishedAt: new Date(),
      });
      communityEventId = communityEvent.id;

      // One order per event, each carrying one pending-payout item (status
      // "active", paidOutAt null — the exact shape getPayoutSummaryFor*
      // aggregates). The COMMUNITY-event order+item are DELIBERATELY invalid
      // garbage inserted at the DB layer (production can never create them —
      // createCheckout/claimFreeTickets/updateOrderItems all fail
      // EVENT_NOT_TICKETED, covered in core) so we can prove the owner-scoped
      // order queries and payout aggregates could not surface such rows even
      // if they existed.
      for (const eventId of [orgEventId, humanEventId, communityEventId]) {
        const order = await prisma.order.create({
          data: {
            eventId,
            buyerHumanId,
            amountGrossCents: 5000,
            status: "SUCCEEDED",
            feePolicySnapshot: {},
          },
        });
        await prisma.orderItem.create({
          data: {
            orderId: order.id,
            kind: "ticket",
            qty: 1,
            unitPriceCents: 5000,
            amountCents: 5000,
          },
        });
      }

      // Same adversarial construction for the analytics rollup: give ALL
      // three events an EventDailyStats row and prove the org dashboard
      // aggregate only counts the org's own event.
      for (const eventId of [orgEventId, humanEventId, communityEventId]) {
        await prisma.eventDailyStats.create({
          data: {
            eventId,
            date: new Date("2026-07-01T00:00:00.000Z"),
            grossRevenueCents: 5000,
            netRevenueCents: 4500,
            ticketsSold: 1,
            totalCapacity: 10,
          },
        });
      }
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("community blast-radius integration setup failed:", error);
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

  // This suite is the named mitigation for the spec's #1 (HIGH) risk, so a
  // broken setup must never silently green the pipeline: in CI (where a DB is
  // guaranteed) a setup failure is real breakage and fails loudly here; the
  // per-test skip guards below only soften LOCAL runs without Docker.
  test("setup completed (loud-fail in CI)", () => {
    if (runtimeError && process.env.CI) throw runtimeError;
  });

  // ── 1. Public discovery treats the ownerless row as first-class ──────────

  test("listPublished surfaces the COMMUNITY event alongside owned events, mapped without an owner", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventsRepo(prisma);

    const page = await repo.listPublished({
      limit: 100,
      offset: 0,
      startsAfter: STARTS_AFTER,
    });
    const ids = page.items.map((e) => e.id);
    expect(ids).toEqual(
      expect.arrayContaining([communityEventId, orgEventId, humanEventId]),
    );

    const community = page.items.find((e) => e.id === communityEventId)!;
    expect(community.orgId).toBeNull();
    expect(community.humanId).toBeNull();
    expect(community.stewardship).toBe("COMMUNITY");
    expect(community.attendanceMode).toBe("RSVP");
    expect(community.visibility).toBe("PUBLIC");
    // Money fields stay unstamped — the row never met the publish pipeline.
    expect(community.payoutTermsId).toBeNull();
    expect(community.currency).toBeNull();
  }, 60_000);

  test("searchPublished, filterByCategory, listPublishedByRegion and listPublishedByCountry all return the COMMUNITY event", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventsRepo(prisma);

    const search = await repo.searchPublished({
      query: "Blast Radius Community",
      startsAfter: STARTS_AFTER,
    });
    expect(search.map((e) => e.id)).toContain(communityEventId);

    const byCategory = await repo.filterByCategory({
      categorySlug: CATEGORY_SLUG,
      startsAfter: STARTS_AFTER,
    });
    expect(byCategory.items.map((e) => e.id)).toEqual(
      expect.arrayContaining([communityEventId, orgEventId, humanEventId]),
    );

    // Region/country lookups normalize their input; prove the stored
    // community row matches through the same normalization as owned rows.
    const byRegion = await repo.listPublishedByRegion({
      regionCode: "US-TX",
      startsAfter: STARTS_AFTER,
    });
    expect(byRegion.items.map((e) => e.id)).toContain(communityEventId);

    const byCountry = await repo.listPublishedByCountry({
      countryCode: "us",
      startsAfter: STARTS_AFTER,
    });
    expect(byCountry.items.map((e) => e.id)).toContain(communityEventId);
  }, 60_000);

  test("detail reads (getById + resolveBySlug) resolve the ownerless row without NPEs", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventsRepo(prisma);

    const record = await repo.getById(communityEventId);
    expect(record).not.toBeNull();
    expect(record!.title).toBe(COMMUNITY_TITLE);
    expect(record!.orgId).toBeNull();
    expect(record!.humanId).toBeNull();
    expect(record!.slug).toBe(COMMUNITY_SLUG);
    expect(record!.heroImageUrl).toBeNull();

    const resolution = await repo.resolveBySlug(COMMUNITY_SLUG);
    expect(resolution).toEqual({
      eventId: communityEventId,
      currentSlug: COMMUNITY_SLUG,
      redirect: false,
    });
  }, 60_000);

  // ── 2. Owner-scoped queries never see it ─────────────────────────────────

  test("events.listByOwner (ORGANIZATION and HUMAN) excludes the COMMUNITY event", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventsRepo(prisma);

    // Existence pin: the COMMUNITY row really is in the Event table (the
    // exclusions below must never pass vacuously after a setup refactor).
    expect(
      await prisma.event.count({
        where: { id: communityEventId, stewardship: "COMMUNITY" },
      }),
    ).toBe(1);

    const orgPage = await repo.listByOwner({
      ownerType: "ORGANIZATION",
      ownerId: orgId,
    });
    expect(orgPage.items.map((e) => e.id)).toEqual([orgEventId]);
    expect(orgPage.pageInfo.total).toBe(1);

    const humanPage = await repo.listByOwner({
      ownerType: "HUMAN",
      ownerId: ownerHumanId,
    });
    expect(humanPage.items.map((e) => e.id)).toEqual([humanEventId]);
    expect(humanPage.pageInfo.total).toBe(1);
  }, 60_000);

  test("orders.listForOrg / listForHumanOwnedEvents never surface an order referencing the COMMUNITY event", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeOrdersRepo(prisma);

    // The adversarial community-event order exists in the table…
    const communityOrders = await prisma.order.count({
      where: { eventId: communityEventId },
    });
    expect(communityOrders).toBe(1);

    // …but the owner-scoped joins (event.orgId / event.humanId) can never
    // match a row whose event has BOTH owner columns null.
    const forOrg = await repo.listForOrg({ orgId });
    expect(forOrg.total).toBe(1);
    expect(forOrg.items.map((o) => o.eventId)).toEqual([orgEventId]);

    const forHuman = await repo.listForHumanOwnedEvents({ ownerHumanId });
    expect(forHuman.total).toBe(1);
    expect(forHuman.items.map((o) => o.eventId)).toEqual([humanEventId]);
  }, 60_000);

  test("analytics.getOrgDashboardSummary aggregates only the org's own events despite COMMUNITY stats rows", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeAnalyticsRepo(prisma);

    // Existence pin: the community event's stats row is really in the table
    // (the exclusion below must never pass vacuously).
    expect(
      await prisma.eventDailyStats.count({
        where: { eventId: communityEventId },
      }),
    ).toBe(1);

    const summary = await repo.getOrgDashboardSummary(orgId);
    // All three events carry an identical EventDailyStats row; only the org
    // event may contribute (raw SQL joins Event WHERE e."orgId" = $1).
    expect(summary.eventCount).toBe(1);
    expect(summary.totalGrossRevenueCents).toBe(5000);
    expect(summary.totalTicketsSold).toBe(1);
  }, 60_000);

  // ── 3. Money pipeline exclusion ──────────────────────────────────────────

  test("no settlement/payout row references the COMMUNITY event (order-derived by construction)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    // Order revenue is ONLY materialized by createCreditsFromOrder (payee
    // ledger), which walks order → event → payout terms. An RSVP/COMMUNITY
    // event can never obtain a SUCCEEDED checkout order (EVENT_NOT_TICKETED
    // guards, core tests), so no settlement/ledger row can reference it in
    // production. These counts are canaries that the seed above didn't
    // accidentally grow money children either.
    expect(
      await prisma.settlement.count({ where: { eventId: communityEventId } }),
    ).toBe(0);
    expect(
      await prisma.ticketType.count({ where: { eventId: communityEventId } }),
    ).toBe(0);
  }, 60_000);

  test("DB check constraint (FR-002): COMMUNITY rows must be ownerless AND RSVP; ownerless OWNED stays legal", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const base = {
      title: "Constraint Probe",
      startsAt: EVENT_STARTS_AT,
      endsAt: EVENT_ENDS_AT,
      status: "DRAFT" as const,
    };

    // COMMUNITY with an owner → rejected by THE check constraint (pin the
    // constraint name so an unrelated failure can't satisfy the probe).
    await expect(
      prisma.event.create({
        data: {
          ...base,
          stewardship: "COMMUNITY",
          attendanceMode: "RSVP",
          orgId,
        },
      }),
    ).rejects.toThrow(/event_community_ownerless_rsvp_check/);

    // COMMUNITY but TICKETED → rejected even when ownerless.
    await expect(
      prisma.event.create({
        data: {
          ...base,
          stewardship: "COMMUNITY",
          attendanceMode: "TICKETED",
        },
      }),
    ).rejects.toThrow(/event_community_ownerless_rsvp_check/);

    // The OWNED => has-owner direction is deliberately NOT DB-enforced
    // (Event.humanId is onDelete SetNull — human deletion orphans personal
    // events). An ownerless OWNED row must stay insertable.
    const orphan = await prisma.event.create({
      data: { ...base, stewardship: "OWNED", attendanceMode: "TICKETED" },
    });
    expect(orphan.humanId).toBeNull();
    expect(orphan.orgId).toBeNull();
    await prisma.event.delete({ where: { id: orphan.id } });
  }, 60_000);
});
