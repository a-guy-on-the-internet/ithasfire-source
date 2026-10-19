import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";
import { mergePlaces, previewPlaceMerge } from "@th/core/use-cases/places";

import { createPrismaRepos } from "../../src/db/prisma";
import { makeEntityPagesRepo } from "../../src/db/prisma/entity-pages";

/**
 * mergePlaces against real Postgres (merge-duplicate-places spec FR-001..007).
 *
 * Drives the REAL use case over `createPrismaRepos`, so the SQL under test is
 * the adapter's (`place-merge.ts`) plus the repos the use case composes with
 * (event-location lock + re-projection, slug history, audit, reindex marks).
 * The unit tests in core pin the decisions; this pins that the rows land.
 */
describe("Prisma adapters integration – place merge", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  const NS = `pm-${Date.now()}`;
  const allow = { hasStaffRole: async () => ({ allowed: true }) } as never;
  const clock = { now: () => new Date() } as never;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("place-merge integration setup failed:", error);
    }
  }, 600_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  /** A place with its auto-made Main Space + default calendar and a page. */
  async function makePlace(name: string, slug: string) {
    const db = prisma!;
    const place = await db.place.create({
      data: {
        name,
        address: "115 27th Ave N, Nashville, TN",
        city: "Nashville",
        region: "TN",
        country: "US",
        lat: 36.15,
        lng: -86.81,
        status: "ACTIVE",
      },
    });
    const space = await db.space.create({
      data: { placeId: place.id, name: "Main Space", sortOrder: 0 },
    });
    const calendar = await db.calendar.create({
      data: {
        placeId: place.id,
        name: "Main Calendar",
        slug: "main",
        isDefault: true,
        primarySpaceId: space.id,
        calendarSpaces: { create: [{ spaceId: space.id }] },
      },
    });
    const page = await db.entityPage.create({
      data: { ownerType: "PLACE", ownerId: place.id, slug, displayName: name },
    });
    return { id: place.id, spaceId: space.id, calendarId: calendar.id, pageId: page.id, slug };
  }

  test("moves every reference to the survivor, redirects the slug, deletes the merged row", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repos = createPrismaRepos(db);

    const [h1, h2] = await Promise.all([
      db.human.create({ data: { name: "Both", status: "ACTIVE" } }),
      db.human.create({ data: { name: "Merged only", status: "ACTIVE" } }),
    ]);
    const survivor = await makePlace("Springwater Supper Club", `${NS}-s`);
    const merged = await makePlace("Springwater", `${NS}-m`);
    await db.place.update({
      where: { id: merged.id },
      data: { phone: "615-555-0100" },
    });

    const showAtMerged = await db.event.create({
      data: {
        title: "Show at merged",
        startsAt: new Date("2026-11-01T01:00:00Z"),
        endsAt: new Date("2026-11-01T04:00:00Z"),
        status: "PUBLISHED",
        visibility: "PUBLIC",
        placeId: merged.id,
        calendarId: merged.calendarId,
        spaceId: merged.spaceId,
        venueConfirmedPlaceId: merged.id,
        venueConfirmedAt: new Date(),
      },
    });
    const showAtSurvivor = await db.event.create({
      data: {
        title: "Show at survivor",
        startsAt: new Date("2026-11-02T01:00:00Z"),
        endsAt: new Date("2026-11-02T04:00:00Z"),
        status: "PUBLISHED",
        visibility: "PUBLIC",
        placeId: survivor.id,
      },
    });
    // A LAPSED confirmation: stamped by the merged place, but the event has
    // since moved to the survivor. It must not become live there.
    const lapsed = await db.event.create({
      data: {
        title: "Moved show",
        startsAt: new Date("2026-11-05T01:00:00Z"),
        endsAt: new Date("2026-11-05T04:00:00Z"),
        status: "PUBLISHED",
        visibility: "PUBLIC",
        placeId: survivor.id,
        venueConfirmedPlaceId: merged.id,
        venueConfirmedAt: new Date(),
      },
    });

    // Page rows: h1 follows both (collision), h2 only the merged page.
    await db.entityFollow.createMany({
      data: [
        { followerHumanId: h1.id, entityPageId: survivor.pageId },
        { followerHumanId: h1.id, entityPageId: merged.pageId },
        { followerHumanId: h2.id, entityPageId: merged.pageId },
      ],
    });
    await db.entityEventNotice.createMany({
      data: [
        { entityPageId: survivor.pageId, eventId: showAtMerged.id },
        { entityPageId: merged.pageId, eventId: showAtMerged.id },
        { entityPageId: merged.pageId, eventId: showAtSurvivor.id },
      ],
    });
    await db.pageSlugHistory.create({
      data: { pageId: merged.pageId, slug: `${NS}-m-old` },
    });

    // Place-level rows.
    await db.placeOwnership.create({
      data: {
        placeId: merged.id,
        ownerType: "HUMAN",
        ownerId: h1.id,
        verified: false,
      },
    });
    await db.entityReport.createMany({
      data: [
        { subjectType: "PLACE", subjectId: survivor.id, reporterHumanId: h1.id, reason: "CLOSED_OR_GONE" },
        { subjectType: "PLACE", subjectId: merged.id, reporterHumanId: h1.id, reason: "CLOSED_OR_GONE" },
        { subjectType: "PLACE", subjectId: merged.id, reporterHumanId: h2.id, reason: "CLOSED_OR_GONE" },
      ],
    });
    await db.featuredItem.create({ data: { itemType: "PLACE", itemId: merged.id } });
    await db.placeStats.create({ data: { placeId: survivor.id } });
    await db.reviewAggregate.create({
      data: {
        subjectType: "PLACE",
        subjectId: merged.id,
        snapshot: {},
        computedAt: new Date(),
      },
    });

    const preview = await previewPlaceMerge(
      { repos, authz: allow },
      { actorHumanId: h1.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(preview.blockers).toEqual([]);
    expect(preview.moves).toMatchObject({
      events: 1,
      venueConfirmedEvents: 1,
      eventsOnDefaultCalendar: 1,
      eventsOnMainSpace: 1,
      follows: 1,
      followsDropped: 1,
      eventNotices: 1,
      eventNoticesDropped: 1,
      pageSlugHistory: 1,
      entityReports: 1,
      entityReportsDropped: 1,
      featuredItems: 1,
      ownerships: 1,
    });
    expect(preview.filledFields).toEqual(["phone"]);

    const out = await mergePlaces(
      { repos, authz: allow, clock },
      { actorHumanId: h1.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(out.moved.events).toBe(1);

    // The merged row and its page are gone; its defaults went with it.
    expect(await db.place.findUnique({ where: { id: merged.id } })).toBeNull();
    expect(await db.entityPage.findUnique({ where: { id: merged.pageId } })).toBeNull();
    expect(await db.calendar.count({ where: { placeId: merged.id } })).toBe(0);

    // Survivor kept its name, took the empty phone.
    const s = await db.place.findUniqueOrThrow({ where: { id: survivor.id } });
    expect(s.name).toBe("Springwater Supper Club");
    expect(s.phone).toBe("615-555-0100");

    // Event re-pointed with its confirmation, calendar and space.
    const ev = await db.event.findUniqueOrThrow({ where: { id: showAtMerged.id } });
    expect(ev).toMatchObject({
      placeId: survivor.id,
      venueConfirmedPlaceId: survivor.id,
      calendarId: survivor.calendarId,
      spaceId: survivor.spaceId,
    });

    // The lapsed stamp is left exactly as it was.
    expect(
      (await db.event.findUniqueOrThrow({ where: { id: lapsed.id } }))
        .venueConfirmedPlaceId,
    ).toBe(merged.id);

    // Follows: h1 once, h2 moved.
    const follows = await db.entityFollow.findMany({
      where: { entityPageId: survivor.pageId },
      select: { followerHumanId: true },
    });
    expect(follows.map((f) => f.followerHumanId).sort()).toEqual([h1.id, h2.id].sort());

    // Notices: one per event on the survivor page.
    const notices = await db.entityEventNotice.findMany({
      where: { entityPageId: survivor.pageId },
      select: { eventId: true },
    });
    expect(notices.map((n) => n.eventId).sort()).toEqual(
      [showAtMerged.id, showAtSurvivor.id].sort(),
    );

    // Both old slugs redirect to the survivor's page.
    const pages = makeEntityPagesRepo(db);
    expect(await pages.getBySlug(merged.slug)).toBeNull();
    expect(await pages.resolveSlugHistory(merged.slug)).toBe(survivor.slug);
    expect(await pages.resolveSlugHistory(`${NS}-m-old`)).toBe(survivor.slug);

    // Ownership, reports, featured item moved; the colliding report dropped.
    expect(
      await db.placeOwnership.count({ where: { placeId: survivor.id, ownerId: h1.id } }),
    ).toBe(1);
    const reports = await db.entityReport.findMany({
      where: { subjectType: "PLACE", subjectId: survivor.id },
      select: { reporterHumanId: true },
    });
    expect(reports.map((r) => r.reporterHumanId).sort()).toEqual([h1.id, h2.id].sort());
    expect(
      await db.featuredItem.count({ where: { itemType: "PLACE", itemId: survivor.id } }),
    ).toBe(1);

    // Derived rows: survivor stale, merged aggregate gone.
    const stats = await db.placeStats.findUniqueOrThrow({ where: { placeId: survivor.id } });
    expect(stats.lastCalculatedAt.getTime()).toBe(0);
    expect(
      await db.reviewAggregate.count({ where: { subjectType: "PLACE", subjectId: merged.id } }),
    ).toBe(0);

    // One audit row, and reindex marks for both places and the moved event.
    const audit = await db.auditLog.findMany({
      where: { entityId: survivor.id, action: "place.merged" },
    });
    expect(audit).toHaveLength(1);
    expect((audit[0]!.data as { mergedPageSlug: string }).mergedPageSlug).toBe(merged.slug);
    const marks = await db.searchReindexPending.findMany({
      where: { entityId: { in: [survivor.id, merged.id, showAtMerged.id] } },
      select: { entityType: true, entityId: true },
    });
    expect(marks).toHaveLength(3);
  }, 120_000);

  test("collisions: a shared review-session token and a featured survivor keep the survivor's rows", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repos = createPrismaRepos(db);
    const actor = await db.human.create({ data: { name: "Admin", status: "ACTIVE" } });
    const survivor = await makePlace("Exit/In", `${NS}-col-s`);
    const merged = await makePlace("Exit In", `${NS}-col-m`);
    const shared = `${NS}-tok-shared`;
    const survivorSession = await db.placeReviewSession.create({
      data: { sessionToken: shared, placeId: survivor.id },
    });
    const reviewerEmail = `${NS}-reviewer@example.com`;
    const droppedSession = await db.placeReviewSession.create({
      data: { sessionToken: shared, placeId: merged.id, email: reviewerEmail },
    });
    // The same owner on both: the survivor's verified row wins, the merged
    // provisional row is dropped; its proof carries a claimant email.
    const owner = await db.human.create({ data: { name: "Owner", status: "ACTIVE" } });
    const claimEmail = `${NS}-claim@example.com`;
    await db.placeOwnership.create({
      data: { placeId: survivor.id, ownerType: "HUMAN", ownerId: owner.id, verified: true },
    });
    const droppedOwnership = await db.placeOwnership.create({
      data: {
        placeId: merged.id,
        ownerType: "HUMAN",
        ownerId: owner.id,
        verified: false,
        proof: { kind: "EMAIL_MAILBOX", email: claimEmail, note: "sent from the box office" },
      },
    });
    const movedSession = await db.placeReviewSession.create({
      data: { sessionToken: `${NS}-tok-merged`, placeId: merged.id },
    });
    const survivorFeature = await db.featuredItem.create({
      data: { itemType: "PLACE", itemId: survivor.id },
    });
    const mergedFeature = await db.featuredItem.create({
      data: { itemType: "PLACE", itemId: merged.id },
    });

    const out = await mergePlaces(
      { repos, authz: allow, clock },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(out.moved).toMatchObject({
      placeReviewSessions: 1,
      placeReviewSessionsDropped: 1,
      featuredItems: 0,
      featuredItemsDropped: 1,
    });

    const sessions = await db.placeReviewSession.findMany({
      where: { placeId: survivor.id },
      select: { id: true },
    });
    expect(sessions.map((x) => x.id).sort()).toEqual(
      [survivorSession.id, movedSession.id].sort(),
    );
    expect(
      await db.placeReviewSession.findUnique({ where: { id: droppedSession.id } }),
    ).toBeNull();
    const featured = await db.featuredItem.findMany({
      where: { id: { in: [survivorFeature.id, mergedFeature.id] } },
      select: { id: true, itemId: true },
    });
    expect(featured).toEqual([{ id: survivorFeature.id, itemId: survivor.id }]);

    // The audit row (readable by REVIEWER staff) holds no live token, no
    // reviewer email and no claim proof beyond its kind.
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: survivor.id, action: "place.merged" },
    });
    const raw = JSON.stringify(audit.data);
    expect(raw).not.toContain(shared);
    expect(raw).not.toContain(reviewerEmail);
    expect(raw).not.toContain(claimEmail);
    const dropped = (audit.data as Record<string, any>).movedIds.droppedRows;
    expect(dropped.placeReviewSessions).toEqual([
      expect.objectContaining({
        id: droppedSession.id,
        sessionTokenSha256: createHash("sha256").update(shared).digest("hex"),
        hadEmail: true,
      }),
    ]);
    expect(dropped.placeReviewSessions[0]).not.toHaveProperty("sessionToken");
    expect(dropped.placeReviewSessions[0]).not.toHaveProperty("email");
    expect(dropped.ownerships).toEqual([
      expect.objectContaining({ id: droppedOwnership.id, proof: { kind: "EMAIL_MAILBOX" } }),
    ]);
  }, 120_000);

  test("TRANSFER_PAGE: a survivor with no page takes the merged page, and its slug still resolves", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repos = createPrismaRepos(db);
    const actor = await db.human.create({ data: { name: "Admin", status: "ACTIVE" } });
    const survivor = await makePlace("The 5 Spot", `${NS}-tp-s`);
    await db.entityPage.delete({ where: { id: survivor.pageId } });
    const merged = await makePlace("5 Spot", `${NS}-tp-m`);
    await db.entityFollow.create({
      data: {
        followerHumanId: actor.id,
        entityPageId: merged.pageId,
      },
    });

    const out = await mergePlaces(
      { repos, authz: allow, clock },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(out.pageAction).toBe("TRANSFER_PAGE");

    const page = await db.entityPage.findUniqueOrThrow({ where: { id: merged.pageId } });
    expect(page).toMatchObject({
      ownerType: "PLACE",
      ownerId: survivor.id,
      slug: merged.slug,
    });
    // (ownerType, ownerId) unique holds: exactly one page for the survivor.
    expect(
      await db.entityPage.count({ where: { ownerType: "PLACE", ownerId: survivor.id } }),
    ).toBe(1);
    expect(
      await db.entityPage.count({ where: { ownerType: "PLACE", ownerId: merged.id } }),
    ).toBe(0);
    const pages = makeEntityPagesRepo(db);
    expect((await pages.getBySlug(merged.slug))?.ownerId).toBe(survivor.id);
    // The follower came along with the page.
    expect(
      await db.entityFollow.count({ where: { entityPageId: merged.pageId } }),
    ).toBe(1);
    expect(await db.place.findUnique({ where: { id: merged.id } })).toBeNull();
  }, 120_000);

  /**
   * holds-without-a-request adds PlaceBookingGrant.granteeHumanId and an XOR
   * CHECK; on a client without the column the deprecated humanId is enough.
   */
  const granteeOf = (humanId: string) =>
    "granteeHumanId" in Prisma.PlaceBookingGrantScalarFieldEnum
      ? { granteeHumanId: humanId }
      : {};

  /** An extra calendar + its own room on `placeId` (a separate stream). */
  async function addCalendar(placeId: string, name: string, slug: string) {
    const db = prisma!;
    const space = await db.space.create({ data: { placeId, name, sortOrder: 1 } });
    const calendar = await db.calendar.create({
      data: {
        placeId,
        name,
        slug,
        primarySpaceId: space.id,
        calendarSpaces: { create: [{ spaceId: space.id }] },
      },
    });
    return { calendarId: calendar.id, spaceId: space.id };
  }

  async function makeRequest(placeId: string, calendarId: string, spaceId: string | null, actId: string) {
    return prisma!.bookingRequest.create({
      data: {
        placeId,
        calendarId,
        spaceId,
        performerOwnerType: "human",
        performerOwnerId: actId,
        message: "We'd love to play your room.",
        preferredDates: ["2026-12-04"],
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      },
    });
  }

  async function makeHold(input: {
    requestId: string;
    calendarId: string;
    spaceId: string | null;
    date: string;
    status?: "ACTIVE" | "CHALLENGED" | "CONFIRMED" | "RELEASED";
    staffId: string;
  }) {
    return prisma!.bookingHold.create({
      data: {
        bookingRequestId: input.requestId,
        calendarId: input.calendarId,
        spaceId: input.spaceId,
        date: new Date(`${input.date}T00:00:00.000Z`),
        position: 1,
        status: input.status ?? "ACTIVE",
        placedByHumanId: input.staffId,
        ...(input.status === "CONFIRMED" ? { confirmedAt: new Date() } : {}),
        ...(input.status === "RELEASED"
          ? { releasedAt: new Date(), releasedReason: "MANUAL" as never }
          : {}),
      },
    });
  }

  test("booking data on the merged default calendar lands on the survivor's; an extra calendar moves whole; nothing cascades", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repos = createPrismaRepos(db);
    const [actor, act, act2, act3] = await Promise.all([
      db.human.create({ data: { name: "Admin", status: "ACTIVE" } }),
      db.human.create({ data: { name: "Act", status: "ACTIVE" } }),
      db.human.create({ data: { name: "Second act", status: "ACTIVE" } }),
      db.human.create({ data: { name: "Survivor act", status: "ACTIVE" } }),
    ]);
    const survivor = await makePlace("Drkmttr", `${NS}-bk-s`);
    const merged = await makePlace("Drkmttr Nashville", `${NS}-bk-m`);
    // Both places have a "Patio" calendar with slug "patio": the merged one
    // must arrive renamed, not collide on Calendar_placeId_slug_key.
    await addCalendar(survivor.id, "Patio", "patio");
    const patio = await addCalendar(merged.id, "Patio", "patio");

    // On the merged DEFAULT calendar / Main Space.
    const req = await makeRequest(merged.id, merged.calendarId, merged.spaceId, act.id);
    const hold = await makeHold({
      requestId: req.id,
      calendarId: merged.calendarId,
      spaceId: merged.spaceId,
      date: "2026-12-04",
      staffId: actor.id,
    });
    // A released hold on a date the survivor's line also holds: not a conflict.
    // (A different act: the same act open on both would be
    // BOOKING_REQUESTS_OPEN_DUPLICATE.)
    const survivorReq = await makeRequest(survivor.id, survivor.calendarId, survivor.spaceId, act3.id);
    await makeHold({
      requestId: survivorReq.id,
      calendarId: survivor.calendarId,
      spaceId: survivor.spaceId,
      date: "2026-12-11",
      staffId: actor.id,
    });
    const released = await makeHold({
      requestId: req.id,
      calendarId: merged.calendarId,
      spaceId: merged.spaceId,
      date: "2026-12-11",
      status: "RELEASED",
      staffId: actor.id,
    });
    const weekly = await db.calendarAvailability.create({
      data: { placeId: merged.id, calendarId: merged.calendarId, dayOfWeek: 5, startTime: "19:00", endTime: "23:00" },
    });
    const closed = await db.calendarAvailability.create({
      data: { placeId: merged.id, date: new Date("2026-12-25T00:00:00.000Z"), isOpen: false },
    });
    const grant = await db.placeBookingGrant.create({
      data: {
        placeId: merged.id,
        calendarId: merged.calendarId,
        humanId: act.id,
        ...granteeOf(act.id),
        grantedByHumanId: actor.id,
      } as never,
    });
    const item = await db.bookingStandardItem.create({
      data: {
        ownerType: "CALENDAR",
        ownerId: merged.calendarId,
        intent: "PERFORM",
        field: "CUSTOM",
        label: "A link to a recent set",
        requirement: "SUGGESTED",
        sortOrder: 0,
      },
    });
    const waiver = await db.placeWaiver.create({
      data: { placeId: merged.id, title: "House rules", content: "Be kind." },
    });
    const layout = await db.placeLayout.create({
      data: { placeId: merged.id, checksum: "c", glyphSnapshotKey: "k" },
    });
    // On the merged EXTRA calendar: stays on it, the calendar moves.
    const patioReq = await makeRequest(merged.id, patio.calendarId, patio.spaceId, act2.id);
    const patioHold = await makeHold({
      requestId: patioReq.id,
      calendarId: patio.calendarId,
      spaceId: patio.spaceId,
      date: "2026-12-04",
      staffId: actor.id,
    });
    const patioShow = await db.event.create({
      data: {
        title: "Patio show",
        startsAt: new Date("2026-12-05T01:00:00Z"),
        endsAt: new Date("2026-12-05T04:00:00Z"),
        status: "PUBLISHED",
        visibility: "PUBLIC",
        placeId: merged.id,
        calendarId: patio.calendarId,
        spaceId: patio.spaceId,
      },
    });

    const holdIds = [hold.id, released.id, patioHold.id];
    const requestIds = [req.id, patioReq.id];
    const before = {
      holds: await db.bookingHold.count({ where: { id: { in: holdIds } } }),
      requests: await db.bookingRequest.count({ where: { id: { in: requestIds } } }),
      availability: await db.calendarAvailability.count({ where: { id: { in: [weekly.id, closed.id] } } }),
    };
    expect(before).toEqual({ holds: 3, requests: 2, availability: 2 });

    const preview = await previewPlaceMerge(
      { repos, authz: allow },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(preview.blockers).toEqual([]);
    expect(preview.moves).toMatchObject({
      bookingRequests: 2,
      bookingHolds: 3,
      calendarAvailability: 2,
      bookingGrants: 1,
      waivers: 1,
      layouts: 1,
      calendarsReparented: 1,
      spacesReparented: 1,
      defaultCalendarFolded: 1,
      bookingStandardItems: 1,
    });
    expect(preview.warnings).toEqual(
      expect.arrayContaining([
        { code: "PLACE_WIDE_AVAILABILITY_MOVED", count: 1 },
        { code: "WAIVER_BECOMES_ACTIVE", count: 1 },
        expect.objectContaining({ code: "NAMES_SUFFIXED", count: 2 }),
      ]),
    );

    const out = await mergePlaces(
      { repos, authz: allow, clock },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(out.moved).toMatchObject({ bookingHolds: 3, bookingRequests: 2, defaultCalendarFolded: 1 });

    // Nothing cascade-deleted.
    expect(await db.bookingHold.count({ where: { id: { in: holdIds } } })).toBe(3);
    expect(await db.bookingRequest.count({ where: { id: { in: requestIds } } })).toBe(2);
    expect(await db.calendarAvailability.count({ where: { id: { in: [weekly.id, closed.id] } } })).toBe(2);
    expect(await db.placeBookingGrant.count({ where: { id: grant.id } })).toBe(1);
    expect(await db.bookingStandardItem.count({ where: { id: item.id } })).toBe(1);
    expect(await db.placeWaiver.count({ where: { id: waiver.id } })).toBe(1);
    expect(await db.placeLayout.count({ where: { id: layout.id } })).toBe(1);

    // Default-calendar rows now on the survivor's default calendar / Main Space.
    expect(await db.bookingHold.findUniqueOrThrow({ where: { id: hold.id } })).toMatchObject({
      calendarId: survivor.calendarId,
      spaceId: survivor.spaceId,
      status: "ACTIVE",
      position: 1,
    });
    expect(await db.bookingRequest.findUniqueOrThrow({ where: { id: req.id } })).toMatchObject({
      placeId: survivor.id,
      calendarId: survivor.calendarId,
      spaceId: survivor.spaceId,
    });
    expect(await db.calendarAvailability.findUniqueOrThrow({ where: { id: weekly.id } })).toMatchObject({
      placeId: survivor.id,
      calendarId: survivor.calendarId,
    });
    expect(await db.calendarAvailability.findUniqueOrThrow({ where: { id: closed.id } })).toMatchObject({
      placeId: survivor.id,
      calendarId: null,
    });
    expect(await db.placeBookingGrant.findUniqueOrThrow({ where: { id: grant.id } })).toMatchObject({
      placeId: survivor.id,
      calendarId: survivor.calendarId,
    });
    expect(await db.bookingStandardItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({
      ownerType: "CALENDAR",
      ownerId: survivor.calendarId,
    });
    expect((await db.placeWaiver.findUniqueOrThrow({ where: { id: waiver.id } })).placeId).toBe(survivor.id);
    expect(await db.placeLayout.findUniqueOrThrow({ where: { id: layout.id } })).toMatchObject({
      placeId: survivor.id,
      name: "Default",
    });

    // The folded calendar and Main Space are gone; the patio moved whole, renamed.
    expect(await db.calendar.findUnique({ where: { id: merged.calendarId } })).toBeNull();
    expect(await db.space.findUnique({ where: { id: merged.spaceId } })).toBeNull();
    expect(await db.calendar.findUniqueOrThrow({ where: { id: patio.calendarId } })).toMatchObject({
      placeId: survivor.id,
      name: "Patio (from Drkmttr Nashville)",
      slug: "patio-2",
      isDefault: false,
    });
    expect(await db.space.findUniqueOrThrow({ where: { id: patio.spaceId } })).toMatchObject({
      placeId: survivor.id,
      name: "Patio (from Drkmttr Nashville)",
    });
    expect(await db.bookingHold.findUniqueOrThrow({ where: { id: patioHold.id } })).toMatchObject({
      calendarId: patio.calendarId,
      spaceId: patio.spaceId,
    });
    expect(await db.event.findUniqueOrThrow({ where: { id: patioShow.id } })).toMatchObject({
      placeId: survivor.id,
      calendarId: patio.calendarId,
    });
    // Survivor still has exactly one default calendar.
    expect(await db.calendar.count({ where: { placeId: survivor.id, isDefault: true } })).toBe(1);

    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: survivor.id, action: "place.merged" },
    });
    const ops = (audit.data as { operations: Record<string, unknown> }).operations;
    expect(ops).toMatchObject({
      defaultCalendarFolded: true,
      bookingHolds: expect.arrayContaining(holdIds),
      bookingRequests: expect.arrayContaining(requestIds),
      calendarsReparented: [patio.calendarId],
      spacesReparented: [patio.spaceId],
      deletedCalendar: expect.objectContaining({ id: merged.calendarId }),
      deletedSpace: expect.objectContaining({ id: merged.spaceId }),
    });
    const marks = await db.searchReindexPending.count({
      where: { entityType: "event", entityId: patioShow.id },
    });
    expect(marks).toBe(1);
  }, 120_000);

  test("two live holds for the same night on both default calendars refuse the merge and write nothing", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repos = createPrismaRepos(db);
    const [actor, act, act2] = await Promise.all([
      db.human.create({ data: { name: "Admin", status: "ACTIVE" } }),
      db.human.create({ data: { name: "Act", status: "ACTIVE" } }),
      db.human.create({ data: { name: "Second act", status: "ACTIVE" } }),
    ]);
    const survivor = await makePlace("Cobra Nashville", `${NS}-cobra-s`);
    const merged = await makePlace("The Cobra", `${NS}-cobra-m`);
    const sReq = await makeRequest(survivor.id, survivor.calendarId, survivor.spaceId, act.id);
    const mReq = await makeRequest(merged.id, merged.calendarId, merged.spaceId, act2.id);
    await makeHold({ requestId: sReq.id, calendarId: survivor.calendarId, spaceId: null, date: "2026-12-18", staffId: actor.id });
    const mHold = await makeHold({ requestId: mReq.id, calendarId: merged.calendarId, spaceId: null, date: "2026-12-18", staffId: actor.id });

    const err = await mergePlaces(
      { repos, authz: allow, clock },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "CONFLICT",
      meta: { blockers: [{ code: "BOOKING_HOLDS_OVERLAP", count: 1, ids: [mHold.id] }] },
    });
    expect(await db.place.findUnique({ where: { id: merged.id } })).not.toBeNull();
    expect((await db.bookingHold.findUniqueOrThrow({ where: { id: mHold.id } })).calendarId).toBe(
      merged.calendarId,
    );
    expect(
      await db.auditLog.count({ where: { entityId: survivor.id, action: "place.merged" } }),
    ).toBe(0);
  }, 120_000);

  test("agreements and POS readers are repointed (they would SET NULL); merged waivers move inactive when the survivor has one", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repos = createPrismaRepos(db);
    const actor = await db.human.create({ data: { name: "Admin", status: "ACTIVE" } });
    const org = await db.organization.create({ data: { name: "Room Org", slug: `${NS}-org` } });
    const survivor = await makePlace("The End", `${NS}-ag-s`);
    const merged = await makePlace("The End Nashville", `${NS}-ag-m`);
    const agreement = await db.agreement.create({
      data: {
        type: "PERFORMANCE",
        status: "ACCEPTED",
        proposerType: "human",
        proposerId: actor.id,
        counterpartyType: "organization",
        counterpartyId: org.id,
        title: "Booking — The End",
        placeId: merged.id,
      },
    });
    const reader = await db.posReader.create({
      data: {
        orgId: org.id,
        stripeReaderId: `${NS}-tmr_1`,
        label: "Bar",
        placeId: merged.id,
        pairedByHumanId: actor.id,
      },
    });
    const survivorWaiver = await db.placeWaiver.create({
      data: { placeId: survivor.id, title: "Survivor rules", content: "A.", version: 1 },
    });
    const mergedWaiver = await db.placeWaiver.create({
      data: { placeId: merged.id, title: "Merged rules", content: "B.", version: 3 },
    });

    const preview = await previewPlaceMerge(
      { repos, authz: allow },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(preview.blockers).toEqual([]);
    expect(preview.moves).toMatchObject({ agreements: 1, posReaders: 1, waivers: 1 });
    expect(preview.warnings).toContainEqual({ code: "WAIVERS_DEACTIVATED", count: 1 });

    await mergePlaces(
      { repos, authz: allow, clock },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect((await db.agreement.findUniqueOrThrow({ where: { id: agreement.id } })).placeId).toBe(
      survivor.id,
    );
    expect((await db.posReader.findUniqueOrThrow({ where: { id: reader.id } })).placeId).toBe(
      survivor.id,
    );
    expect(await db.placeWaiver.findUniqueOrThrow({ where: { id: mergedWaiver.id } })).toMatchObject({
      placeId: survivor.id,
      isActive: false,
    });
    // The survivor's waiver is still the one `getActiveForPlace` returns,
    // though the moved one has the higher version.
    const active = await db.placeWaiver.findFirstOrThrow({
      where: { placeId: survivor.id, isActive: true },
      orderBy: { version: "desc" },
    });
    expect(active.id).toBe(survivorWaiver.id);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: survivor.id, action: "place.merged" },
    });
    expect((audit.data as { operations: Record<string, unknown> }).operations).toMatchObject({
      agreements: [agreement.id],
      posReaders: [reader.id],
      waiverStates: [{ id: mergedWaiver.id, wasActive: true }],
      waiversDeactivated: [mergedWaiver.id],
    });
  }, 120_000);

  test("a survivor with no default calendar takes the merged default calendar and Main Space whole", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repos = createPrismaRepos(db);
    const [actor, act] = await Promise.all([
      db.human.create({ data: { name: "Admin", status: "ACTIVE" } }),
      db.human.create({ data: { name: "Act", status: "ACTIVE" } }),
    ]);
    const survivor = await makePlace("Grimey's", `${NS}-pr-s`);
    // Strip the survivor's default calendar and Main Space.
    await db.calendar.delete({ where: { id: survivor.calendarId } });
    await db.space.delete({ where: { id: survivor.spaceId } });
    const merged = await makePlace("Grimeys", `${NS}-pr-m`);
    const req = await makeRequest(merged.id, merged.calendarId, merged.spaceId, act.id);
    const hold = await makeHold({
      requestId: req.id,
      calendarId: merged.calendarId,
      spaceId: merged.spaceId,
      date: "2026-12-04",
      staffId: actor.id,
    });

    const out = await mergePlaces(
      { repos, authz: allow, clock },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(out.moved).toMatchObject({ defaultCalendarFolded: 0, calendarsReparented: 1, spacesReparented: 1 });
    expect(await db.calendar.findUniqueOrThrow({ where: { id: merged.calendarId } })).toMatchObject({
      placeId: survivor.id,
      isDefault: true,
      slug: "main",
    });
    expect((await db.space.findUniqueOrThrow({ where: { id: merged.spaceId } })).placeId).toBe(survivor.id);
    expect(await db.bookingHold.findUniqueOrThrow({ where: { id: hold.id } })).toMatchObject({
      calendarId: merged.calendarId,
      spaceId: merged.spaceId,
    });
    expect((await db.bookingRequest.findUniqueOrThrow({ where: { id: req.id } })).placeId).toBe(survivor.id);
  }, 120_000);

  test("payout terms: the merged default fills an empty survivor and the deal row survives; two different deals refuse", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repos = createPrismaRepos(db);
    const actor = await db.human.create({ data: { name: "Admin", status: "ACTIVE" } });
    const deal = await db.payoutTerms.create({ data: { kind: "PRIMARY", status: "ACTIVE" } });
    const survivor = await makePlace("Basement East", `${NS}-pt-s`);
    const merged = await makePlace("The Basement East", `${NS}-pt-m`);
    await db.place.update({ where: { id: merged.id }, data: { defaultPrimaryPayoutTermsId: deal.id } });

    const out = await mergePlaces(
      { repos, authz: allow, clock },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(out.filledFields).toContain("defaultPrimaryPayoutTermsId");
    expect(
      (await db.place.findUniqueOrThrow({ where: { id: survivor.id } })).defaultPrimaryPayoutTermsId,
    ).toBe(deal.id);
    expect(await db.payoutTerms.count({ where: { id: deal.id } })).toBe(1);

    // Two different deals of the same kind.
    const dealA = await db.payoutTerms.create({ data: { kind: "PRIMARY", status: "ACTIVE" } });
    const dealB = await db.payoutTerms.create({ data: { kind: "PRIMARY", status: "ACTIVE" } });
    const s2 = await makePlace("Mercy Lounge", `${NS}-pt2-s`);
    const m2 = await makePlace("The Mercy Lounge", `${NS}-pt2-m`);
    await db.place.update({ where: { id: s2.id }, data: { defaultPrimaryPayoutTermsId: dealA.id } });
    await db.place.update({ where: { id: m2.id }, data: { defaultPrimaryPayoutTermsId: dealB.id } });
    const err = await mergePlaces(
      { repos, authz: allow, clock },
      { actorHumanId: actor.id, survivorId: s2.id, mergedId: m2.id },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "CONFLICT",
      meta: { blockers: [{ code: "DEFAULT_PAYOUT_TERMS_CONFLICT", count: 1 }] },
    });
    expect(await db.place.findUnique({ where: { id: m2.id } })).not.toBeNull();
  }, 120_000);

  test("a series, template or occurrence naming the merged place is rewritten to the survivor", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repos = createPrismaRepos(db);
    const actor = await db.human.create({ data: { name: "Admin", status: "ACTIVE" } });
    const survivor = await makePlace("Bluebird", `${NS}-ser-s`);
    const merged = await makePlace("The Bluebird", `${NS}-ser-m`);
    const location = { location: { kind: "place", placeId: merged.id } };
    const series = await db.eventSeries.create({
      data: {
        ownerScope: "HUMAN",
        ownerId: actor.id,
        name: "Writers night",
        nameNormalized: `writers night ${NS}`,
        timezone: "America/Chicago",
        schedule: {},
        defaults: { ...location, title: "Writers night" },
      },
    });
    const template = await db.eventTemplate.create({
      data: { ownerScope: "HUMAN", ownerId: actor.id, name: "Round", defaults: location },
    });
    const elsewhere = await db.eventSeries.create({
      data: {
        ownerScope: "HUMAN",
        ownerId: actor.id,
        name: "Elsewhere",
        nameNormalized: `elsewhere ${NS}`,
        timezone: "America/Chicago",
        schedule: {},
        defaults: { location: { kind: "place", placeId: survivor.id } },
      },
    });
    const occurrence = await db.eventSeriesOccurrence.create({
      data: {
        seriesId: elsewhere.id,
        ordinal: 1,
        startsAt: new Date("2026-11-05T01:00:00.000Z"),
        overrides: location,
      },
    });

    const preview = await previewPlaceMerge(
      { repos, authz: allow },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(preview.blockers).toEqual([]);
    expect(preview.moves).toMatchObject({ series: 1, templates: 1, occurrences: 1 });

    await mergePlaces(
      { repos, authz: allow, clock },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect((await db.eventSeries.findUniqueOrThrow({ where: { id: series.id } })).defaults).toEqual({
      title: "Writers night",
      location: { kind: "place", placeId: survivor.id },
    });
    expect((await db.eventTemplate.findUniqueOrThrow({ where: { id: template.id } })).defaults).toEqual({
      location: { kind: "place", placeId: survivor.id },
    });
    expect(
      (await db.eventSeriesOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } })).overrides,
    ).toEqual({ location: { kind: "place", placeId: survivor.id } });
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: survivor.id, action: "place.merged" },
    });
    expect((audit.data as { operations: Record<string, unknown> }).operations).toMatchObject({
      series: [series.id],
      templates: [template.id],
      occurrences: [occurrence.id],
    });
  }, 120_000);

  /** Guard + repos for the tests below. */
  function ready(skip: () => void) {
    if (runtimeError || !prisma) {
      skip();
      return null;
    }
    return { db: prisma, repos: createPrismaRepos(prisma) };
  }

  async function auditOf(survivorId: string) {
    const row = await prisma!.auditLog.findFirstOrThrow({
      where: { entityId: survivorId, action: "place.merged" },
    });
    return row.data as Record<string, any>;
  }

  test("an extra calendar using the merged Main Space as primary and joined ends on the survivor's Main Space; the deferred FK commits", async ({
    skip,
  }) => {
    const env = ready(skip);
    if (!env) return;
    const { db, repos } = env;
    const actor = await db.human.create({ data: { name: "Admin", status: "ACTIVE" } });
    const survivor = await makePlace("Exit/In", `${NS}-ms-s`);
    const merged = await makePlace("Exit In", `${NS}-ms-m`);
    // "Late show" shares the merged Main Space: primary AND joined.
    const late = await db.calendar.create({
      data: {
        placeId: merged.id,
        name: "Late show",
        slug: "late",
        primarySpaceId: merged.spaceId,
        calendarSpaces: { create: [{ spaceId: merged.spaceId }] },
      },
    });

    const out = await mergePlaces(
      { repos, authz: allow, clock },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(out.moved).toMatchObject({ defaultCalendarFolded: 1, calendarsReparented: 1 });

    expect(await db.calendar.findUniqueOrThrow({ where: { id: late.id } })).toMatchObject({
      placeId: survivor.id,
      primarySpaceId: survivor.spaceId,
    });
    const joins = await db.calendarSpace.findMany({ where: { calendarId: late.id } });
    expect(joins.map((j) => j.spaceId)).toEqual([survivor.spaceId]);
    expect(await db.space.findUnique({ where: { id: merged.spaceId } })).toBeNull();

    const ops = (await auditOf(survivor.id)).operations;
    expect(ops.primarySpaceRepointedCalendars).toEqual([late.id]);
    expect(ops.calendarSpaceJoinsDeleted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ calendarId: late.id, spaceId: merged.spaceId }),
      ]),
    );
    expect(ops.calendarSpaceJoinsCreated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ calendarId: late.id, spaceId: survivor.spaceId }),
      ]),
    );
  }, 120_000);

  test("standards: a survivor PLACE list replaces the folded calendar's list; the dropped rows are snapshotted in the audit", async ({
    skip,
  }) => {
    const env = ready(skip);
    if (!env) return;
    const { db, repos } = env;
    const actor = await db.human.create({ data: { name: "Admin", status: "ACTIVE" } });
    const survivor = await makePlace("Station Inn", `${NS}-st-s`);
    const merged = await makePlace("The Station Inn", `${NS}-st-m`);
    const base = { intent: "PERFORM" as const, field: "CUSTOM" as const, requirement: "SUGGESTED" as const, sortOrder: 0 };
    const kept = await db.bookingStandardItem.create({
      data: { ...base, ownerType: "PLACE", ownerId: survivor.id, label: "Survivor rule" },
    });
    const dropped = await db.bookingStandardItem.create({
      data: { ...base, ownerType: "CALENDAR", ownerId: merged.calendarId, label: "Merged calendar rule" },
    });

    const preview = await previewPlaceMerge(
      { repos, authz: allow },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(preview.warnings.map((w) => w.code)).toContain("BOOKING_STANDARDS_REPLACED");

    await mergePlaces(
      { repos, authz: allow, clock },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(await db.bookingStandardItem.findUnique({ where: { id: dropped.id } })).toBeNull();
    expect(await db.bookingStandardItem.findUniqueOrThrow({ where: { id: kept.id } })).toMatchObject({
      ownerType: "PLACE",
      ownerId: survivor.id,
    });
    const ops = (await auditOf(survivor.id)).operations;
    expect(ops.bookingStandardItemsDropped).toEqual([
      expect.objectContaining({
        id: dropped.id,
        ownerType: "CALENDAR",
        ownerId: merged.calendarId,
        label: "Merged calendar rule",
      }),
    ]);
  }, 120_000);

  test("a live merged hold on a night the survivor has CONFIRMED moves with HOLDS_SAME_NIGHT; it is not a blocker", async ({
    skip,
  }) => {
    const env = ready(skip);
    if (!env) return;
    const { db, repos } = env;
    const [actor, act, act2] = await Promise.all([
      db.human.create({ data: { name: "Admin", status: "ACTIVE" } }),
      db.human.create({ data: { name: "Act", status: "ACTIVE" } }),
      db.human.create({ data: { name: "Second act", status: "ACTIVE" } }),
    ]);
    const survivor = await makePlace("3rd and Lindsley", `${NS}-sn-s`);
    const merged = await makePlace("3rd & Lindsley", `${NS}-sn-m`);
    const sReq = await makeRequest(survivor.id, survivor.calendarId, survivor.spaceId, act.id);
    const mReq = await makeRequest(merged.id, merged.calendarId, merged.spaceId, act2.id);
    const won = await makeHold({ requestId: sReq.id, calendarId: survivor.calendarId, spaceId: null, date: "2026-12-18", status: "CONFIRMED", staffId: actor.id });
    const live = await makeHold({ requestId: mReq.id, calendarId: merged.calendarId, spaceId: null, date: "2026-12-18", staffId: actor.id });

    const preview = await previewPlaceMerge(
      { repos, authz: allow },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(preview.blockers).toEqual([]);
    expect(preview.warnings).toContainEqual(
      expect.objectContaining({ code: "HOLDS_SAME_NIGHT", count: 1 }),
    );

    const out = await mergePlaces(
      { repos, authz: allow, clock },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(out.warnings.map((w) => w.code)).toContain("HOLDS_SAME_NIGHT");
    expect(await db.bookingHold.findUniqueOrThrow({ where: { id: live.id } })).toMatchObject({
      calendarId: survivor.calendarId,
      status: "ACTIVE",
    });
    expect((await db.bookingHold.findUniqueOrThrow({ where: { id: won.id } })).status).toBe("CONFIRMED");
  }, 120_000);

  test("BOOKING_REQUESTS_OPEN_DUPLICATE names exactly the rows BookingRequest_open_pair_key would reject", async ({
    skip,
  }) => {
    const env = ready(skip);
    if (!env) return;
    const { db, repos } = env;
    const [actor, act, act2] = await Promise.all([
      db.human.create({ data: { name: "Admin", status: "ACTIVE" } }),
      db.human.create({ data: { name: "Act on both", status: "ACTIVE" } }),
      db.human.create({ data: { name: "Declined act", status: "ACTIVE" } }),
    ]);
    const survivor = await makePlace("The Basement", `${NS}-rq-s`);
    const merged = await makePlace("Basement Nashville", `${NS}-rq-m`);
    await makeRequest(survivor.id, survivor.calendarId, null, act.id);
    const dup = await makeRequest(merged.id, merged.calendarId, null, act.id);
    // Same pair, but one side is closed: outside the partial index, no blocker.
    await makeRequest(survivor.id, survivor.calendarId, null, act2.id);
    const closed = await makeRequest(merged.id, merged.calendarId, null, act2.id);
    await db.bookingRequest.update({ where: { id: closed.id }, data: { status: "DECLINED" } });

    const err = await mergePlaces(
      { repos, authz: allow, clock },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "CONFLICT",
      meta: { blockers: [{ code: "BOOKING_REQUESTS_OPEN_DUPLICATE", count: 1, ids: [dup.id] }] },
    });

    // The real index agrees: the flagged row cannot move; the closed one can.
    await expect(
      db.$transaction(async (t) => {
        await t.bookingRequest.update({ where: { id: dup.id }, data: { placeId: survivor.id } });
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await db.$transaction(async (t) => {
      await t.bookingRequest.update({ where: { id: closed.id }, data: { placeId: survivor.id } });
      throw new Error("rollback");
    }).catch((e: Error) => expect(e.message).toBe("rollback"));
    expect((await db.bookingRequest.findUniqueOrThrow({ where: { id: dup.id } })).placeId).toBe(merged.id);
  }, 120_000);

  test("a whole-place grant is split: narrowed to the survivor's default calendar plus one copy per calendar the merged place brought", async ({
    skip,
  }) => {
    const env = ready(skip);
    if (!env) return;
    const { db, repos } = env;
    const [actor, act] = await Promise.all([
      db.human.create({ data: { name: "Admin", status: "ACTIVE" } }),
      db.human.create({ data: { name: "Resident act", status: "ACTIVE" } }),
    ]);
    const survivor = await makePlace("The 5 Spot", `${NS}-gs-s`);
    const merged = await makePlace("5 Spot", `${NS}-gs-m`);
    const patio = await addCalendar(merged.id, "Patio", "patio");
    // A survivor-only room the grant must NOT widen to.
    const survivorRoom = await addCalendar(survivor.id, "Back room", "back");
    const grant = await db.placeBookingGrant.create({
      data: {
        placeId: merged.id,
        calendarId: null,
        humanId: act.id,
        ...granteeOf(act.id),
        grantedByHumanId: actor.id,
      } as never,
    });

    const preview = await previewPlaceMerge(
      { repos, authz: allow },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(preview.warnings).toContainEqual({ code: "GRANTS_SPLIT", count: 1, ids: [grant.id] });
    expect(preview.moves).toMatchObject({ bookingGrantsSplit: 1 });

    await mergePlaces(
      { repos, authz: allow, clock },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    const grants = await db.placeBookingGrant.findMany({
      where: { placeId: survivor.id, humanId: act.id },
      orderBy: { createdAt: "asc" },
    });
    expect(grants.map((g) => g.calendarId).sort()).toEqual(
      [survivor.calendarId, patio.calendarId].sort(),
    );
    expect(grants.some((g) => g.calendarId === survivorRoom.calendarId)).toBe(false);
    expect(grants.find((g) => g.id === grant.id)?.calendarId).toBe(survivor.calendarId);
    const copy = grants.find((g) => g.id !== grant.id)!;
    expect(copy).toMatchObject({
      grantedByHumanId: actor.id,
      revokedAt: null,
      canPlaceHolds: true,
      canCreateEvents: true,
    });

    const ops = (await auditOf(survivor.id)).operations;
    expect(ops.bookingGrantsSplit).toEqual([
      expect.objectContaining({
        original: expect.objectContaining({ id: grant.id, calendarId: null, placeId: merged.id }),
        keptOnCalendarId: survivor.calendarId,
        created: [{ id: copy.id, calendarId: patio.calendarId }],
      }),
    ]);
  }, 120_000);

  test("owners not compatible: the deal is not carried, merged waivers go inactive, merged grants end — and the merge still runs", async ({
    skip,
  }) => {
    const env = ready(skip);
    if (!env) return;
    const { db, repos } = env;
    const [actor, owner, act] = await Promise.all([
      db.human.create({ data: { name: "Admin", status: "ACTIVE" } }),
      db.human.create({ data: { name: "Survivor owner", status: "ACTIVE" } }),
      db.human.create({ data: { name: "Granted act", status: "ACTIVE" } }),
    ]);
    const deal = await db.payoutTerms.create({ data: { kind: "PRIMARY", status: "ACTIVE" } });
    const survivor = await makePlace("Rudy's Jazz Room", `${NS}-oc-s`);
    const merged = await makePlace("Rudys Jazz Room", `${NS}-oc-m`);
    await db.placeOwnership.create({
      data: { placeId: survivor.id, ownerType: "HUMAN", ownerId: owner.id, verified: true },
    });
    await db.place.update({ where: { id: merged.id }, data: { defaultPrimaryPayoutTermsId: deal.id } });
    const waiver = await db.placeWaiver.create({
      data: { placeId: merged.id, title: "Merged rules", content: "B." },
    });
    const grant = await db.placeBookingGrant.create({
      data: {
        placeId: merged.id,
        calendarId: merged.calendarId,
        humanId: act.id,
        ...granteeOf(act.id),
        grantedByHumanId: actor.id,
      } as never,
    });

    const preview = await previewPlaceMerge(
      { repos, authz: allow },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(preview.blockers).toEqual([]);
    expect(preview.warnings).toEqual(
      expect.arrayContaining([
        { code: "PAYOUT_DEFAULTS_NOT_CARRIED", count: 1 },
        { code: "WAIVERS_DEACTIVATED", count: 1 },
        { code: "GRANTS_ENDED", count: 1, ids: [grant.id] },
      ]),
    );

    const out = await mergePlaces(
      { repos, authz: allow, clock },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(out.filledFields).not.toContain("defaultPrimaryPayoutTermsId");
    expect(
      (await db.place.findUniqueOrThrow({ where: { id: survivor.id } })).defaultPrimaryPayoutTermsId,
    ).toBeNull();
    expect(await db.payoutTerms.count({ where: { id: deal.id } })).toBe(1);
    expect(await db.placeWaiver.findUniqueOrThrow({ where: { id: waiver.id } })).toMatchObject({
      placeId: survivor.id,
      isActive: false,
    });
    const g = await db.placeBookingGrant.findUniqueOrThrow({ where: { id: grant.id } });
    expect(g.placeId).toBe(survivor.id);
    expect(g.revokedAt).not.toBeNull();

    const data = await auditOf(survivor.id);
    expect(data.ownersCompatible).toBe(false);
    expect(data.operations).toMatchObject({
      bookingGrantsRevoked: [grant.id],
      waiversDeactivated: [waiver.id],
      waiverStates: [{ id: waiver.id, wasActive: true }],
      payoutTerms: {
        merged: { defaultPrimaryPayoutTermsId: deal.id },
        filled: [],
        carried: false,
      },
    });
  }, 120_000);

  test("merged owned, survivor unowned: the owner moves with the row, so the deal fills and grants stay live", async ({
    skip,
  }) => {
    const env = ready(skip);
    if (!env) return;
    const { db, repos } = env;
    const [actor, owner, act] = await Promise.all([
      db.human.create({ data: { name: "Admin", status: "ACTIVE" } }),
      db.human.create({ data: { name: "Merged owner", status: "ACTIVE" } }),
      db.human.create({ data: { name: "Granted act", status: "ACTIVE" } }),
    ]);
    const deal = await db.payoutTerms.create({ data: { kind: "PRIMARY", status: "ACTIVE" } });
    const survivor = await makePlace("The Underdog", `${NS}-ow-s`);
    const merged = await makePlace("Underdog Nashville", `${NS}-ow-m`);
    const ownership = await db.placeOwnership.create({
      data: { placeId: merged.id, ownerType: "HUMAN", ownerId: owner.id, verified: false },
    });
    await db.place.update({ where: { id: merged.id }, data: { defaultPrimaryPayoutTermsId: deal.id } });
    // What the incoming owner takes over at the survivor: one open request,
    // one live agreement (a DECLINED request and a CANCELLED agreement do not count).
    await makeRequest(survivor.id, survivor.calendarId, null, act.id);
    const closedReq = await makeRequest(survivor.id, survivor.calendarId, null, actor.id);
    await db.bookingRequest.update({ where: { id: closedReq.id }, data: { status: "DECLINED" } });
    for (const status of ["PROPOSED", "CANCELLED"] as const) {
      await db.agreement.create({
        data: {
          type: "PERFORMANCE",
          status,
          proposerType: "human",
          proposerId: act.id,
          counterpartyType: "human",
          counterpartyId: actor.id,
          title: `Booking ${status}`,
          placeId: survivor.id,
        },
      });
    }
    const waiver = await db.placeWaiver.create({
      data: { placeId: merged.id, title: "Merged rules", content: "B." },
    });
    const grant = await db.placeBookingGrant.create({
      data: {
        placeId: merged.id,
        calendarId: merged.calendarId,
        humanId: act.id,
        ...granteeOf(act.id),
        grantedByHumanId: owner.id,
      } as never,
    });

    const preview = await previewPlaceMerge(
      { repos, authz: allow },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(preview.blockers).toEqual([]);
    const codes = preview.warnings.map((w) => w.code);
    expect(codes).not.toContain("PAYOUT_DEFAULTS_NOT_CARRIED");
    expect(codes).not.toContain("GRANTS_ENDED");
    expect(codes).toContain("WAIVER_BECOMES_ACTIVE");
    expect(preview.warnings).toContainEqual({
      code: "OWNERSHIP_TRANSFERS",
      count: 1,
      owners: [{ ownerType: "HUMAN", ownerId: owner.id }],
      survivorOpenBookingRequests: 1,
      survivorLiveAgreements: 1,
    });

    const out = await mergePlaces(
      { repos, authz: allow, clock },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(out.filledFields).toContain("defaultPrimaryPayoutTermsId");
    expect(
      (await db.place.findUniqueOrThrow({ where: { id: survivor.id } })).defaultPrimaryPayoutTermsId,
    ).toBe(deal.id);
    expect(await db.placeOwnership.findUniqueOrThrow({ where: { id: ownership.id } })).toMatchObject({
      placeId: survivor.id,
      ownerId: owner.id,
      revokedAt: null,
    });
    expect(await db.placeBookingGrant.findUniqueOrThrow({ where: { id: grant.id } })).toMatchObject({
      placeId: survivor.id,
      calendarId: survivor.calendarId,
      revokedAt: null,
    });
    expect(await db.placeWaiver.findUniqueOrThrow({ where: { id: waiver.id } })).toMatchObject({
      placeId: survivor.id,
      isActive: true,
    });
    const data = await auditOf(survivor.id);
    expect(data.ownersCompatible).toBe(true);
    expect(data.operations).toMatchObject({
      bookingGrantsRevoked: [],
      waiversDeactivated: [],
      payoutTerms: { filled: ["defaultPrimaryPayoutTermsId"], carried: true },
    });
  }, 120_000);

  test("a merged place with no calendar: its whole-place grant ends instead of covering every survivor room", async ({
    skip,
  }) => {
    const env = ready(skip);
    if (!env) return;
    const { db, repos } = env;
    const [actor, act] = await Promise.all([
      db.human.create({ data: { name: "Admin", status: "ACTIVE" } }),
      db.human.create({ data: { name: "Resident act", status: "ACTIVE" } }),
    ]);
    const survivor = await makePlace("Belcourt", `${NS}-zc-s`);
    const merged = await makePlace("The Belcourt", `${NS}-zc-m`);
    // Strip the merged place to no calendars and no rooms.
    await db.calendar.delete({ where: { id: merged.calendarId } });
    await db.space.delete({ where: { id: merged.spaceId } });
    const grant = await db.placeBookingGrant.create({
      data: {
        placeId: merged.id,
        calendarId: null,
        humanId: act.id,
        ...granteeOf(act.id),
        grantedByHumanId: actor.id,
      } as never,
    });

    const preview = await previewPlaceMerge(
      { repos, authz: allow },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(preview.blockers).toEqual([]);
    expect(preview.warnings).toContainEqual({ code: "GRANTS_ENDED", count: 1, ids: [grant.id] });

    await mergePlaces(
      { repos, authz: allow, clock },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    const g = await db.placeBookingGrant.findUniqueOrThrow({ where: { id: grant.id } });
    expect(g).toMatchObject({ placeId: survivor.id, calendarId: null });
    expect(g.revokedAt).not.toBeNull();
    expect(
      await db.placeBookingGrant.count({ where: { placeId: survivor.id, revokedAt: null } }),
    ).toBe(0);
    const data = await auditOf(survivor.id);
    expect(data.operations).toMatchObject({ bookingGrantsRevoked: [grant.id], bookingGrantsSplit: [] });
  }, 120_000);

  test("image moderation records follow the place; dropped duplicates are kept in full in the audit", async ({
    skip,
  }) => {
    const env = ready(skip);
    if (!env) return;
    const { db, repos } = env;
    const [actor, reporter] = await Promise.all([
      db.human.create({ data: { name: "Admin", status: "ACTIVE" } }),
      db.human.create({ data: { name: "Reporter", status: "ACTIVE" } }),
    ]);
    const survivor = await makePlace("The Groove", `${NS}-im-s`);
    const merged = await makePlace("Groove Nashville", `${NS}-im-m`);
    const record = await db.imageModerationRecord.create({
      data: {
        storageKey: `${NS}/place/banner.jpg`,
        kind: "BANNER",
        subjectType: "PLACE",
        subjectId: merged.id,
      },
    });
    await db.entityReport.create({
      data: { subjectType: "PLACE", subjectId: survivor.id, reporterHumanId: reporter.id, reason: "CLOSED_OR_GONE" },
    });
    const dupReport = await db.entityReport.create({
      data: { subjectType: "PLACE", subjectId: merged.id, reporterHumanId: reporter.id, reason: "CLOSED_OR_GONE" },
    });

    const out = await mergePlaces(
      { repos, authz: allow, clock },
      { actorHumanId: actor.id, survivorId: survivor.id, mergedId: merged.id },
    );
    expect(out.moved.imageModerationRecords).toBe(1);
    expect((await db.imageModerationRecord.findUniqueOrThrow({ where: { id: record.id } })).subjectId).toBe(
      survivor.id,
    );
    const data = await auditOf(survivor.id);
    expect(data.movedIds.imageModerationRecords).toEqual([record.id]);
    expect(data.movedIds.droppedRows.entityReports).toEqual([
      expect.objectContaining({
        id: dupReport.id,
        subjectId: merged.id,
        reporterHumanId: reporter.id,
        reason: "CLOSED_OR_GONE",
      }),
    ]);
  }, 120_000);
});
