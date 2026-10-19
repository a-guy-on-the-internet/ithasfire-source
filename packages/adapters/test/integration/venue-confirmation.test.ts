import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
import { makeEventsRepo } from "../../src/db/prisma/events";
import { makePlaceBookingGrantsRepo } from "../../src/db/prisma/place-booking-grants";

// ---------------------------------------------------------------------------
// Venue confirmation + booking intents — Phase 1 Step 1 adapter integration
// (docs/specs/2026-08-27/venue-confirmation-and-booking-intents.spec.md).
//
// Runs against REAL Postgres via `prisma migrate deploy`, which also proves
// migration 20260902120000_venue_confirmation_and_booking_intents replays on
// a fresh database. Client construction copies event-saves.test.ts EXACTLY —
// the repo's Prisma client runs in driver-adapter mode, so a bare
// `new PrismaClient()` throws and the whole suite would silently skip.
//
// Pins:
//   · every calendar has ≥1 space — `create`/`setSpaces` refuse an empty set
//     BEFORE any row lands;
//   · `venueConfirmedFor` returns venue-owned (orgId match) + stamped
//     third-party events and EXCLUDES unstamped and withdrawn ones, on all
//     four place-scoped list reads;
//   · withdraw is idempotent on the same reason, re-confirm clears it;
//   · grants: revokedAt / expiresAt / calendar scope, whole-place preferred;
//   · BookingRequest intent columns round-trip; RENT WITHOUT a space is
//     accepted (ruling 2026-09-22, migration
//     20260922120000_booking_request_space_optional relaxed the CHECK under
//     the same name) and the SQL CHECK still backstops RENT-without-window.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-02T12:00:00.000Z");

