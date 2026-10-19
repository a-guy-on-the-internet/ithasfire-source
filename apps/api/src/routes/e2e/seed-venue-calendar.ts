/**
 * E2E seed: Venue Calendar fixtures (event-calendar-redesign, docs/specs/2026-09-02).
 *
 * POST /e2e/seed/venue-calendar          → mint fixture, return ids
 * POST /e2e/seed/venue-calendar/cleanup  → delete everything it minted
 *
 * SELF-CLEANING BY DESIGN, and deliberately NOT behind `resetE2eState`.
 * The spec that drives this (apps/web/e2e/venue-calendar.spec.ts) has to be
 * runnable against a LIVE dev stack (`E2E_USE_LIVE_STACK=1`), where
 * `resetE2eState` refuses to run at all — it would wipe the seeded dev
 * database. Every row created here hangs off the returned `orgId` / `placeId`
 * and `/cleanup` removes all of it.
 *
 * WHAT THE REDESIGNED CALENDAR NEEDS THAT THE OLD FIXTURE HAD NONE OF:
 *   · a PlaceOwnership row, so the org actually owns the venue. Without it
 *     `getVenueCalendar` throws NOT_RESOURCE_OWNER and the page renders its
 *     access-denied screen; every event also reads as a THIRD-PARTY listing,
 *     which routes a chip press to the Confirm/Not-mine dialog instead of the
 *     peek (FR-014).
 *   · two named Calendars with DIFFERENT opening hours, so the toolbar's
 *     calendar selector (FR-012) and the week hours window (FR-011/FR-005)
 *     have something to select between and to union.
 *   · a Space shared by two overlapping events, so `detectConflicts` produces
 *     the double-booking the heading badge reports.
 *   · live BookingHolds — a two-deep ACTIVE line and a CHALLENGED one — for
 *     the hold chips and the reduced hold peek (FR-016).
 *
 * Everything is placed at fixed offsets from "today" in the VENUE's zone and
 * the day keys come back in the payload, so the spec deep-links
 * (`?view=…&date=…`) instead of doing calendar arithmetic in the browser.
 */
import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@th/db";

import {
  assertE2eAuthorized,
  formatError,
  resolveHumanId,
  seedFeePolicy,
} from "./_helpers.js";

/** The venue's zone. Fixed so hour strings in the spec are deterministic. */
const VENUE_TZ = "America/Chicago";

/** Hours, per calendar, as wall clock in `VENUE_TZ` (CalendarAvailability). */
const MAIN_HOURS = { start: "17:00", end: "23:00" } as const;
const BACK_HOURS = { start: "12:00", end: "15:00" } as const;
/** What `describeHoursWindow` renders for each scope — asserted verbatim. */
const HOURS_MAIN = "5:00 PM – 11:00 PM";
const HOURS_BACK = "12:00 PM – 3:00 PM";
const HOURS_ALL = "12:00 PM – 11:00 PM";

const MAIN_DEFAULT_START_TIME = "20:00";

// ── Zone maths (no luxon in apps/api) ───────────────────────────────────────

/** `date`'s offset from UTC in `zone`, in ms, at that instant. */
function zoneOffsetMs(date: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - date.getTime();
}

/** The instant at which `zone`'s wall clock reads the given local time. */
function zonedInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = zoneOffsetMs(new Date(guess), zone);
  const candidate = new Date(guess - first);
  // One correction pass covers a DST boundary between the guess and the
  // answer (the offset used to subtract was read at the wrong instant).
  const second = zoneOffsetMs(candidate, zone);
  return second === first ? candidate : new Date(guess - second);
}

