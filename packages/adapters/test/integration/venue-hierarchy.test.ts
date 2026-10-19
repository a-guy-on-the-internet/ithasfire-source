import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeSpacesRepo } from "../../src/db/prisma/spaces";
import { makeCalendarsRepo } from "../../src/db/prisma/calendars";
import { makeBookingRequestsRepo } from "../../src/db/prisma/booking-requests";
import { makeBookingRequestMessagesRepo } from "../../src/db/prisma/booking-request-messages";
import { makeEventsRepo } from "../../src/db/prisma/events";

// ---------------------------------------------------------------------------
// Venue-hierarchy adapter integration (Step 5;
// docs/specs/2026-08-18/completed/venue-hierarchy-and-holds.spec.yaml).
//
// Runs against REAL Postgres via `prisma migrate deploy` (which also proves
// the 20260818140000_booking_request_attachment_uploader migration replays on
// a fresh database). Client construction copies event-saves.test.ts EXACTLY —
// the repo's Prisma client runs in driver-adapter mode, so a bare
// `new PrismaClient()` throws and the whole suite would silently skip.
//
// Headline pin (the spec's #2 risk, FR-005): calendar rendering filters on
// Event.calendarId, NEVER via the CalendarSpace join — a space shared by two
// calendars must not bleed one stream's events onto the other's calendar.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-18T12:00:00.000Z");

