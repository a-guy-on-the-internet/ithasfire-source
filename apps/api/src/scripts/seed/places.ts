import type { PrismaClient } from "@prisma/client";
import { slugify } from "./utils.js";
import type { PlaceFixture } from "./fixtures.js";
import { PLACES } from "./fixtures.js";
import { DEMO_IDS } from "./ids.js";

/**
 * Mint the venue-hierarchy defaults for a seeded place (venue-hierarchy
 * FR-001/FR-002): one "Main Space" + one default Calendar joined to it via
 * CalendarSpace. The demo org's primary venue (place1) additionally gets a
 * second, non-default calendar ("Paramount Live Music") sharing the SAME
 * space — exercising calendar routing and the shared-space case.
 *
 * Idempotent: Space is find-or-created by (placeId, name); Calendars upsert on
 * the (placeId, slug) unique; CalendarSpace upserts on (calendarId, spaceId).
 */
const ensureVenueDefaults = async (
  prisma: PrismaClient,
  placeId: string,
  placeName: string,
) => {
  const isDemoVenue = placeId === DEMO_IDS.place1;

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
  if (!space) {
    space = await prisma.space.create({
      data: {
        ...(isDemoVenue ? { id: DEMO_IDS.venueMainSpace } : {}),
        placeId,
        name: "Main Space",
        sortOrder: 0,
      },
    });
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
    },
  });

  const calendarIds = [defaultCalendar.id];

  if (isDemoVenue) {
    const liveMusic = await prisma.calendar.upsert({
      where: { placeId_slug: { placeId, slug: "live-music" } },
      update: { name: `${placeName} Live Music` },
      create: {
        id: DEMO_IDS.venueLiveMusicCalendar,
        placeId,
        name: `${placeName} Live Music`,
        slug: "live-music",
        isDefault: false,
        defaultStartTime: "20:00",
      },
    });
    calendarIds.push(liveMusic.id);
  }

  // Join every calendar to the (shared) main space.
  await Promise.all(
    calendarIds.map((calendarId) =>
      prisma.calendarSpace.upsert({
        where: { calendarId_spaceId: { calendarId, spaceId: space.id } },
        update: {},
        create: { calendarId, spaceId: space.id },
      }),
    ),
  );

  return { spaceId: space.id, defaultCalendarId: defaultCalendar.id };
};

export const ensurePlaces = async (
  prisma: PrismaClient,
  fixtures: PlaceFixture[] = PLACES,
) => {
  const createdPlaces = await Promise.all(
    fixtures.map(async (fixture) => {
      const baseSlug = slugify(`${fixture.name}-${fixture.city}`);
      const verStatus = fixture.unverified ? "UNVERIFIED" : "VERIFIED";
      const listedInDirectory =
        fixture.listedInDirectory ?? !fixture.unverified;
      const acceptsBookingRequests = fixture.acceptsBookingRequests ?? true;

      const place = await prisma.place.upsert({
        where: { id: fixture.id },
        update: {
          name: fixture.name,
          slug: baseSlug,
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
        },
        create: {
          id: fixture.id,
          name: fixture.name,
          slug: baseSlug,
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
      await ensureVenueDefaults(prisma, place.id, fixture.name);

      return { id: place.id, name: fixture.name, slug: baseSlug };
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