/** `YYYY-MM-DD` as `zone` sees `date`. */
function dayKeyIn(date: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Venue-local midnight of `today + offsetDays`, as `{ key, y, m, d }`. */
function venueDay(now: Date, offsetDays: number) {
  const key = dayKeyIn(new Date(now.getTime() + offsetDays * 86_400_000), VENUE_TZ);
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return { key, y, m, d };
}

/**
 * A `@db.Date` value for a venue-local calendar day. Prisma writes DATE
 * columns from the instant's UTC calendar day, so UTC midnight of the key is
 * the value that reads back as that same day (the convention
 * `booking-holds.ts`'s `isoDateToDb` uses).
 */
function dbDate(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

const seedVenueCalendar: FastifyPluginAsync = async (app) => {
  app.post("/e2e/seed/venue-calendar", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as { email?: string };
    const email = body.email ?? "playwright-setup@example.com";
    const now = new Date();

    try {
      const humanId = await resolveHumanId({ email });
      if (!humanId) {
        return reply.status(400).send({
          ok: false,
          error: "human_not_found",
          message: `No human found for email ${email}. Run auth setup first.`,
        });
      }

      const stamp = Date.now();

      // ── Org + membership ────────────────────────────────────────────
      const orgSlug = `e2e-cal-${stamp}`;
      const org = await prisma.organization.create({
        data: {
          name: "E2E Calendar Org",
          slug: orgSlug,
          status: "ACTIVE",
          defaultLocale: null,
        },
      });
      await prisma.orgMember.create({
        data: { orgId: org.id, humanId, role: "OWNER" },
      });

      // ── Place + ownership ───────────────────────────────────────────
      const placeName = "E2E Test Venue";
      const place = await prisma.place.create({
        data: {
          name: placeName,
          address: "100 Calendar St, Test City, TS 00001",
          city: "Test City",
          region: "TS",
          country: "US",
          status: "ACTIVE",
          verification: "VERIFIED",
          timezone: VENUE_TZ,
        },
      });
      // Without this the org does not own the venue: the admin read throws
      // NOT_RESOURCE_OWNER and every event reads as third-party.
      await prisma.placeOwnership.create({
        data: {
          placeId: place.id,
          ownerType: "ORGANIZATION",
          ownerId: org.id,
          verified: true,
        },
      });

      // ── Rooms + calendars ───────────────────────────────────────────
      const mainSpace = await prisma.space.create({
        data: { placeId: place.id, name: "E2E Main Stage", sortOrder: 0 },
      });
      const backSpace = await prisma.space.create({
        data: { placeId: place.id, name: "E2E Back Room", sortOrder: 1 },
      });

      const mainCalendar = await prisma.calendar.create({
        data: {
          placeId: place.id,
          name: "E2E Main Room",
          slug: "e2e-main-room",
          isDefault: true,
          defaultStartTime: MAIN_DEFAULT_START_TIME,
          // Every Calendar names a PRIMARY space, FK-pinned to an ACTIVE one
          // (migration 20260924120000_calendar_primary_space) that must ALSO be
          // one of its own CalendarSpace joins (migration
          // 20260924160000_calendar_primary_space_joined). That second FK is
          // DEFERRABLE INITIALLY DEFERRED — checked at the end of the ENCLOSING
          // transaction, which in autocommit is the end of this statement. Hence
          // the NESTED join write (one transaction) instead of the follow-up
          // `createMany` this replaced, which would have failed outright.
          primarySpaceId: mainSpace.id,
          calendarSpaces: { create: [{ spaceId: mainSpace.id }] },
        },
      });
      const backCalendar = await prisma.calendar.create({
        data: {
          placeId: place.id,
          name: "E2E Back Bar",
          slug: "e2e-back-bar",
          isDefault: false,
          primarySpaceId: backSpace.id,
          calendarSpaces: { create: [{ spaceId: backSpace.id }] },
        },
      });

      // Weekly hours, both calendars, every weekday — so the week view's
      // hours window is the same whichever week the run lands in.
      await prisma.calendarAvailability.createMany({
        data: [0, 1, 2, 3, 4, 5, 6].flatMap((dayOfWeek) => [
          {
            placeId: place.id,
            calendarId: mainCalendar.id,
            dayOfWeek,
            startTime: MAIN_HOURS.start,
            endTime: MAIN_HOURS.end,
            isOpen: true,
          },
          {
            placeId: place.id,
            calendarId: backCalendar.id,
            dayOfWeek,
            startTime: BACK_HOURS.start,
            endTime: BACK_HOURS.end,
            isOpen: true,
          },
        ]),
      });

      // ── Fee policy / payout terms ───────────────────────────────────
      const feePolicy = await seedFeePolicy({
        notes: "e2e-venue-calendar",
        createdBy: humanId,
      });
      const makePayoutTerms = () =>
        prisma.payoutTerms.create({
          data: {
            kind: "PRIMARY",
            version: 1,
            isDefault: true,
            settlementCurrency: "usd",
            status: "ACTIVE",
            feePolicyId: feePolicy.id,
          },
        });

      // ── Events ──────────────────────────────────────────────────────
      const today = venueDay(now, 0);
      const tomorrow = venueDay(now, 1);
      const conflictDay = venueDay(now, 2);
      const futureDay = venueDay(now, 3);
      const cancelledDay = venueDay(now, 4);
      const series1Day = venueDay(now, 5);
      const series2Day = venueDay(now, 12);
      const activeHoldDay = venueDay(now, 6);
      const challengedHoldDay = venueDay(now, 7);

      let eventSeq = 0;
      async function makeEvent(args: {
        title: string;
        day: { y: number; m: number; d: number };
        startHour: number;
        durationHours: number;
        status: "PUBLISHED" | "DRAFT" | "COMPLETED" | "CANCELLED";
        spaceId?: string;
        calendarId?: string;
      }) {
        const startsAt = zonedInstant(
          args.day.y,
          args.day.m,
          args.day.d,
          args.startHour,
          0,
          VENUE_TZ,
        );
        const endsAt = new Date(
          startsAt.getTime() + args.durationHours * 3_600_000,
        );
        const terms = await makePayoutTerms();
        eventSeq += 1;
        return prisma.event.create({
          data: {
            title: args.title,
            orgId: org.id,
            placeId: place.id,
            calendarId: args.calendarId ?? mainCalendar.id,
            spaceId: args.spaceId ?? mainSpace.id,
            startsAt,
            endsAt,
            status: args.status,
            visibility: "PUBLIC",
            gateType: "NONE",
            timezone: VENUE_TZ,
            slug: `e2e-cal-${stamp}-${eventSeq}`,
            addressText: "100 Calendar St, Test City, TS 00001",
            locality: "Test City",
            region: "TS",
            payoutTermsId: terms.id,
          },
        });
      }

      const eventToday = await makeEvent({
        title: "Today Live Show",
        day: today,
        startHour: 19,
        durationHours: 2,
        status: "PUBLISHED",
      });
      const eventTomorrow = await makeEvent({
        title: "Tomorrow Draft Gig",
        day: tomorrow,
        startHour: 20,
        durationHours: 1,
        status: "DRAFT",
      });
      // Same room, overlapping window ⇒ exactly one double-booking pair.
      const conflictA = await makeEvent({
        title: "Double Booked A",
        day: conflictDay,
        startHour: 20,
        durationHours: 3,
        status: "PUBLISHED",
      });
      const conflictB = await makeEvent({
        title: "Double Booked B",
        day: conflictDay,
        startHour: 21,
        durationHours: 2,
        status: "PUBLISHED",
      });
      const eventFuture = await makeEvent({
        title: "Weekend Concert",
        day: futureDay,
        startHour: 19,
        durationHours: 2,
        status: "PUBLISHED",
      });
      // CANCELLED is off by default (PLACE_DEFAULT_STATUSES) — the status
      // filter chip is the only thing that can reveal it.
      const eventCancelled = await makeEvent({
        title: "Scrapped Show",
        day: cancelledDay,
        startHour: 19,
        durationHours: 2,
        status: "CANCELLED",
      });

      // ── Series ──────────────────────────────────────────────────────
      const series = await prisma.eventSeries.create({
        data: {
          ownerScope: "ORGANIZATION",
          ownerId: org.id,
          name: "Friday Night Jazz",
          nameNormalized: `friday-night-jazz-${stamp}`,
          timezone: VENUE_TZ,
          schedule: { freq: "weekly", day: 5 },
          createdByHumanId: humanId,
        },
      });
      const seriesEvent1 = await makeEvent({
        title: "Friday Night Jazz #1",
        day: series1Day,
        startHour: 20,
        durationHours: 3,
        status: "PUBLISHED",
      });
      const seriesEvent2 = await makeEvent({
        title: "Friday Night Jazz #2",
        day: series2Day,
        startHour: 20,
        durationHours: 3,
        status: "PUBLISHED",
      });
      await prisma.eventSeriesOccurrence.createMany({
        data: [
          {
            seriesId: series.id,
            ordinal: 1,
            startsAt: seriesEvent1.startsAt,
            endsAt: seriesEvent1.endsAt,
            status: "GENERATED",
            eventId: seriesEvent1.id,
          },
          {
            seriesId: series.id,
            ordinal: 2,
            startsAt: seriesEvent2.startsAt,
            endsAt: seriesEvent2.endsAt,
            status: "GENERATED",
            eventId: seriesEvent2.id,
          },
        ],
      });

      // ── Booking holds (FR-016) ──────────────────────────────────────
      // One request per hold: the SQL partial unique
      // "BookingHold_live_request_date_key" allows only one LIVE hold per
      // (request, calendar, date), so a two-deep line needs two requests.
      // Anonymous senders with distinct emails keep the open-pair dedupe
      // index ("BookingRequest_open_anon_pair_key") happy.
      async function makeHoldRequest(actName: string, tag: string) {
        return prisma.bookingRequest.create({
          data: {
            direction: "TO_VENUE",
            placeId: place.id,
            calendarId: mainCalendar.id,
            performerOwnerType: null,
            performerOwnerId: null,
            contactName: actName,
            contactEmail: `e2e-hold-${tag}-${stamp}@example.com`,
            actName,
            message: `E2E hold fixture (${tag}).`,
            preferredDates: [],
            status: "PENDING",
          },
        });
      }

      const firstHoldRequest = await makeHoldRequest("Line Leader", `a${stamp}`);
      const secondHoldRequest = await makeHoldRequest("Second In Line", `b${stamp}`);
      const challengedRequest = await makeHoldRequest("Challenged Act", `c${stamp}`);

      const holdActive1 = await prisma.bookingHold.create({
        data: {
          bookingRequestId: firstHoldRequest.id,
          calendarId: mainCalendar.id,
          spaceId: mainSpace.id,
          date: dbDate(activeHoldDay.key),
          position: 1,
          status: "ACTIVE",
          placedByHumanId: humanId,
        },
      });
      const holdActive2 = await prisma.bookingHold.create({
        data: {
          bookingRequestId: secondHoldRequest.id,
          calendarId: mainCalendar.id,
          spaceId: mainSpace.id,
          date: dbDate(activeHoldDay.key),
          position: 2,
          status: "ACTIVE",
          placedByHumanId: humanId,
        },
      });
      // respondBy must be in the FUTURE or the read projects it as lapsed
      // (`isHoldLapsed` → EXPIRED) and the spec never sees a challenged chip.
      const respondBy = new Date(now.getTime() + 2 * 86_400_000);
      const holdChallenged = await prisma.bookingHold.create({
        data: {
          bookingRequestId: challengedRequest.id,
          calendarId: mainCalendar.id,
          spaceId: mainSpace.id,
          date: dbDate(challengedHoldDay.key),
          position: 1,
          status: "CHALLENGED",
          placedByHumanId: humanId,
          challengedAt: new Date(now.getTime() - 3_600_000),
          respondBy,
        },
      });

      return reply.status(200).send({
        ok: true,
        seed: {
          humanId,
          orgId: org.id,
          orgSlug,
          placeId: place.id,
          placeName,
          timezone: VENUE_TZ,

          mainCalendarId: mainCalendar.id,
          mainCalendarName: mainCalendar.name,
          backCalendarId: backCalendar.id,
          backCalendarName: backCalendar.name,
          mainSpaceId: mainSpace.id,
          backSpaceId: backSpace.id,
          defaultStartTime: MAIN_DEFAULT_START_TIME,
          hoursMain: HOURS_MAIN,
          hoursBack: HOURS_BACK,
          hoursAll: HOURS_ALL,

          eventTodayId: eventToday.id,
          eventTodayTitle: eventToday.title,
          eventTodayDateKey: today.key,
          eventTomorrowId: eventTomorrow.id,
          eventTomorrowDateKey: tomorrow.key,
          eventFutureId: eventFuture.id,
          eventFutureDateKey: futureDay.key,
          conflictAId: conflictA.id,
          conflictBId: conflictB.id,
          conflictDateKey: conflictDay.key,
          cancelledEventId: eventCancelled.id,
          cancelledDateKey: cancelledDay.key,

          seriesId: series.id,
          seriesName: series.name,
          seriesEvent1Id: seriesEvent1.id,
          seriesEvent1DateKey: series1Day.key,
          seriesEvent2Id: seriesEvent2.id,
          seriesEvent2DateKey: series2Day.key,

          activeHoldDateKey: activeHoldDay.key,
          holdActive1Id: holdActive1.id,
          holdActive1Title: "Line Leader",
          holdActive2Id: holdActive2.id,
          holdActive2Title: "Second In Line",
          challengedHoldDateKey: challengedHoldDay.key,
          challengedHoldId: holdChallenged.id,
          challengedHoldTitle: "Challenged Act",
          holdBookingRequestId: firstHoldRequest.id,

          eventCount: 8,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      app.log.error({ err }, "e2e_seed_venue_calendar_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_seed_venue_calendar_failed",
        message,
      });
    }
  });

  /**
   * Teardown. Ordered inner-to-outer and scoped entirely to the ids the seed
   * handed back. Idempotent, so a spec's `afterAll` can always run (including
   * after a partial failure).
   *
   * Order matters twice: BookingHold → Calendar is `onDelete: Restrict`, so
   * the holds (and the requests they hang off) go before the Place cascade;
   * and SearchDocument has no FK to Event, so it never cascades.
   */
  app.post("/e2e/seed/venue-calendar/cleanup", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const { orgId, placeId } = (request.body ?? {}) as {
      orgId?: string;
      placeId?: string;
    };
    if (!orgId && !placeId) {
      return reply
        .status(400)
        .send({ ok: false, error: "orgId_or_placeId_required" });
    }

    try {
      // Holds cascade from their request; the requests are reachable by place.
      if (placeId) {
        await prisma.bookingRequest.deleteMany({ where: { placeId } });
      }

      const eventWhere = placeId
        ? { OR: [{ placeId }, ...(orgId ? [{ orgId }] : [])] }
        : { orgId: orgId! };
      const events = await prisma.event.findMany({
        where: eventWhere,
        select: { id: true, payoutTermsId: true },
      });
      const eventIds = events.map((e) => e.id);

      if (eventIds.length > 0) {
        await prisma.searchDocument.deleteMany({
          where: { eventId: { in: eventIds } },
        });
        await prisma.eventSeriesOccurrence.deleteMany({
          where: { eventId: { in: eventIds } },
        });
        await prisma.event.deleteMany({ where: { id: { in: eventIds } } });

        const termsIds = events
          .map((e) => e.payoutTermsId)
          .filter((id): id is string => Boolean(id));
        if (termsIds.length > 0) {
          await prisma.payoutTerms
            .deleteMany({ where: { id: { in: termsIds } } })
            .catch(() => undefined);
        }
      }

      if (orgId) {
        await prisma.eventSeries.deleteMany({
          where: { ownerScope: "ORGANIZATION", ownerId: orgId },
        });
      }

      // Place cascades PlaceOwnership / Space / Calendar / CalendarSpace /
      // CalendarAvailability. EntityPage is a polymorphic pointer with no FK.
      if (placeId) {
        await prisma.searchDocument
          .deleteMany({ where: { placeId } })
          .catch(() => undefined);
        await prisma.entityPage.deleteMany({
          where: { ownerType: "PLACE", ownerId: placeId },
        });
        await prisma.place.deleteMany({ where: { id: placeId } });
      }

      if (orgId) {
        await prisma.searchDocument
          .deleteMany({ where: { orgIdRef: orgId } })
          .catch(() => undefined);
        await prisma.entityPage.deleteMany({
          where: { ownerType: "ORGANIZATION", ownerId: orgId },
        });
        await prisma.orgMember.deleteMany({ where: { orgId } });
        await prisma.organization.deleteMany({ where: { id: orgId } });
      }

      return reply
        .status(200)
        .send({ ok: true, deletedEvents: eventIds.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      app.log.error({ err }, "e2e_cleanup_venue_calendar_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_cleanup_venue_calendar_failed",
        message,
      });
    }
  });
};

export default seedVenueCalendar;
