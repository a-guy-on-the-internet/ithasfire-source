import type { PrismaClient } from "@prisma/client";
import { slugify } from "./utils.js";
import type { PlaceFixture } from "./fixtures.js";
import { PLACES } from "./fixtures.js";
import { DEMO_IDS } from "./ids.js";

/**
 * Mint the venue-hierarchy defaults for a seeded place (venue-hierarchy
 * FR-001/FR-002): one "Main Space" + one default Calendar joined to it via
 * CalendarSpace. The demo org's primary venue (place1) additionally gets a
 * second, non-default calendar ("Live Music") sharing the SAME
 * space — exercising calendar routing and the shared-space case.
 *
 * Idempotent: Space is find-or-created by (placeId, name); Calendars upsert on
 * the (placeId, slug) unique; CalendarSpace upserts on (calendarId, spaceId).
 */
const ensureVenueDefaults = async (
  prisma: PrismaClient,
  placeId: string,
  placeName: string,
  declaredSpaces?: { id: string; name: string }[],
  declaredCalendars?: {
    slug: string;
    name: string;
    defaultStartTime?: string;
  }[],
  openingHours?: { start: string; end: string },
) => {
  const isDemoVenue = placeId === DEMO_IDS.place1;

  // A fixture may declare its real rooms (`spaces`). Those are pinned by id,
  // so they upsert cleanly on reseed and a BookingHold can reference one
  // room specifically. Venues that declare nothing keep the historical single
  // "Main Space".
  const spaceIds: string[] = [];
  if (declaredSpaces && declaredSpaces.length > 0) {
    for (const [index, declared] of declaredSpaces.entries()) {
      await prisma.space.upsert({
        where: { id: declared.id },
        update: { placeId, name: declared.name, sortOrder: index },
        create: {
          id: declared.id,
          placeId,
          name: declared.name,
          sortOrder: index,
        },
      });
      spaceIds.push(declared.id);
    }
  }

  // Space has no natural unique key beyond id, so find-or-create by name.
  // For the demo venue, look up by the pinned id FIRST: if someone renamed the
  // demo space, a name-only lookup would miss it and the create below would
  // P2002 on the fixed id, breaking reseed.
  let space = isDemoVenue
    ? await prisma.space.findUnique({
        where: { id: DEMO_IDS.venueMainSpace },
      })
    : null;
  space ??= await prisma.space.findFirst({
    where: { placeId, name: "Main Space" },
  });
  if (!space && spaceIds.length === 0) {
    space = await prisma.space.create({
      data: {
        ...(isDemoVenue ? { id: DEMO_IDS.venueMainSpace } : {}),
        placeId,
        name: "Main Space",
        sortOrder: 0,
      },
    });
  }
  // Declared rooms REPLACE the implicit "Main Space" for calendar joins — a
  // venue that says it has an Inside and an Outside does not also have an
  // unnamed third room. An existing "Main Space" row (from an earlier seed of
  // this place) is left alone rather than deleted: events and holds may point
  // at it, and the seed never destroys referenced rows.
  if (spaceIds.length === 0 && space) spaceIds.push(space.id);

  // Every Calendar needs a PRIMARY space — NOT NULL and FK-pinned to an ACTIVE
  // Space (owner ruling 2026-09-24, migration
  // 20260924120000_calendar_primary_space). `spaceIds` is built in sortOrder
  // order above, so `[0]` is the room the app itself resolves as a calendar's
  // main one (`pickPrimarySpace`) and the room the migration's backfill chose.
  // Seeds never retire a space, so it is always ACTIVE.
  //
  // AND its CalendarSpace JOIN row must be written in the SAME TRANSACTION as
  // the calendar row (migration 20260924160000_calendar_primary_space_joined:
  // "Calendar_primary_space_joined_fkey", DEFERRABLE INITIALLY DEFERRED). A
  // deferred constraint is checked at the end of the ENCLOSING transaction, and
  // in autocommit every statement is its own transaction — so the join cannot
  // wait for the bulk `calendarSpace.upsert` loop below, which would leave the
  // calendar INSERT failing on its own. Hence `calendarSpaces: { create }` on
  // each create branch: a Prisma nested write is one transaction. The loop
  // below still runs and is still needed — it attaches the venue's OTHER rooms.
  const primarySpaceId = spaceIds[0];
  if (!primarySpaceId) {
    throw new Error(
      `seed: place ${placeId} (${placeName}) has no space to make primary — a calendar cannot be created without one`,
    );
  }

  const defaultCalendar = await prisma.calendar.upsert({
    where: { placeId_slug: { placeId, slug: "main" } },
    update: { name: "Main Calendar", isDefault: true },
    create: {
      ...(isDemoVenue ? { id: DEMO_IDS.venueDefaultCalendar } : {}),
      placeId,
      name: "Main Calendar",
      slug: "main",
      isDefault: true,
      primarySpaceId,
      // Deferred joined-ness FK: same transaction as the row above.
      calendarSpaces: { create: [{ spaceId: primarySpaceId }] },
    },
  });

  const calendarIds = [defaultCalendar.id];

  if (isDemoVenue) {
    const liveMusic = await prisma.calendar.upsert({
      where: { placeId_slug: { placeId, slug: "live-music" } },
      update: { name: "Live Music" },
      create: {
        id: DEMO_IDS.venueLiveMusicCalendar,
        placeId,
        name: "Live Music",
        slug: "live-music",
        isDefault: false,
        defaultStartTime: "20:00",
        primarySpaceId,
        // Deferred joined-ness FK: same transaction as the row above.
        calendarSpaces: { create: [{ spaceId: primarySpaceId }] },
      },
    });
    calendarIds.push(liveMusic.id);
  }

  // Extra programming calendars declared by the fixture. Upsert on the
  // (placeId, slug) unique, same as the default — so a reseed converges and a
  // renamed calendar is corrected rather than duplicated. Apply rental config
  // to "room-rental" calendars (Phase-2 fixture for venue-confirmation spec).
  for (const declared of declaredCalendars ?? []) {
    const isRentalCalendar = declared.slug === "room-rental";
    const extra = await prisma.calendar.upsert({
      where: { placeId_slug: { placeId, slug: declared.slug } },
      update: {
        name: declared.name,
        ...(isRentalCalendar ? {
          acceptsRent: true,
          acceptsUse: true,
          rentalRateCents: 50000,
          rentalRateCurrency: "USD",
          rentalRateVisible: true,
        } : {}),
      },
      create: {
        placeId,
        name: declared.name,
        slug: declared.slug,
        isDefault: false,
        primarySpaceId,
        // Deferred joined-ness FK: same transaction as the row above.
        calendarSpaces: { create: [{ spaceId: primarySpaceId }] },
        ...(declared.defaultStartTime
          ? { defaultStartTime: declared.defaultStartTime }
          : {}),
        ...(isRentalCalendar ? {
          acceptsRent: true,
          acceptsUse: true,
          rentalRateCents: 50000,
          rentalRateCurrency: "USD",
          rentalRateVisible: true,
        } : {}),
      },
    });
    calendarIds.push(extra.id);
  }

  // Join every calendar to every room the venue has.
  await Promise.all(
    calendarIds.flatMap((calendarId) =>
      spaceIds.map((spaceId) =>
        prisma.calendarSpace.upsert({
          where: { calendarId_spaceId: { calendarId, spaceId } },
          update: {},
          create: { calendarId, spaceId },
        }),
      ),
    ),
  );

  // Weekly opening hours, PLACE-WIDE (`calendarId: null` = every calendar
  // here). Without them the venue's public booking form marks every date
  // unavailable and no act can submit, which makes the whole booking loop
  // un-exercisable against a freshly-seeded venue.
  //
  // Idempotent by hand: CalendarAvailability has no natural unique key, so a
  // reseed would otherwise stack seven more rows every run. Find-or-create per
  // weekday on (placeId, calendarId IS NULL, dayOfWeek).
  if (openingHours) {
    // FILL A GAP, NEVER CLOBBER. If the venue already carries ANY availability
    // — including calendar-scoped rows someone set through the admin UI — the
    // seed leaves it alone. Writing place-wide hours next to calendar-scoped
    // ones does not "win"; it leaves the calendar governed by two rules with
    // different closing times, which is worse than the gap this fills.
    const alreadyHasHours = await prisma.calendarAvailability.findFirst({
      where: { placeId },
      select: { id: true },
    });
    if (alreadyHasHours) return returnValue();

    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
      const existing = await prisma.calendarAvailability.findFirst({
        where: { placeId, calendarId: null, dayOfWeek },
        select: { id: true },
      });
      const data = {
        placeId,
        calendarId: null,
        dayOfWeek,
        startTime: openingHours.start,
        endTime: openingHours.end,
        isOpen: true,
      };
      if (existing) {
        await prisma.calendarAvailability.update({
          where: { id: existing.id },
          data,
        });
      } else {
        await prisma.calendarAvailability.create({ data });
      }
    }
  }

  return returnValue();

  function returnValue() {
    return {
      spaceId: spaceIds[0]!,
      spaceIds,
      defaultCalendarId: defaultCalendar.id,
    };
  }
};