describe("Prisma adapters integration – venue confirmation + booking intents", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let ownerHumanId: string;
  let thirdHumanId: string;
  let venueOrgId: string;
  let placeId: string;
  let defaultSpaceId: string;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      ownerHumanId = (
        await prisma.human.create({
          data: { name: "Venue Owner", status: "ACTIVE" },
        })
      ).id;
      thirdHumanId = (
        await prisma.human.create({
          data: { name: "Third Party", status: "ACTIVE" },
        })
      ).id;
      venueOrgId = (
        await prisma.organization.create({
          data: { name: "Venue Org", slug: "venue-org" },
        })
      ).id;
      placeId = (
        await prisma.place.create({
          data: { name: "Drkmttr", address: "1111 Test Ave, Nashville, TN" },
        })
      ).id;
      defaultSpaceId = (
        await prisma.space.create({
          data: { placeId, name: "Default Room" },
        })
      ).id;
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("venue-confirmation integration setup failed:", error);
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
  // Every other test skips when setup failed; this one does NOT — a broken
  // container / migrate deploy / client construction fails the suite loudly.
  test("setup succeeded (container + migrate deploy incl. 20260902120000 + driver-adapter client)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("the migration's SQL-only constructs exist: PlaceBookingGrant table + intent shape CHECK", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const [check] = await prisma!.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conname = 'BookingRequest_intent_shape_check'
    `;
    expect(check?.conname).toBe("BookingRequest_intent_shape_check");
    // Table reachable through the generated client = created by the migration.
    expect(await prisma!.placeBookingGrant.count()).toBe(0);
  });

  // ── (a) every calendar has ≥1 space ──────────────────────────────────────

  test("calendars.create refuses an empty spaceIds BEFORE writing; with spaces the joins land with the row", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const calendars = makeCalendarsRepo(prisma!);
    const before = await calendars.countForPlace(placeId);

    await expect(
      calendars.create({
        placeId,
        name: "Roomless",
        slug: "roomless",
        spaceIds: [],
        primarySpaceId: defaultSpaceId,
      }),
    ).rejects.toMatchObject({ code: "calendar_requires_space" });
    expect(await calendars.countForPlace(placeId)).toBe(before);

    const created = await calendars.create({
      placeId,
      name: "Live Music",
      slug: "live-music",
      // Duplicate id must not trip the (calendarId, spaceId) unique.
      spaceIds: [defaultSpaceId, defaultSpaceId],
      primarySpaceId: defaultSpaceId,
      acceptsRent: true,
      rentalRateCents: 25_000,
      rentalRateCurrency: "usd",
      rentalRateVisible: true,
    });
    // Booking config persisted; omitted keys took the column defaults.
    expect(created).toMatchObject({
      acceptsPerform: true,
      acceptsRent: true,
      acceptsUse: false,
      rentalRateCents: 25_000,
      rentalRateCurrency: "usd",
      rentalRateVisible: true,
      rentalMode: "REQUEST",
    });
    const listed = (await calendars.listByPlace(placeId)).find(
      (c) => c.id === created.id,
    );
    expect(listed?.spaces.map((s) => s.id)).toEqual([defaultSpaceId]);

    // setSpaces: the WRITE refuses an empty set; the existing join survives.
    await expect(
      calendars.setSpaces({ calendarId: created.id, spaceIds: [], primarySpaceId: defaultSpaceId }),
    ).rejects.toMatchObject({ code: "calendar_requires_space" });
    expect(
      (await calendars.listByPlace(placeId))
        .find((c) => c.id === created.id)
        ?.spaces.map((s) => s.id),
    ).toEqual([defaultSpaceId]);

    // update: config patch round-trips; untouched keys stay.
    const patched = await calendars.update({
      id: created.id,
      acceptsUse: true,
      rentalRateVisible: false,
    });
    expect(patched).toMatchObject({
      acceptsRent: true,
      acceptsUse: true,
      rentalRateCents: 25_000,
      rentalRateVisible: false,
    });
  }, 60_000);

  // ── (b) venueConfirmedFor on the four place-scoped reads ─────────────────

  test("venueConfirmedFor keeps venue-owned (orgId) + stamped events and drops unstamped + withdrawn ones on every list read", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const calendars = makeCalendarsRepo(prisma!);
    const events = makeEventsRepo(prisma!);

    const calendar = await calendars.create({
      placeId,
      name: "Confirm Stream",
      slug: "confirm-stream",
      spaceIds: [defaultSpaceId],
      primarySpaceId: defaultSpaceId,
    });

    const mkEvent = async (
      title: string,
      owner: { orgId: string } | { humanId: string },
      day: number,
    ) =>
      prisma!.event.create({
        data: {
          title,
          startsAt: new Date(`2026-10-${String(day).padStart(2, "0")}T20:00:00.000Z`),
          endsAt: new Date(`2026-10-${String(day).padStart(2, "0")}T23:00:00.000Z`),
          status: "PUBLISHED",
          placeId,
          calendarId: calendar.id,
          spaceId: defaultSpaceId,
          ...owner,
        },
      });

    const venueOwned = await mkEvent("Venue Owned", { orgId: venueOrgId }, 1);
    const stamped = await mkEvent("Stamped", { humanId: thirdHumanId }, 2);
    const unstamped = await mkEvent("Unstamped", { humanId: thirdHumanId }, 3);
    const withdrawn = await mkEvent("Withdrawn", { humanId: thirdHumanId }, 4);

    const stampedRecord = await events.setVenueConfirmation({
      eventId: stamped.id,
      placeId,
      confirmedByHumanId: ownerHumanId,
      bookingRequestId: null,
      at: NOW,
    });
    expect(stampedRecord).toMatchObject({
      venueConfirmedAt: NOW,
      venueConfirmedByHumanId: ownerHumanId,
      venueConfirmedPlaceId: placeId,
      venueConfirmationRequestId: null,
      venueConfirmationWithdrawnAt: null,
      venueConfirmationWithdrawnReason: null,
    });

    await events.setVenueConfirmation({
      eventId: withdrawn.id,
      placeId,
      confirmedByHumanId: ownerHumanId,
      bookingRequestId: null,
      at: NOW,
    });
    const withdrawnRecord = await events.withdrawVenueConfirmation({
      eventId: withdrawn.id,
      placeId,
      reason: "Double-booked the room",
      at: new Date("2026-09-03T00:00:00.000Z"),
    });
    // History kept, placeId retained, withdrawn pair set.
    expect(withdrawnRecord).toMatchObject({
      placeId,
      venueConfirmedAt: NOW,
      venueConfirmationWithdrawnAt: new Date("2026-09-03T00:00:00.000Z"),
      venueConfirmationWithdrawnReason: "Double-booked the room",
    });

    const from = new Date("2026-09-30T00:00:00.000Z");
    const to = new Date("2026-10-31T00:00:00.000Z");
    const filter = { orgIds: [venueOrgId], humanIds: [], acceptsCommunityListings: false };
    const expectedConfirmed = [venueOwned.id, stamped.id].sort();
    const expectedAll = [
      venueOwned.id,
      stamped.id,
      unstamped.id,
      withdrawn.id,
    ].sort();

    // listPublishedByPlace
    const byPlace = await events.listPublishedByPlace({
      placeId,
      from,
      to,
      status: "upcoming",
      venueConfirmedFor: filter,
    });
    expect(byPlace.items.map((e) => e.id).sort()).toEqual(expectedConfirmed);
    expect(byPlace.pageInfo.total).toBe(2);
    // Omitted = no confirmation filter.
    const byPlaceAll = await events.listPublishedByPlace({
      placeId,
      from,
      to,
      status: "upcoming",
    });
    expect(byPlaceAll.items.map((e) => e.id).sort()).toEqual(expectedAll);

    // listPublishedByPlaceIds
    const byPlaceIds = await events.listPublishedByPlaceIds({
      placeIds: [placeId],
      from,
      to,
      status: "upcoming",
      venueConfirmedFor: filter,
    });
    expect(byPlaceIds.map((e) => e.id).sort()).toEqual(expectedConfirmed);

    // listPublishedOccurrencesByPlace — composes with the space filter under
    // the same AND (the date-window OR must not swallow it).
    const occurrences = await events.listPublishedOccurrencesByPlace({
      placeId,
      from,
      to,
      spaceIds: [defaultSpaceId],
      venueConfirmedFor: filter,
    });
    expect(occurrences.map((o) => o.eventId).sort()).toEqual(expectedConfirmed);
    const occurrencesAll = await events.listPublishedOccurrencesByPlace({
      placeId,
      from,
      to,
    });
    expect(occurrencesAll.map((o) => o.eventId).sort()).toEqual(expectedAll);

    // listByCalendar (public shape)
    const byCalendar = await events.listByCalendar({
      calendarId: calendar.id,
      from,
      to,
      publishedOnly: true,
      venueConfirmedFor: filter,
    });
    expect(byCalendar.map((e) => e.id).sort()).toEqual(expectedConfirmed);
    // Admin overlay omits the filter and SEES the unconfirmed ones.
    const byCalendarAll = await events.listByCalendar({
      calendarId: calendar.id,
      from,
      to,
    });
    expect(byCalendarAll.map((e) => e.id).sort()).toEqual(expectedAll);

    // humanIds path: the third party as a (hypothetical) human owner of the
    // place pulls its unstamped + withdrawn events back in.
    const byHumanOwner = await events.listPublishedByPlace({
      placeId,
      from,
      to,
      status: "upcoming",
      venueConfirmedFor: { orgIds: [], humanIds: [thirdHumanId], acceptsCommunityListings: false },
    });
    expect(byHumanOwner.items.map((e) => e.id).sort()).toEqual(
      [stamped.id, unstamped.id, withdrawn.id].sort(),
    );
  }, 60_000);

  test("withdraw is idempotent on the same reason (original withdrawnAt kept), a new reason overwrites, re-confirm clears", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const events = makeEventsRepo(prisma!);

    const event = await prisma!.event.create({
      data: {
        title: "Idempotent Withdraw",
        startsAt: new Date("2026-11-01T20:00:00.000Z"),
        endsAt: new Date("2026-11-01T23:00:00.000Z"),
        status: "PUBLISHED",
        humanId: thirdHumanId,
        placeId,
      },
    });
    await events.setVenueConfirmation({
      eventId: event.id,
      placeId,
      confirmedByHumanId: ownerHumanId,
      bookingRequestId: null,
      at: NOW,
    });

    const first = await events.withdrawVenueConfirmation({
      eventId: event.id,
      placeId,
      reason: "Noise complaint",
      at: new Date("2026-09-03T00:00:00.000Z"),
    });
    const retry = await events.withdrawVenueConfirmation({
      eventId: event.id,
      placeId,
      reason: "Noise complaint",
      at: new Date("2026-09-04T00:00:00.000Z"),
    });
    // No-op success: the ORIGINAL withdrawnAt survives the retry.
    expect(retry.venueConfirmationWithdrawnAt).toEqual(
      first.venueConfirmationWithdrawnAt,
    );
    expect(retry.venueConfirmationWithdrawnAt).toEqual(
      new Date("2026-09-03T00:00:00.000Z"),
    );

    const corrected = await events.withdrawVenueConfirmation({
      eventId: event.id,
      placeId,
      reason: "Actually: room closed for repairs",
      at: new Date("2026-09-05T00:00:00.000Z"),
    });
    expect(corrected).toMatchObject({
      venueConfirmationWithdrawnAt: new Date("2026-09-05T00:00:00.000Z"),
      venueConfirmationWithdrawnReason: "Actually: room closed for repairs",
      // History untouched.
      venueConfirmedAt: NOW,
      placeId,
    });

    const reconfirmed = await events.setVenueConfirmation({
      eventId: event.id,
      placeId,
      confirmedByHumanId: ownerHumanId,
      bookingRequestId: null,
      at: new Date("2026-09-06T00:00:00.000Z"),
    });
    expect(reconfirmed).toMatchObject({
      venueConfirmedAt: new Date("2026-09-06T00:00:00.000Z"),
      venueConfirmationWithdrawnAt: null,
      venueConfirmationWithdrawnReason: null,
    });

    // Never-confirmed event: withdrawing records a DECLINE (decided
    // 2026-09-02) — the withdrawn pair lands with venueConfirmedAt still
    // null, placeId retained, so the venue calendar stops re-prompting.
    const neverConfirmed = await prisma!.event.create({
      data: {
        title: "Not Mine",
        startsAt: new Date("2026-11-02T20:00:00.000Z"),
        endsAt: new Date("2026-11-02T23:00:00.000Z"),
        status: "PUBLISHED",
        humanId: thirdHumanId,
        placeId,
      },
    });
    const declined = await events.withdrawVenueConfirmation({
      eventId: neverConfirmed.id,
      placeId,
      reason: "Not our booking",
      at: NOW,
    });
    expect(declined).toMatchObject({
      placeId,
      venueConfirmedAt: null,
      venueConfirmedByHumanId: null,
      venueConfirmationWithdrawnAt: NOW,
      venueConfirmationWithdrawnReason: "Not our booking",
    });

    // A missing event is the same zero-row CAS outcome as a moved one — the
    // typed mismatch, never a silent no-op.
    await expect(
      events.withdrawVenueConfirmation({
        eventId: "00000000-0000-4000-8000-000000000000",
        placeId,
        reason: "ghost",
        at: NOW,
      }),
    ).rejects.toMatchObject({ code: "event_place_mismatch" });
  }, 60_000);


  // ── (b2b) N1: the date the venue vouched for ────────────────────────────
  // place-address-withholding N1 (migrations 20260925180000 /
  // 20260925180001, replayed by `migrate deploy` above). The stamp records
  // the row's OWN start; a later move of the show leaves it; a re-confirm
  // moves it; a withdrawal clears it; and the start-keyed reveal scan finds a
  // show by EITHER start.

  test("N1: setVenueConfirmation records the row's own start; a move keeps it, re-confirm updates it, withdraw clears it; the reveal scan matches either start", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const events = makeEventsRepo(prisma!);
    const confirmedStart = new Date("2026-12-10T01:00:00.000Z");
    const movedStart = new Date("2026-10-01T01:00:00.000Z");

    const event = await prisma!.event.create({
      data: {
        title: "Confirmed Then Moved",
        startsAt: confirmedStart,
        endsAt: new Date("2026-12-10T04:00:00.000Z"),
        status: "PUBLISHED",
        locationMode: "OBSCURED",
        humanId: thirdHumanId,
        placeId,
      },
    });

    const stamped = await events.setVenueConfirmation({
      eventId: event.id,
      placeId,
      confirmedByHumanId: ownerHumanId,
      bookingRequestId: null,
      at: NOW,
    });
    expect(stamped.venueConfirmedStartsAt).toEqual(confirmedStart);

    // The third party moves the show two months earlier (a plain row write —
    // nothing on the save path touches the column).
    await prisma!.event.update({
      where: { id: event.id },
      data: { startsAt: movedStart, endsAt: new Date("2026-10-01T04:00:00.000Z") },
    });
    const moved = await events.getById(event.id);
    expect(moved?.startsAt).toEqual(movedStart);
    expect(moved?.venueConfirmedStartsAt).toEqual(confirmedStart);

    // The reveal scan: the moved start's window AND the confirmed start's
    // window both find it (the gate in core decides which one unlocks).
    const DAY = 24 * 60 * 60 * 1000;
    const around = (at: Date) => ({
      startsAfter: new Date(at.getTime() - DAY),
      startsAtOrBefore: new Date(at.getTime() + DAY),
      eventId: event.id,
    });
    expect(
      (await events.findObscuredPlaceEventsStartingIn(around(movedStart))).map((e) => e.id),
    ).toEqual([event.id]);
    expect(
      (await events.findObscuredPlaceEventsStartingIn(around(confirmedStart))).map((e) => e.id),
    ).toEqual([event.id]);
    expect(
      await events.findObscuredPlaceEventsStartingIn(
        around(new Date("2027-03-01T00:00:00.000Z")),
      ),
    ).toEqual([]);

    // The venue re-confirms the new date: the stamp follows it.
    const reconfirmed = await events.setVenueConfirmation({
      eventId: event.id,
      placeId,
      confirmedByHumanId: ownerHumanId,
      bookingRequestId: null,
      at: new Date("2026-09-10T00:00:00.000Z"),
    });
    expect(reconfirmed.venueConfirmedStartsAt).toEqual(movedStart);

    // A withdrawn stamp vouches for no date.
    const withdrawn = await events.withdrawVenueConfirmation({
      eventId: event.id,
      placeId,
      reason: "Not this one",
      at: new Date("2026-09-11T00:00:00.000Z"),
    });
    expect(withdrawn.venueConfirmedStartsAt).toBeNull();

    // A CAS miss writes neither the stamp nor the date.
    await expect(
      events.setVenueConfirmation({
        eventId: event.id,
        placeId: "00000000-0000-4000-8000-000000000000",
        confirmedByHumanId: ownerHumanId,
        bookingRequestId: null,
        at: NOW,
      }),
    ).rejects.toMatchObject({ code: "event_place_mismatch" });
    expect((await events.getById(event.id))?.venueConfirmedStartsAt).toBeNull();
  }, 60_000);

  test("R3-1: with expectedStartsAt the CAS pins the start — a moved show is refused (typed, nothing written); the seen start stamps", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const events = makeEventsRepo(prisma!);
    const actualStart = new Date("2026-10-01T01:00:00.000Z");
    const event = await prisma!.event.create({
      data: {
        title: "Moved Before Confirm",
        startsAt: actualStart,
        endsAt: new Date("2026-10-01T04:00:00.000Z"),
        status: "PUBLISHED",
        locationMode: "OBSCURED",
        humanId: thirdHumanId,
        placeId,
      },
    });

    await expect(
      events.setVenueConfirmation({
        eventId: event.id,
        placeId,
        confirmedByHumanId: ownerHumanId,
        bookingRequestId: null,
        at: NOW,
        // The venue's stale screen still showed the old date.
        expectedStartsAt: new Date("2026-12-10T01:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "event_starts_at_mismatch" });
    const untouched = await events.getById(event.id);
    expect(untouched?.venueConfirmedAt ?? null).toBeNull();
    expect(untouched?.venueConfirmedStartsAt ?? null).toBeNull();

    // Wrong place is still the place mismatch, not a moved start.
    await expect(
      events.setVenueConfirmation({
        eventId: event.id,
        placeId: "00000000-0000-4000-8000-000000000000",
        confirmedByHumanId: ownerHumanId,
        bookingRequestId: null,
        at: NOW,
        expectedStartsAt: actualStart,
      }),
    ).rejects.toMatchObject({ code: "event_place_mismatch" });

    const stamped = await events.setVenueConfirmation({
      eventId: event.id,
      placeId,
      confirmedByHumanId: ownerHumanId,
      bookingRequestId: null,
      at: NOW,
      expectedStartsAt: actualStart,
    });
    expect(stamped.venueConfirmedAt).toEqual(NOW);
    expect(stamped.venueConfirmedStartsAt).toEqual(actualStart);
  }, 60_000);

  // ── (b3) the community arm, against real Postgres ────────────────────────
  // community-listings-at-claimed-venues FR-002/FR-004. The TS/SQL agreement is
  // pinned without a database by
  // `src/db/prisma/__tests__/venue-confirmed-parity.test.ts`; THIS proves the
  // rendered SQL actually behaves that way in Postgres, and that the new
  // migration (20260912140000_place_accepts_community_listings) replays on a
  // fresh database — `runPrismaMigrateDeploy` above would have failed otherwise.

  test("an ownerless COMMUNITY listing is confirmed ONLY while the place accepts community listings", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const events = makeEventsRepo(prisma!);

    const communityPlace = (
      await prisma!.place.create({
        data: { name: "Community Room", address: "3 Open Mic Ln" },
      })
    ).id;

    // The DB CHECK `event_community_ownerless_rsvp_check` requires a COMMUNITY
    // row to be ownerless AND RSVP — which is precisely why the owner arm can
    // never hold for one, and why this spec exists.
    const mkCommunity = async (title: string, day: number) =>
      prisma!.event.create({
        data: {
          title,
          startsAt: new Date(`2027-03-${String(day).padStart(2, "0")}T20:00:00.000Z`),
          endsAt: new Date(`2027-03-${String(day).padStart(2, "0")}T23:00:00.000Z`),
          status: "PUBLISHED",
          stewardship: "COMMUNITY",
          attendanceMode: "RSVP",
          placeId: communityPlace,
        },
      });

    const listing = await mkCommunity("Monday Open Mic", 1);
    const alsoWithdrawn = await mkCommunity("Rejected Night", 2);

    // An owner-arm event at the same place, to prove the community arm does
    // not swallow the others.
    const owned = await prisma!.event.create({
      data: {
        title: "House Show",
        startsAt: new Date("2027-03-03T20:00:00.000Z"),
        endsAt: new Date("2027-03-03T23:00:00.000Z"),
        status: "PUBLISHED",
        orgId: venueOrgId,
        placeId: communityPlace,
      },
    });

    const from = new Date("2027-02-28T00:00:00.000Z");
    const to = new Date("2027-03-31T00:00:00.000Z");
    const read = async (acceptsCommunityListings: boolean) =>
      (
        await events.listPublishedByPlace({
          placeId: communityPlace,
          from,
          to,
          status: "upcoming",
          venueConfirmedFor: {
            orgIds: [venueOrgId],
            humanIds: [],
            acceptsCommunityListings,
          },
        })
      ).items
        .map((e) => e.id)
        .sort();

    // Flag OFF: the listings are invisible to a confirmed-only read. This is
    // today's state for all 508 places, and the deadlock the spec describes.
    expect(await read(false)).toEqual([owned.id]);

    // Flag ON: both listings light up, with NO stamp written anywhere —
    // retroactive by construction.
    expect(await read(true)).toEqual([alsoWithdrawn.id, listing.id, owned.id].sort());
    const untouched = await prisma!.event.findUnique({
      where: { id: listing.id },
      select: { venueConfirmedAt: true, venueConfirmedPlaceId: true },
    });
    expect(untouched).toEqual({
      venueConfirmedAt: null,
      venueConfirmedPlaceId: null,
    });

    // FR-003: a per-listing withdrawal negates the community arm, so the owner
    // rejects ONE bad listing without switching the venue-wide flag off.
    await prisma!.event.update({
      where: { id: alsoWithdrawn.id },
      data: {
        venueConfirmationWithdrawnAt: new Date("2027-01-01T00:00:00.000Z"),
        venueConfirmationWithdrawnReason: "Not our night",
      },
    });
    expect(await read(true)).toEqual([listing.id, owned.id].sort());

    // Consent does not travel: the same listing at ANOTHER place stays dark
    // even while this place accepts.
    const otherPlace = (
      await prisma!.place.create({
        data: { name: "Other Room", address: "4 Elsewhere Ave" },
      })
    ).id;
    await prisma!.event.update({
      where: { id: listing.id },
      data: { placeId: otherPlace },
    });
    expect(await read(true)).toEqual([owned.id]);
  }, 60_000);

  test("Place.acceptsCommunityListings exists, defaults false, and round-trips through the repo", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const fresh = await prisma!.place.create({
      data: { name: "Default Check", address: "5 Default Rd" },
    });
    // The migration's DEFAULT false — consent is explicit.
    expect(fresh.acceptsCommunityListings).toBe(false);

    const updated = await prisma!.place.update({
      where: { id: fresh.id },
      data: { acceptsCommunityListings: true },
    });
    expect(updated.acceptsCommunityListings).toBe(true);
  }, 60_000);

  // ── (b2) the stamp is bound to the place ─────────────────────────────────

  test("a stamped event MOVED to another place is unconfirmed there (excluded by venueConfirmedFor), and confirmed again only when moved back", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const events = makeEventsRepo(prisma!);
    const placeB = (
      await prisma!.place.create({
        data: { name: "Venue B", address: "2 Elsewhere St" },
      })
    ).id;
    const from = new Date("2026-12-09T00:00:00.000Z");
    const to = new Date("2026-12-11T00:00:00.000Z");
    const noOwners = { orgIds: [], humanIds: [], acceptsCommunityListings: false };

    const event = await prisma!.event.create({
      data: {
        title: "Moved Show",
        startsAt: new Date("2026-12-10T20:00:00.000Z"),
        endsAt: new Date("2026-12-10T23:00:00.000Z"),
        status: "PUBLISHED",
        humanId: thirdHumanId,
        placeId,
      },
    });
    await events.setVenueConfirmation({
      eventId: event.id,
      placeId,
      confirmedByHumanId: ownerHumanId,
      bookingRequestId: null,
      at: NOW,
    });
    const idsAt = async (at: string) =>
      (
        await events.listPublishedByPlace({
          placeId: at,
          from,
          to,
          status: "upcoming",
          venueConfirmedFor: noOwners,
        })
      ).items.map((e) => e.id);
    expect(await idsAt(placeId)).toEqual([event.id]);

    // The organizer edits the event to venue B (what upsertDraft does: it
    // rewrites placeId and touches no venueConfirm* column).
    await prisma!.event.update({
      where: { id: event.id },
      data: { placeId: placeB },
    });
    const moved = await events.getById(event.id);
    // The stamp is untouched on the row…
    expect(moved).toMatchObject({
      placeId: placeB,
      venueConfirmedAt: NOW,
      venueConfirmedPlaceId: placeId,
    });
    // …and worthless at B: excluded there without any write, and gone from
    // A because the row is no longer at A.
    expect(await idsAt(placeB)).toEqual([]);
    expect(await idsAt(placeId)).toEqual([]);
    expect(
      (
        await events.listPublishedByPlaceIds({
          placeIds: [placeB],
          from,
          to,
          status: "upcoming",
          venueConfirmedFor: noOwners,
        })
      ).map((e) => e.id),
    ).toEqual([]);
    expect(
      (
        await events.listPublishedOccurrencesByPlace({
          placeId: placeB,
          from,
          to,
          venueConfirmedFor: noOwners,
        })
      ).map((o) => o.eventId),
    ).toEqual([]);

    // Moved back: the binding matches again, no re-confirmation needed.
    await prisma!.event.update({
      where: { id: event.id },
      data: { placeId },
    });
    expect(await idsAt(placeId)).toEqual([event.id]);
  }, 60_000);

  test("setVenueConfirmation / withdraw with a stale placeId hit the CAS: event_place_mismatch and NOTHING written", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const events = makeEventsRepo(prisma!);
    const placeB = (
      await prisma!.place.create({
        data: { name: "Venue B2", address: "3 Elsewhere St" },
      })
    ).id;
    const event = await prisma!.event.create({
      data: {
        title: "Stale Place",
        startsAt: new Date("2026-12-12T20:00:00.000Z"),
        endsAt: new Date("2026-12-12T23:00:00.000Z"),
        status: "PUBLISHED",
        humanId: thirdHumanId,
        placeId,
      },
    });

    // Venue B's staff authorized against B, but the event is at A.
    await expect(
      events.setVenueConfirmation({
        eventId: event.id,
        placeId: placeB,
        confirmedByHumanId: ownerHumanId,
        bookingRequestId: null,
        at: NOW,
      }),
    ).rejects.toMatchObject({ code: "event_place_mismatch" });
    await expect(
      events.withdrawVenueConfirmation({
        eventId: event.id,
        placeId: placeB,
        reason: "not ours",
        at: NOW,
      }),
    ).rejects.toMatchObject({ code: "event_place_mismatch" });
    expect(await events.getById(event.id)).toMatchObject({
      placeId,
      venueConfirmedAt: null,
      venueConfirmedByHumanId: null,
      venueConfirmedPlaceId: null,
      venueConfirmationWithdrawnAt: null,
      venueConfirmationWithdrawnReason: null,
    });

    // The right place still works.
    expect(
      await events.setVenueConfirmation({
        eventId: event.id,
        placeId,
        confirmedByHumanId: ownerHumanId,
        bookingRequestId: null,
        at: NOW,
      }),
    ).toMatchObject({ venueConfirmedPlaceId: placeId });
  }, 60_000);

  test("migration step 3 stamps venue-owned events AND binds venueConfirmedPlaceId to their place", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    // Isolated org + place so the replay stamps exactly the rows seeded here.
    const org = await prisma!.organization.create({
      data: { name: "Step3 Org", slug: "step3-org" },
    });
    const ownedPlace = await prisma!.place.create({
      data: { name: "Step3 Place", address: "4 Migration Way" },
    });
    await prisma!.placeOwnership.create({
      data: {
        placeId: ownedPlace.id,
        ownerType: "ORGANIZATION",
        ownerId: org.id,
        verified: true,
      },
    });
    const owned = await prisma!.event.create({
      data: {
        title: "Org Owned",
        startsAt: new Date("2026-12-13T20:00:00.000Z"),
        endsAt: new Date("2026-12-13T23:00:00.000Z"),
        status: "PUBLISHED",
        orgId: org.id,
        placeId: ownedPlace.id,
      },
    });
    const foreign = await prisma!.event.create({
      data: {
        title: "Third Party At Step3",
        startsAt: new Date("2026-12-14T20:00:00.000Z"),
        endsAt: new Date("2026-12-14T23:00:00.000Z"),
        status: "PUBLISHED",
        humanId: thirdHumanId,
        placeId: ownedPlace.id,
      },
    });

    // Replay SECTION 3 of the migration file — the part this test is about.
    //
    // It used to replay the whole file on the claim that every statement was
    // re-applicable. That claim expired on 2026-09-24: section 2 of that file
    // BACKFILLS calendars with `INSERT INTO "Calendar" (…)` naming no
    // `primarySpaceId`, and migration 20260924120000_calendar_primary_space
    // later made that column NOT NULL. Replaying section 2 today fails 23502 —
    // which says nothing about section 3 and everything about a harness reading
    // an old file through a new schema. Slicing by the file's own section
    // headers keeps the replay honest AND keeps it reading the real migration
    // rather than a copy that can drift from it.
    const migrationSql = readFileSync(
      resolve(
        __dirname,
        "../../../db/prisma/migrations/20260902120000_venue_confirmation_and_booking_intents/migration.sql",
      ),
      "utf8",
    );
    const STEP_3_HEADER = "-- ── 3. Stamp confirmation on venue-owned events";
    const step3Start = migrationSql.indexOf(STEP_3_HEADER);
    // Fail loudly rather than silently replaying nothing: a renamed header
    // would otherwise turn this test into an assertion about no-op SQL.
    expect(step3Start).toBeGreaterThan(-1);
    await pool!.query(migrationSql.slice(step3Start));

    const stamped = await prisma!.event.findUniqueOrThrow({
      where: { id: owned.id },
    });
    expect(stamped.venueConfirmedAt).not.toBeNull();
    expect(stamped.venueConfirmedPlaceId).toBe(ownedPlace.id);
    const untouched = await prisma!.event.findUniqueOrThrow({
      where: { id: foreign.id },
    });
    expect(untouched.venueConfirmedAt).toBeNull();
    expect(untouched.venueConfirmedPlaceId).toBeNull();
  }, 60_000);

  test("pickRandomEvent with placeId + venueConfirmedFor never surfaces an unconfirmed event", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const events = makeEventsRepo(prisma!);
    const placeR = (
      await prisma!.place.create({
        data: { name: "Random Venue", address: "5 Dice Rd" },
      })
    ).id;
    const mk = (title: string, day: number) =>
      prisma!.event.create({
        data: {
          title,
          startsAt: new Date(`2027-01-${String(day).padStart(2, "0")}T20:00:00.000Z`),
          endsAt: new Date(`2027-01-${String(day).padStart(2, "0")}T23:00:00.000Z`),
          status: "PUBLISHED",
          humanId: thirdHumanId,
          placeId: placeR,
        },
      });
    const confirmed = await mk("Confirmed Random", 1);
    const unconfirmed = await mk("Unconfirmed Random", 2);
    await events.setVenueConfirmation({
      eventId: confirmed.id,
      placeId: placeR,
      confirmedByHumanId: ownerHumanId,
      bookingRequestId: null,
      at: NOW,
    });
    const base = {
      window: {
        from: new Date("2026-12-31T00:00:00.000Z"),
        to: new Date("2027-01-31T00:00:00.000Z"),
      },
      placeId: placeR,
    };

    // 20 draws: with the filter the unconfirmed event never appears…
    for (let i = 0; i < 20; i += 1) {
      const picked = await events.pickRandomEvent({
        ...base,
        excludeEventIds: [],
        venueConfirmedFor: { orgIds: [], humanIds: [], acceptsCommunityListings: false },
      });
      expect(picked?.id).toBe(confirmed.id);
    }
    // …and excluding the confirmed one yields NOTHING under the filter,
    // while the same draw WITHOUT the filter returns the unconfirmed event
    // (so it is the predicate, not the data, doing the excluding).
    expect(
      await events.pickRandomEvent({
        ...base,
        excludeEventIds: [confirmed.id],
        venueConfirmedFor: { orgIds: [], humanIds: [], acceptsCommunityListings: false },
      }),
    ).toBeNull();
    expect(
      (await events.pickRandomEvent({ ...base, excludeEventIds: [confirmed.id] }))
        ?.id,
    ).toBe(unconfirmed.id);
    // The owner arm still admits a venue-owned unconfirmed event.
    expect(
      (
        await events.pickRandomEvent({
          ...base,
          excludeEventIds: [confirmed.id],
          venueConfirmedFor: { orgIds: [], humanIds: [thirdHumanId], acceptsCommunityListings: false },
        })
      )?.id,
    ).toBe(unconfirmed.id);
  }, 60_000);

  // ── (c) grants ────────────────────────────────────────────────────────────

  test("findActiveForActor respects revokedAt / expiresAt / calendar scope and prefers a whole-place grant", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const grants = makePlaceBookingGrantsRepo(prisma!);
    const calendars = makeCalendarsRepo(prisma!);

    const calA = await calendars.create({
      placeId,
      name: "Grant A",
      slug: "grant-a",
      spaceIds: [defaultSpaceId],
      primarySpaceId: defaultSpaceId,
    });
    const calB = await calendars.create({
      placeId,
      name: "Grant B",
      slug: "grant-b",
      spaceIds: [defaultSpaceId],
      primarySpaceId: defaultSpaceId,
    });
    const grantee = (
      await prisma!.human.create({ data: { name: "Regular", status: "ACTIVE" } })
    ).id;
    // holds-without-a-request FR-002: the actor lookup, no capability (H3).
    const lookup = (calendarId: string | null) =>
      grants.findActiveForActor({
        placeId,
        calendarId,
        humanIds: [grantee],
        orgIds: [],
        now: NOW,
      });

    // Nothing yet.
    expect(await lookup(null)).toBeNull();
    expect(await lookup(calA.id)).toBeNull();

    // Calendar-scoped only: matches THAT calendar, not another, not place-level.
    const scoped = await grants.create({
      placeId,
      calendarId: calA.id,
      grantee: { kind: "person", humanId: grantee },
      acceptedAt: NOW,
      grantedByHumanId: ownerHumanId,
    });
    expect(scoped).toMatchObject({
      calendarId: calA.id,
      revokedAt: null,
      expiresAt: null,
    });
    expect(scoped).not.toHaveProperty("canPlaceHolds");
    expect((await lookup(calA.id))?.id).toBe(scoped.id);
    expect(await lookup(calB.id)).toBeNull();
    expect(await lookup(null)).toBeNull();

    // Whole-place grant: matches everywhere and WINS over the scoped one.
    const whole = await grants.create({
      placeId,
      grantee: { kind: "person", humanId: grantee },
      acceptedAt: NOW,
      grantedByHumanId: ownerHumanId,
    });
    expect((await lookup(null))?.id).toBe(whole.id);
    expect((await lookup(calA.id))?.id).toBe(whole.id);
    expect((await lookup(calB.id))?.id).toBe(whole.id);

    // Revoked whole-place → scoped grant is the answer again on calA only.
    await prisma!.placeBookingGrant.update({
      where: { id: whole.id },
      data: { revokedAt: NOW },
    });
    expect((await lookup(calA.id))?.id).toBe(scoped.id);
    expect(await lookup(calB.id)).toBeNull();
    expect(await lookup(null)).toBeNull();

    // Expiry: a whole-place grant that expired before `now` is inactive; one
    // expiring after `now` is active.
    const expired = await grants.create({
      placeId,
      grantee: { kind: "person", humanId: grantee },
      acceptedAt: NOW,
      grantedByHumanId: ownerHumanId,
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(await lookup(null)).toBeNull();
    expect((await lookup(calA.id))?.id).toBe(scoped.id);
    const live = await grants.create({
      placeId,
      grantee: { kind: "person", humanId: grantee },
      acceptedAt: NOW,
      grantedByHumanId: ownerHumanId,
      expiresAt: new Date("2026-12-31T00:00:00.000Z"),
    });
    expect((await lookup(null))?.id).toBe(live.id);
    expect((await lookup(calB.id))?.id).toBe(live.id);
    expect(expired.id).not.toBe(live.id);

    // A calendar-scoped grant must scope to one of THIS place's calendars.
    const foreignPlace = (
      await prisma!.place.create({
        data: { name: "Foreign Grant Venue", address: "6 Away Ln" },
      })
    ).id;
    const foreignSpace = (
      await prisma!.space.create({
        data: { placeId: foreignPlace, name: "Foreign Room" },
      })
    ).id;
    const foreignCalendar = await calendars.create({
      placeId: foreignPlace,
      name: "Foreign Stream",
      slug: "foreign-stream",
      spaceIds: [foreignSpace],
      primarySpaceId: foreignSpace,
    });
    const grantsBefore = await prisma!.placeBookingGrant.count();
    await expect(
      grants.create({
        placeId,
        calendarId: foreignCalendar.id,
        grantee: { kind: "person", humanId: grantee },
        acceptedAt: NOW,
        grantedByHumanId: ownerHumanId,
      }),
    ).rejects.toMatchObject({ code: "grant_calendar_place_mismatch" });
    await expect(
      grants.create({
        placeId,
        calendarId: "00000000-0000-4000-8000-000000000000",
        grantee: { kind: "person", humanId: grantee },
        acceptedAt: NOW,
        grantedByHumanId: ownerHumanId,
      }),
    ).rejects.toMatchObject({ code: "grant_calendar_place_mismatch" });
    expect(await prisma!.placeBookingGrant.count()).toBe(grantsBefore);

    // Another human at the same place sees nothing.
    expect(
      await grants.findActiveForActor({
        placeId,
        calendarId: null,
        humanIds: [thirdHumanId],
        orgIds: [],
        now: NOW,
      }),
    ).toBeNull();
  }, 60_000);

  // ── (d) booking request intent columns ───────────────────────────────────

  test("bookingRequests.create writes intent + room + window and reads them back; RENT without a space is ACCEPTED, RENT without a window hits the SQL CHECK", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const spaces = makeSpacesRepo(prisma!);
    const calendars = makeCalendarsRepo(prisma!);
    const bookingRequests = makeBookingRequestsRepo(prisma!);

    const room = await spaces.create({ placeId, name: "Rental Room" });
    const calendar = await calendars.create({
      placeId,
      name: "Rentals",
      slug: "rentals",
      spaceIds: [room.id],
      primarySpaceId: room.id,
      acceptsRent: true,
    });
    const renter = (
      await prisma!.human.create({ data: { name: "Renter", status: "ACTIVE" } })
    ).id;

    const created = await bookingRequests.create({
      placeId,
      calendarId: calendar.id,
      performerOwnerType: "human",
      performerOwnerId: renter,
      message: "Birthday party",
      preferredDates: [],
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      intent: "RENT",
      spaceId: room.id,
      requestedStartsAt: new Date("2026-10-10T18:00:00.000Z"),
      requestedEndsAt: new Date("2026-10-10T23:00:00.000Z"),
      purpose: "Birthday party",
      expectedAttendance: 40,
    });
    expect(created).toMatchObject({
      intent: "RENT",
      spaceId: room.id,
      requestedStartsAt: new Date("2026-10-10T18:00:00.000Z"),
      requestedEndsAt: new Date("2026-10-10T23:00:00.000Z"),
      purpose: "Birthday party",
      expectedAttendance: 40,
      originEventId: null,
      parkedUnclaimedAt: null,
    });
    expect(await bookingRequests.getById(created.id)).toMatchObject({
      intent: "RENT",
      spaceId: room.id,
    });

    // Pre-spec shape: omitted intent = PERFORM, nothing else set.
    const performer = (
      await prisma!.human.create({ data: { name: "Band", status: "ACTIVE" } })
    ).id;
    const perform = await bookingRequests.create({
      placeId,
      calendarId: calendar.id,
      performerOwnerType: "human",
      performerOwnerId: performer,
      message: "We'd love a slot",
      preferredDates: ["2026-10-12"],
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    expect(perform).toMatchObject({
      intent: "PERFORM",
      spaceId: null,
      requestedStartsAt: null,
      requestedEndsAt: null,
    });

    // (a) The ROOM came off the request (ruling 2026-09-22, migration
    // 20260922120000_booking_request_space_optional): a RENT row with a
    // WINDOW and NO space is now accepted by the CHECK and lands with
    // `spaceId: null`. Written through the same repo the use case uses, so
    // this pins the DB half of the ruling, not just the Zod half.
    const roomless = (
      await prisma!.human.create({ data: { name: "Roomless", status: "ACTIVE" } })
    ).id;
    const noRoom = await bookingRequests.create({
      placeId,
      calendarId: calendar.id,
      performerOwnerType: "human",
      performerOwnerId: roomless,
      message: "rent pls",
      preferredDates: [],
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      intent: "RENT",
      requestedStartsAt: new Date("2026-10-11T18:00:00.000Z"),
      requestedEndsAt: new Date("2026-10-11T23:00:00.000Z"),
      purpose: "Room TBD",
    });
    expect(noRoom).toMatchObject({ intent: "RENT", spaceId: null });
    expect(await bookingRequests.getById(noRoom.id)).toMatchObject({
      intent: "RENT",
      spaceId: null,
    });

    // (b) The WINDOW did NOT come off: the SQL CHECK still backstops a
    // use-case miss. A RENT row WITH a room but NO window is refused — so
    // (a) above cannot be passing for the window's sake.
    const another = (
      await prisma!.human.create({ data: { name: "Sloppy", status: "ACTIVE" } })
    ).id;
    await expect(
      bookingRequests.create({
        placeId,
        calendarId: calendar.id,
        performerOwnerType: "human",
        performerOwnerId: another,
        message: "rent pls",
        preferredDates: [],
        expiresAt: new Date("2026-10-01T00:00:00.000Z"),
        intent: "RENT",
        spaceId: room.id,
      }),
    ).rejects.toThrow(/BookingRequest_intent_shape_check/);
  }, 60_000);
});