describe("Prisma adapters integration – venue hierarchy", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let humanId: string;
  let placeId: string;
  let otherPlaceId: string;
  let defaultSpaceId: string;
  let otherDefaultSpaceId: string;

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

      const human = await prisma.human.create({
        data: { name: "Venue Owner", status: "ACTIVE" },
      });
      humanId = human.id;

      const place = await prisma.place.create({
        data: { name: "Drkmttr", address: "1111 Test Ave, Nashville, TN" },
      });
      placeId = place.id;

      const otherPlace = await prisma.place.create({
        data: { name: "Rival Venue", address: "2222 Foreign Rd" },
      });
      otherPlaceId = otherPlace.id;

      // Every calendar has ≥1 space (venue-confirmation spec): a default room
      // per place that every `calendars.create` below joins.
      defaultSpaceId = (
        await prisma.space.create({
          data: { placeId, name: "Default Room" },
        })
      ).id;
      otherDefaultSpaceId = (
        await prisma.space.create({
          data: { placeId: otherPlaceId, name: "Rival Default Room" },
        })
      ).id;
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("venue-hierarchy integration setup failed:", error);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  const ready = (skip: () => void): boolean => {
    if (runtimeError || !prisma) {
      skip();
      return false;
    }
    return true;
  };

  // ── (0) SETUP HONESTY GATE ────────────────────────────────────────────────
  // Every other test in this suite skips when setup failed, so without this
  // assertion a container/migrate/client-construction failure would report
  // as a fully-green suite of skips. This test does NOT skip: broken setup
  // FAILS the suite, loudly, with the captured error.
  test("setup succeeded (container + migrate deploy + driver-adapter client)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  /**
   * Fresh performer per booking request — the SQL-only partial unique
   * "BookingRequest_open_pair_key" allows only ONE open request per
   * (performer, place), so tests that each mint a request need distinct
   * performer identities.
   */
  const mkPerformer = async (name: string): Promise<string> => {
    const human = await prisma!.human.create({
      data: { name, status: "ACTIVE" },
    });
    return human.id;
  };

  // ── (a) SPACE-BLEED SQL PIN — FR-005, the spec's #2 risk ───────────────────

  test("a space shared by two calendars does NOT bleed events across calendars (listByCalendar filters on Event.calendarId)", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const spaces = makeSpacesRepo(prisma!);
    const calendars = makeCalendarsRepo(prisma!);
    const events = makeEventsRepo(prisma!);

    const sharedSpace = await spaces.create({ placeId, name: "Shared Floor" });
    const socialClub = await calendars.create({
      placeId,
      spaceIds: [defaultSpaceId],
      primarySpaceId: defaultSpaceId,
      name: "Social Club",
      slug: "social-club",
    });
    const liveMusic = await calendars.create({
      placeId,
      spaceIds: [defaultSpaceId],
      primarySpaceId: defaultSpaceId,
      name: "Live Music",
      slug: "live-music",
    });
    await calendars.setSpaces({
      calendarId: socialClub.id,
      spaceIds: [sharedSpace.id],
      primarySpaceId: sharedSpace.id,
    });
    await calendars.setSpaces({
      calendarId: liveMusic.id,
      spaceIds: [sharedSpace.id],
      primarySpaceId: sharedSpace.id,
    });

    const mkEvent = async (title: string) =>
      prisma!.event.create({
        data: {
          title,
          startsAt: new Date("2026-09-01T20:00:00.000Z"),
          endsAt: new Date("2026-09-01T23:00:00.000Z"),
          status: "PUBLISHED",
          humanId,
          placeId,
        },
      });
    const clubNight = await mkEvent("Club Night");
    const showcase = await mkEvent("Showcase");

    // Both events block the SAME physical space; each belongs to a DIFFERENT
    // programming stream.
    await events.setVenuePlacement({
      eventId: clubNight.id,
      calendarId: socialClub.id,
      spaceId: sharedSpace.id,
    });
    await events.setVenuePlacement({
      eventId: showcase.id,
      calendarId: liveMusic.id,
      spaceId: sharedSpace.id,
    });

    const window = {
      from: new Date("2026-09-01T00:00:00.000Z"),
      to: new Date("2026-09-02T00:00:00.000Z"),
    };
    const clubEvents = await events.listByCalendar({
      calendarId: socialClub.id,
      ...window,
    });
    const liveEvents = await events.listByCalendar({
      calendarId: liveMusic.id,
      ...window,
    });

    // A CalendarSpace-joined query would return BOTH events on BOTH calendars
    // (they share the space) — the direct calendarId filter must not.
    expect(clubEvents.map((e) => e.id)).toEqual([clubNight.id]);
    expect(liveEvents.map((e) => e.id)).toEqual([showcase.id]);
  }, 60_000);

  // ── (b) listByPlace / findDefaultForPlace equivalence ─────────────────────

  test("listByPlace's isDefault row IS findDefaultForPlace's row (default first, then name asc)", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const calendars = makeCalendarsRepo(prisma!);

    const main = await calendars.create({
      placeId: otherPlaceId,
      spaceIds: [otherDefaultSpaceId],
      primarySpaceId: otherDefaultSpaceId,
      name: "Zeta Main",
      slug: "main",
      isDefault: true,
    });
    await calendars.create({
      placeId: otherPlaceId,
      spaceIds: [otherDefaultSpaceId],
      primarySpaceId: otherDefaultSpaceId,
      name: "Alpha Stream",
      slug: "alpha",
    });

    const list = await calendars.listByPlace(otherPlaceId);
    expect(list.map((c) => c.slug)).toEqual(["main", "alpha"]); // default first
    expect(list.find((c) => c.isDefault)?.id).toBe(
      (await calendars.findDefaultForPlace(otherPlaceId))?.id,
    );
    expect(list.find((c) => c.isDefault)?.id).toBe(main.id);
  }, 60_000);

  // ── (c) P2002 mappings + availability scoping ─────────────────────────────

  test("duplicate (placeId, slug) maps to CALENDAR_SLUG_TAKEN; the same slug is fine at another place", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const calendars = makeCalendarsRepo(prisma!);

    await expect(
      calendars.create({ placeId, spaceIds: [defaultSpaceId], primarySpaceId: defaultSpaceId, name: "Dup", slug: "social-club" }),
    ).rejects.toMatchObject({ code: "CALENDAR_SLUG_TAKEN" });

    // Slug uniqueness is per-place — the rival venue can use it.
    await expect(
      calendars.create({
        placeId: otherPlaceId,
      spaceIds: [otherDefaultSpaceId],
      primarySpaceId: otherDefaultSpaceId,
        name: "Their Club",
        slug: "social-club",
      }),
    ).resolves.toMatchObject({ slug: "social-club" });
  }, 60_000);

  test("a SECOND default calendar for a place maps the partial-unique P2002 to a typed conflict", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const calendars = makeCalendarsRepo(prisma!);

    await calendars.create({
      placeId,
      spaceIds: [defaultSpaceId],
      primarySpaceId: defaultSpaceId,
      name: "Main",
      slug: "main",
      isDefault: true,
    });
    // Racing second default: loses on the SQL-only
    // "Calendar_placeId_default_key" partial unique.
    await expect(
      calendars.create({
        placeId,
        spaceIds: [defaultSpaceId],
        primarySpaceId: defaultSpaceId,
        name: "Usurper",
        slug: "usurper",
        isDefault: true,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "calendar_default_exists",
    });

    // …and the same via UPDATE (flipping a non-default to default).
    const nonDefault = await calendars.create({
      placeId,
      spaceIds: [defaultSpaceId],
      primarySpaceId: defaultSpaceId,
      name: "Side Stage",
      slug: "side-stage",
    });
    await expect(
      calendars.update({ id: nonDefault.id, isDefault: true }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "calendar_default_exists",
    });
  }, 60_000);

  test("eventTemplate: object JSON round-trips; non-object JSON (array/scalar) is guarded to null", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const calendars = makeCalendarsRepo(prisma!);

    const created = await calendars.create({
      placeId: otherPlaceId,
      spaceIds: [otherDefaultSpaceId],
      primarySpaceId: otherDefaultSpaceId,
      name: "Template Stream",
      slug: "template-stream",
      eventTemplate: { titleTemplate: "{act} at {calendar}" },
    });
    expect(created.eventTemplate).toEqual({
      titleTemplate: "{act} at {calendar}",
    });

    // Out-of-band writes can store ANY Json (the column admits arrays and
    // scalars) — the mapper must guard those to null, never as-cast them
    // into Record<string, unknown> (port doc mandate).
    await prisma!.calendar.update({
      where: { id: created.id },
      data: { eventTemplate: [1, 2, 3] },
    });
    expect((await calendars.findById(created.id))?.eventTemplate).toBeNull();

    await prisma!.calendar.update({
      where: { id: created.id },
      data: { eventTemplate: 42 },
    });
    expect((await calendars.findById(created.id))?.eventTemplate).toBeNull();

    // Explicit null on update clears via DbNull.
    await calendars.update({
      id: created.id,
      eventTemplate: { keep: true },
    });
    const cleared = await calendars.update({
      id: created.id,
      eventTemplate: null,
    });
    expect(cleared.eventTemplate).toBeNull();
  }, 60_000);

  test("place-wide availability rows (calendarId null) come back alongside calendar-scoped ones; deleteAvailability is place-scoped and idempotent", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const calendars = makeCalendarsRepo(prisma!);

    const [calendar] = await calendars.listByPlace(placeId);
    expect(calendar).toBeDefined();

    const scoped = await calendars.upsertAvailability({
      placeId,
      calendarId: calendar!.id,
      dayOfWeek: 5,
      startTime: "19:00",
      endTime: "23:00",
      isOpen: true,
    });
    const placeWide = await calendars.upsertAvailability({
      placeId,
      calendarId: null,
      date: new Date("2026-12-25T00:00:00.000Z"),
      isOpen: false,
      note: "Closed for the holiday",
    });

    // ONE merged read: calendar-scoped AND place-wide rows together (FR-007).
    const rows = await calendars.listAvailabilityForPlace(placeId);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(scoped.id);
    expect(ids).toContain(placeWide.id);
    expect(rows.find((r) => r.id === placeWide.id)?.calendarId).toBeNull();

    // Availability-onboarding detector: the count sees the SAME rows the list
    // does — place-wide AND calendar-scoped — and is place-isolated.
    expect(await calendars.countAvailabilityForPlace(placeId)).toBe(rows.length);
    expect(await calendars.countAvailabilityForPlace(otherPlaceId)).toBe(0);

    // Foreign placeId in the WHERE = zero rows matched = silent no-op (IDOR
    // backstop) — the row survives.
    await calendars.deleteAvailability({
      id: placeWide.id,
      placeId: otherPlaceId,
    });
    expect(
      (await calendars.listAvailabilityForPlace(placeId)).map((r) => r.id),
    ).toContain(placeWide.id);

    // Correctly-scoped delete lands; the repeat is an idempotent no-op.
    await calendars.deleteAvailability({ id: placeWide.id, placeId });
    await calendars.deleteAvailability({ id: placeWide.id, placeId });
    expect(
      (await calendars.listAvailabilityForPlace(placeId)).map((r) => r.id),
    ).not.toContain(placeWide.id);
  }, 60_000);

  // ── (d) listByCalendar take clamp + booking-request tags ──────────────────

  test("listByCalendar clamps a provided limit into [1, 100] as SQL take", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const calendars = makeCalendarsRepo(prisma!);
    const events = makeEventsRepo(prisma!);

    const calendar = await calendars.create({
      placeId,
      spaceIds: [defaultSpaceId],
      primarySpaceId: defaultSpaceId,
      name: "Clamp Stream",
      slug: "clamp-stream",
    });
    for (let i = 0; i < 3; i += 1) {
      const event = await prisma!.event.create({
        data: {
          title: `Clamp ${i}`,
          startsAt: new Date(`2026-10-0${i + 1}T20:00:00.000Z`),
          endsAt: new Date(`2026-10-0${i + 1}T23:00:00.000Z`),
          status: "PUBLISHED",
          humanId,
          placeId,
        },
      });
      await events.setVenuePlacement({
        eventId: event.id,
        calendarId: calendar.id,
        spaceId: null,
      });
    }

    const window = {
      from: new Date("2026-10-01T00:00:00.000Z"),
      to: new Date("2026-10-31T00:00:00.000Z"),
    };
    const limited = await events.listByCalendar({
      calendarId: calendar.id,
      ...window,
      limit: 2,
    });
    expect(limited).toHaveLength(2);

    // Sub-1 input clamps UP to 1 (never take: 0 / negative).
    const clampedLow = await events.listByCalendar({
      calendarId: calendar.id,
      ...window,
      limit: 0,
    });
    expect(clampedLow).toHaveLength(1);

    // Omitted = no take: the whole window comes back.
    const all = await events.listByCalendar({
      calendarId: calendar.id,
      ...window,
    });
    expect(all).toHaveLength(3);
  }, 60_000);

  test("booking-request tags persist verbatim on create", async ({ skip }) => {
    if (!ready(skip)) return;
    const bookingRequests = makeBookingRequestsRepo(prisma!);

    const created = await bookingRequests.create({
      placeId,
      performerOwnerType: "human",
      performerOwnerId: await mkPerformer("Tags Performer"),
      message: "Tags pitch",
      preferredDates: ["2026-11-01"],
      tags: ["indie rock", "DIY", "loud"],
      expiresAt: new Date("2026-09-01T12:00:00.000Z"),
    });

    expect(created.tags).toEqual(["indie rock", "DIY", "loud"]);
    const refetched = await bookingRequests.getById(created.id);
    expect(refetched?.tags).toEqual(["indie rock", "DIY", "loud"]);
  }, 60_000);

  // ── (e) Booking-request messages + attachments ────────────────────────────

  test("message cursor walk: createdAt asc / id asc pages, cursor = last row id", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const bookingRequests = makeBookingRequestsRepo(prisma!);
    const messages = makeBookingRequestMessagesRepo(prisma!);

    const request = await bookingRequests.create({
      placeId,
      performerOwnerType: "human",
      performerOwnerId: await mkPerformer("Cursor Performer"),
      message: "Cursor thread",
      preferredDates: ["2026-11-02"],
      expiresAt: new Date("2026-09-01T12:00:00.000Z"),
      contactPhone: null,
    });

    // Force equal createdAt across ALL rows so ordering falls back to the id
    // tiebreak — the hardest case for keyset resume.
    const bodies = ["m1", "m2", "m3", "m4", "m5"];
    for (const body of bodies) {
      await messages.create({
        bookingRequestId: request.id,
        authorSide: body === "m3" ? "PERFORMER" : "VENUE",
        body,
      });
    }
    await prisma!.bookingRequestMessage.updateMany({
      where: { bookingRequestId: request.id },
      data: { createdAt: NOW },
    });

    const page1 = await messages.listForRequest({
      bookingRequestId: request.id,
      limit: 2,
    });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBe(page1.items[1]!.id);

    const page2 = await messages.listForRequest({
      bookingRequestId: request.id,
      cursor: page1.nextCursor,
      limit: 2,
    });
    expect(page2.items).toHaveLength(2);
    const page3 = await messages.listForRequest({
      bookingRequestId: request.id,
      cursor: page2.nextCursor,
      limit: 2,
    });
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    // Full walk = every message exactly once, in id-asc order (equal
    // timestamps), i.e. no skip and no double-serve across boundaries.
    const walked = [...page1.items, ...page2.items, ...page3.items].map(
      (m) => m.id,
    );
    expect(new Set(walked).size).toBe(5);
    expect(walked).toEqual([...walked].sort());
  }, 60_000);

  // INVERTED with the system-entry migration: SYSTEM rows are LEDGER ENTRIES
  // now, and an entry can never be unread — so markRead must not stamp one
  // (a read receipt for a state that does not exist), and the unread count
  // must not count one. The two WHEREs stay exact complements.
  test("markRead stamps ONLY counterparty rows up to the cutoff, never SYSTEM, idempotently", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const bookingRequests = makeBookingRequestsRepo(prisma!);
    const messages = makeBookingRequestMessagesRepo(prisma!);

    const request = await bookingRequests.create({
      placeId,
      performerOwnerType: "human",
      performerOwnerId: await mkPerformer("Read Performer"),
      message: "Read-receipt thread",
      preferredDates: ["2026-11-03"],
      expiresAt: new Date("2026-09-01T12:00:00.000Z"),
    });

    const venueMsg = await messages.create({
      bookingRequestId: request.id,
      authorSide: "VENUE",
      body: "from venue",
    });
    const performerMsg = await messages.create({
      bookingRequestId: request.id,
      authorSide: "PERFORMER",
      body: "from performer",
    });
    const systemMsg = await messages.create({
      bookingRequestId: request.id,
      authorSide: "SYSTEM",
      // A ledger entry: empty body, kind + params carry the meaning.
      body: "",
      systemKind: "booking_request.viewed",
      systemData: {},
    });
    const lateMsg = await messages.create({
      bookingRequestId: request.id,
      authorSide: "PERFORMER",
      body: "after the cutoff",
    });
    // Deterministic timestamps: three before the cutoff, one after.
    const cutoff = new Date("2026-08-18T13:00:00.000Z");
    await prisma!.bookingRequestMessage.update({
      where: { id: lateMsg.id },
      data: { createdAt: new Date("2026-08-18T14:00:00.000Z") },
    });
    for (const id of [venueMsg.id, performerMsg.id, systemMsg.id]) {
      await prisma!.bookingRequestMessage.update({
        where: { id },
        data: { createdAt: NOW },
      });
    }

    // VENUE reads: only the PERFORMER row at/before the cutoff gets stamped.
    // The venue's own message, the SYSTEM entry and the post-cutoff row do not.
    const stamped = await messages.markRead({
      bookingRequestId: request.id,
      side: "VENUE",
      upToCreatedAt: cutoff,
    });
    expect(stamped).toBe(1);

    const rows = await prisma!.bookingRequestMessage.findMany({
      where: { bookingRequestId: request.id },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(performerMsg.id)!.readAt).not.toBeNull();
    // The inversion, against real Postgres.
    expect(byId.get(systemMsg.id)!.readAt).toBeNull();
    expect(byId.get(venueMsg.id)!.readAt).toBeNull(); // own message untouched
    expect(byId.get(lateMsg.id)!.readAt).toBeNull(); // after the cutoff

    // The entry round-trips its kind and params through jsonb, so the timeline
    // has something to render.
    expect(byId.get(systemMsg.id)!.systemKind).toBe("booking_request.viewed");
    expect(byId.get(systemMsg.id)!.systemData).toEqual({});
    expect(byId.get(systemMsg.id)!.body).toBe("");

    // Idempotent: a repeat stamps nothing and existing stamps don't move.
    const before = byId.get(performerMsg.id)!.readAt;
    expect(
      await messages.markRead({
        bookingRequestId: request.id,
        side: "VENUE",
        upToCreatedAt: cutoff,
      }),
    ).toBe(0);
    const after = await prisma!.bookingRequestMessage.findUnique({
      where: { id: performerMsg.id },
    });
    expect(after!.readAt!.getTime()).toBe(before!.getTime());
  }, 60_000);

  test("touchLastMessageAt is monotonic (never moves backwards; equal timestamp is a no-op)", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const bookingRequests = makeBookingRequestsRepo(prisma!);

    const request = await bookingRequests.create({
      placeId,
      performerOwnerType: "human",
      performerOwnerId: await mkPerformer("Recency Performer"),
      message: "Recency thread",
      preferredDates: ["2026-11-04"],
      expiresAt: new Date("2026-09-01T12:00:00.000Z"),
    });

    const t1 = new Date("2026-08-18T12:00:00.000Z");
    const t2 = new Date("2026-08-18T13:00:00.000Z");

    await bookingRequests.touchLastMessageAt({ id: request.id, at: t2 });
    // Out-of-order commit: an EARLIER stamp must not clobber the newer one.
    await bookingRequests.touchLastMessageAt({ id: request.id, at: t1 });
    // Equal timestamp: no-op (lt, not lte — the stamp never churns in place).
    await bookingRequests.touchLastMessageAt({ id: request.id, at: t2 });

    const row = await prisma!.bookingRequest.findUnique({
      where: { id: request.id },
      select: { lastMessageAt: true },
    });
    expect(row!.lastMessageAt!.getTime()).toBe(t2.getTime());
  }, 60_000);

  test("attachments: add records the uploader, list is live-only, softDelete stamps ONCE (didStamp) and is request-scoped", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const bookingRequests = makeBookingRequestsRepo(prisma!);

    const request = await bookingRequests.create({
      placeId,
      performerOwnerType: "human",
      performerOwnerId: await mkPerformer("Attachment Performer"),
      message: "Attachment thread",
      preferredDates: ["2026-11-05"],
      expiresAt: new Date("2026-09-01T12:00:00.000Z"),
    });

    const attachment = await bookingRequests.addAttachment({
      bookingRequestId: request.id,
      storageKey: `booking-requests/${request.id}/rider.pdf`,
      fileName: "rider.pdf",
      contentType: "application/pdf",
      sizeBytes: 1234,
      uploadedBySide: "PERFORMER",
      uploadedByHumanId: humanId,
    });
    // Uploader columns persist and round-trip (uploader-or-venue posture).
    expect(attachment.uploadedBySide).toBe("PERFORMER");
    expect(attachment.uploadedByHumanId).toBe(humanId);

    const listed = await bookingRequests.listAttachments(request.id);
    expect(listed.map((a) => a.id)).toEqual([attachment.id]);
    expect(listed[0]!.uploadedBySide).toBe("PERFORMER");

    // Cross-request scoping: a foreign bookingRequestId matches zero rows.
    const foreign = await bookingRequests.softDeleteAttachment({
      id: attachment.id,
      bookingRequestId: "00000000-0000-4000-8000-000000000000",
    });
    expect(foreign).toBeNull();
    expect(await bookingRequests.listAttachments(request.id)).toHaveLength(1);

    // First delete stamps (didStamp true); the repeat returns the SAME
    // record with didStamp false (double-GC protection).
    const first = await bookingRequests.softDeleteAttachment({
      id: attachment.id,
      bookingRequestId: request.id,
    });
    expect(first).toMatchObject({ didStamp: true });
    expect(first!.record.deletedAt).not.toBeNull();

    const second = await bookingRequests.softDeleteAttachment({
      id: attachment.id,
      bookingRequestId: request.id,
    });
    expect(second).toMatchObject({ didStamp: false });
    expect(second!.record.deletedAt!.getTime()).toBe(
      first!.record.deletedAt!.getTime(),
    );

    // Soft-deleted rows leave the live list.
    expect(await bookingRequests.listAttachments(request.id)).toHaveLength(0);
  }, 60_000);

  // ── (f) Spaces lifecycle ───────────────────────────────────────────────────

  test("spaces: setStatus flips lifecycle, countActiveForPlace counts ACTIVE only, listByPlace hides RETIRED by default", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const spaces = makeSpacesRepo(prisma!);

    const before = await spaces.countActiveForPlace(otherPlaceId);
    const front = await spaces.create({ placeId: otherPlaceId, name: "Front" });
    const back = await spaces.create({
      placeId: otherPlaceId,
      name: "Back",
      sortOrder: 1,
      capacity: 80,
    });
    expect(await spaces.countActiveForPlace(otherPlaceId)).toBe(before + 2);

    const retired = await spaces.setStatus({ id: back.id, status: "RETIRED" });
    expect(retired.status).toBe("RETIRED");
    expect(await spaces.countActiveForPlace(otherPlaceId)).toBe(before + 1);

    // Default list = ACTIVE only; includeRetired shows history.
    const active = await spaces.listByPlace({ placeId: otherPlaceId });
    expect(active.map((r) => r.id)).toContain(front.id);
    expect(active.map((r) => r.id)).not.toContain(back.id);
    const all = await spaces.listByPlace({
      placeId: otherPlaceId,
      includeRetired: true,
    });
    expect(all.map((r) => r.id)).toContain(back.id);

    // findByIds: batch twin — unknown ids simply absent, empty set = [].
    const found = await spaces.findByIds([front.id, back.id, "missing-id"]);
    expect(found.map((r) => r.id).sort()).toEqual([front.id, back.id].sort());
    expect(await spaces.findByIds([])).toEqual([]);

    // Reactivation restores scheduling.
    await spaces.setStatus({ id: back.id, status: "ACTIVE" });
    expect(await spaces.countActiveForPlace(otherPlaceId)).toBe(before + 2);
  }, 60_000);

  // ── (g) upsertDraft carries the placement columns (Step 9, FR-005/FR-011) ──
  // The quick-create save path stamps calendarId/spaceId in the SAME write that
  // creates the event — no second `setVenuePlacement` pass. These pin the
  // adapter's half of that: the create branch writes them, and the update
  // branch honours Prisma patch semantics (absent = untouched, null = clear)
  // even though it hard-resets placeId and friends on every save.

  test("upsertDraft CREATE writes calendarId + spaceId in the same INSERT", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const spaces = makeSpacesRepo(prisma!);
    const calendars = makeCalendarsRepo(prisma!);
    const events = makeEventsRepo(prisma!);

    const space = await spaces.create({ placeId, name: "Placement Space" });
    const calendar = await calendars.create({
      placeId,
      spaceIds: [defaultSpaceId],
      primarySpaceId: defaultSpaceId,
      name: "Placement Stream",
      slug: "placement-stream",
    });

    const created = await events.upsertDraft({
      orgId: null,
      humanId,
      title: "Quick-created from a cell",
      startsAt: new Date("2026-12-01T20:00:00.000Z"),
      endsAt: new Date("2026-12-01T22:00:00.000Z"),
      status: "DRAFT",
      location: { kind: "place", placeId },
      calendarId: calendar.id,
      spaceId: space.id,
    });

    expect(created.calendarId).toBe(calendar.id);
    expect(created.spaceId).toBe(space.id);

    // Read straight from SQL — the mapper could be lying.
    const row = await prisma!.event.findUniqueOrThrow({
      where: { id: created.id },
      select: { calendarId: true, spaceId: true, placeId: true },
    });
    expect(row).toEqual({
      calendarId: calendar.id,
      spaceId: space.id,
      placeId,
    });

    // …and the event lands on its calendar's stream for real.
    const onCalendar = await events.listByCalendar({
      calendarId: calendar.id,
      from: new Date("2026-12-01T00:00:00.000Z"),
      to: new Date("2026-12-02T00:00:00.000Z"),
    });
    expect(onCalendar.map((e) => e.id)).toEqual([created.id]);
  }, 60_000);

  test("upsertDraft CREATE leaves both columns null when no placement is sent", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const events = makeEventsRepo(prisma!);

    const created = await events.upsertDraft({
      orgId: null,
      humanId,
      title: "Unplaced draft",
      startsAt: new Date("2026-12-02T20:00:00.000Z"),
      endsAt: new Date("2026-12-02T22:00:00.000Z"),
      status: "DRAFT",
      location: { kind: "place", placeId },
    });

    expect(created.calendarId).toBeNull();
    expect(created.spaceId).toBeNull();
  }, 60_000);

  test("upsertDraft UPDATE patches placement: absent = untouched, null = clear", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const spaces = makeSpacesRepo(prisma!);
    const calendars = makeCalendarsRepo(prisma!);
    const events = makeEventsRepo(prisma!);

    const space = await spaces.create({ placeId, name: "Patch Space" });
    const calendar = await calendars.create({
      placeId,
      spaceIds: [defaultSpaceId],
      primarySpaceId: defaultSpaceId,
      name: "Patch Stream",
      slug: "patch-stream",
    });

    const base = {
      orgId: null,
      humanId,
      title: "Patch me",
      startsAt: new Date("2026-12-03T20:00:00.000Z"),
      endsAt: new Date("2026-12-03T22:00:00.000Z"),
      status: "DRAFT" as const,
      location: { kind: "place" as const, placeId },
    };

    const created = await events.upsertDraft({
      ...base,
      calendarId: calendar.id,
      spaceId: space.id,
    });

    // (1) An unrelated edit that omits the keys must NOT wipe the placement —
    // this branch hard-resets placeId/addressText/etc, and placement must not
    // ride along with that reset.
    const untouched = await events.upsertDraft({
      ...base,
      eventId: created.id,
      title: "Patch me (renamed)",
    });
    expect(untouched.title).toBe("Patch me (renamed)");
    expect(untouched.calendarId).toBe(calendar.id);
    expect(untouched.spaceId).toBe(space.id);

    // (2) Explicit nulls clear — the "event left this venue" path.
    const cleared = await events.upsertDraft({
      ...base,
      eventId: created.id,
      calendarId: null,
      spaceId: null,
    });
    expect(cleared.calendarId).toBeNull();
    expect(cleared.spaceId).toBeNull();

    const row = await prisma!.event.findUniqueOrThrow({
      where: { id: created.id },
      select: { calendarId: true, spaceId: true },
    });
    expect(row).toEqual({ calendarId: null, spaceId: null });
  }, 60_000);

  // ── (k) OCCUPANCY SPACE NARROWING — real SQL, not an object literal ────────
  //
  // `listPublishedOccurrencesByPlace`'s space filter decides whether a public
  // booking date picker offers a night. Its unit tests assert on the object
  // handed to `findMany`, which proves the code's INTENT and nothing about
  // Postgres. Two behaviours here are only true if the database agrees:
  //
  //   1. A sibling `AND` next to the existing window `OR` at the same `where`
  //      level CONJOINS them. If Prisma merged or dropped either, the filter
  //      would silently widen to the whole place — the exact bug being fixed.
  //   2. `spaceId: { in: [] }` compiles to a FALSE predicate rather than being
  //      dropped as an empty filter. If it were dropped, a calendar with no
  //      spaces joined would match every event at the venue.
  //
  // And the load-bearing invariant: a NULL-space event has UNKNOWN placement
  // and must survive every space filter. Dropping it would report a room as
  // free on a night it is actually booked.

  test("listPublishedOccurrencesByPlace narrows to the named spaces AND always keeps null-space events", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const spaces = makeSpacesRepo(prisma!);
    const events = makeEventsRepo(prisma!);

    // A place of its own: this suite reuses `placeId` across tests, and a
    // stray published event from an earlier case would make the counts lie.
    const venue = await prisma!.place.create({
      data: { name: "Two-Space Venue", address: "3333 Occupancy Way" },
    });
    const stage = await spaces.create({
      placeId: venue.id,
      name: "Main Stage",
    });
    const backBar = await spaces.create({
      placeId: venue.id,
      name: "Back Bar",
    });

    const mkEvent = async (title: string, spaceId: string | null) => {
      const row = await prisma!.event.create({
        data: {
          title,
          startsAt: new Date("2026-10-07T20:00:00.000Z"),
          endsAt: new Date("2026-10-07T23:00:00.000Z"),
          status: "PUBLISHED",
          humanId,
          placeId: venue.id,
        },
      });
      if (spaceId) {
        await events.setVenuePlacement({
          eventId: row.id,
          calendarId: null,
          spaceId,
        });
      }
      return row;
    };

    const onStage = await mkEvent("Main Stage Headliner", stage.id);
    const inBackBar = await mkEvent("Back Bar DJ", backBar.id);
    const unplaced = await mkEvent("Legacy Show (no space)", null);

    const window = {
      placeId: venue.id,
      from: new Date("2026-10-01T00:00:00.000Z"),
      to: new Date("2026-10-31T00:00:00.000Z"),
    };
    const titlesOf = (rows: Array<{ eventId: string }>) =>
      rows.map((r) => r.eventId).sort();

    // (1) No filter — the whole place, unchanged pre-hierarchy behaviour.
    const all = await events.listPublishedOccurrencesByPlace(window);
    expect(titlesOf(all)).toEqual(
      [onStage.id, inBackBar.id, unplaced.id].sort(),
    );

    // (2) Narrowed to the main stage: the back bar's show is gone, the
    // unplaced one is NOT. This is the headline fix, proven against Postgres.
    const stageOnly = await events.listPublishedOccurrencesByPlace({
      ...window,
      spaceIds: [stage.id],
    });
    expect(titlesOf(stageOnly)).toEqual([onStage.id, unplaced.id].sort());
    expect(titlesOf(stageOnly)).not.toContain(inBackBar.id);
    // The spaceId round-trips as stored, including the null.
    expect(
      stageOnly
        .map((r) => [r.eventId, r.spaceId])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual(
      [
        [onStage.id, stage.id],
        [unplaced.id, null],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );

    // (3) The mirror: narrowing to the back bar frees the main stage.
    const backBarOnly = await events.listPublishedOccurrencesByPlace({
      ...window,
      spaceIds: [backBar.id],
    });
    expect(titlesOf(backBarOnly)).toEqual([inBackBar.id, unplaced.id].sort());

    // (4) Both spaces — everything, via the IN list rather than by omission.
    const both = await events.listPublishedOccurrencesByPlace({
      ...window,
      spaceIds: [stage.id, backBar.id],
    });
    expect(titlesOf(both)).toEqual(
      [onStage.id, inBackBar.id, unplaced.id].sort(),
    );

    // (5) EMPTY array: `in: []` must be a false predicate, not a dropped
    // filter. Only the unknown-placement event survives.
    const none = await events.listPublishedOccurrencesByPlace({
      ...window,
      spaceIds: [],
    });
    expect(titlesOf(none)).toEqual([unplaced.id]);

    // (6) The sibling AND really does conjoin with the window OR: the same
    // space filter over a window containing NO occurrence returns nothing.
    const outOfWindow = await events.listPublishedOccurrencesByPlace({
      placeId: venue.id,
      from: new Date("2027-01-01T00:00:00.000Z"),
      to: new Date("2027-01-31T00:00:00.000Z"),
      spaceIds: [stage.id],
    });
    expect(outOfWindow).toEqual([]);
  }, 60_000);
});