export const ensurePlaces = async (
  prisma: PrismaClient,
  fixtures: PlaceFixture[] = PLACES,
) => {
  const createdPlaces = await Promise.all(
    fixtures.map(async (fixture) => {
      // Seed-local CONTENT KEY only — deliberately NOT written to the
      // database. `Place.slug` is deprecated (a multi-segment directory key
      // no route resolved). `seed/entity-pages.ts` derives this exact value
      // from name+city to look up hand-authored VENUE_BIOS / VENUE_CONTENT;
      // keep the two derivations identical.
      const contentKey = slugify(`${fixture.name}-${fixture.city}`);
      const verStatus = fixture.unverified ? "UNVERIFIED" : "VERIFIED";
      const listedInDirectory =
        fixture.listedInDirectory ?? !fixture.unverified;
      const acceptsBookingRequests = fixture.acceptsBookingRequests ?? true;
      // Diverges from the schema default ON PURPOSE. `attendeeReviewsPublic`
      // is `@default(false)` because in prod publishing the attendee-review
      // aggregate is the venue owner's opt-in. A seeded database wants the
      // populated, reviews-ON state instead: with the gate shut on every
      // venue, the public rating block and the aggregate never render and
      // neither dev nor QA can reach them. Set on BOTH branches, so a reseed
      // converges an existing place back to ON — same posture as
      // `listedInDirectory` / `acceptsBookingRequests` above.
      const attendeeReviewsPublic = fixture.attendeeReviewsPublic ?? true;

      const place = await prisma.place.upsert({
        where: { id: fixture.id },
        update: {
          name: fixture.name,
          address: fixture.address,
          city: fixture.city,
          region: fixture.region,
          country: fixture.country,
          postcode: fixture.postcode,
          lat: fixture.lat,
          lng: fixture.lng,
          timezone: fixture.timezone,
          capacity: fixture.capacity,
          verification: verStatus,
          listedInDirectory,
          acceptsBookingRequests,
          attendeeReviewsPublic,
        },
        create: {
          id: fixture.id,
          name: fixture.name,
          address: fixture.address,
          city: fixture.city,
          region: fixture.region,
          country: fixture.country,
          postcode: fixture.postcode,
          lat: fixture.lat,
          lng: fixture.lng,
          timezone: fixture.timezone,
          capacity: fixture.capacity,
          verification: verStatus,
          listedInDirectory,
          acceptsBookingRequests,
          attendeeReviewsPublic,
        },
      });

      // Ownership upserts in parallel
      const ownerOps: Promise<unknown>[] = [];
      if (fixture.ownerHumanId) {
        ownerOps.push(
          prisma.placeOwnership.upsert({
            where: {
              placeId_ownerType_ownerId: {
                placeId: place.id,
                ownerType: "HUMAN",
                ownerId: fixture.ownerHumanId,
              },
            },
            update: { verified: true },
            create: {
              placeId: place.id,
              ownerType: "HUMAN",
              ownerId: fixture.ownerHumanId,
              verified: true,
            },
          }),
        );
      }
      if (fixture.ownerOrgId) {
        ownerOps.push(
          prisma.placeOwnership.upsert({
            where: {
              placeId_ownerType_ownerId: {
                placeId: place.id,
                ownerType: "ORGANIZATION",
                ownerId: fixture.ownerOrgId,
              },
            },
            update: { verified: true },
            create: {
              placeId: place.id,
              ownerType: "ORGANIZATION",
              ownerId: fixture.ownerOrgId,
              verified: true,
            },
          }),
        );
      }
      await Promise.all(ownerOps);

      // Venue hierarchy: every seeded place gets a default Space + Calendar
      // (the demo venue also gets a second calendar on the same space).
      await ensureVenueDefaults(
        prisma,
        place.id,
        fixture.name,
        fixture.spaces,
        fixture.calendars,
        fixture.openingHours,
      );

      return { id: place.id, name: fixture.name, contentKey };
    }),
  );

  return createdPlaces;
};

/**
 * Greenfield backfill (seed-only — NOT a data migration): point every seeded
 * event at its place's default space + default calendar so admin calendars and
 * calendar-filtered surfaces have data to render. Runs AFTER event seeding.
 * Idempotent: only touches events still missing a spaceId.
 */
export const backfillEventVenueDefaults = async (prisma: PrismaClient) => {
  const defaultCalendars = await prisma.calendar.findMany({
    where: { isDefault: true },
    include: { calendarSpaces: { take: 1, orderBy: { createdAt: "asc" } } },
  });

  let updated = 0;
  for (const calendar of defaultCalendars) {
    const spaceId = calendar.calendarSpaces[0]?.spaceId;
    if (!spaceId) continue;
    const result = await prisma.event.updateMany({
      where: { placeId: calendar.placeId, spaceId: null },
      data: { spaceId, calendarId: calendar.id },
    });
    updated += result.count;
  }
  return updated;
};
