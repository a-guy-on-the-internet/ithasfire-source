import { readFileSync } from "node:fs";
import path from "node:path";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";
import {
  configureLocationObfuscation,
  resetLocationObfuscationForTests,
} from "@th/core/lib/location/obfuscation-key";
import {
  WITHHELD_EVENT_DEFAULT_REVEAL,
  exactPlaceLocationColumns,
  projectPlaceLocationForEvents,
} from "@th/core/lib/location/place-event-location";
import {
  applyPlaceLocationFloor,
  redactPlaceLocation,
} from "@th/core/lib/location/redact-place-location";
import { encodeGeohash } from "@th/core/lib/geo/geohash";
import type { SaveEventInput } from "@th/ports/repos/events";

import { makeEventsRepo } from "../events";

// ---------------------------------------------------------------------------
// D1 — THE SECRET LIVES IN ONE TABLE, against REAL Postgres.
//
// For an event with `placeId` whose place is not EXACT, the Event row's
// location fields are already a public projection; the TRUE location is on
// the Place row only. This file proves the three writers of that rule where
// only a database can:
//
//   1. `upsertDraft` (create + update) — what actually lands in the row;
//   2. `reprojectLocationForPlace` — the ONE-statement cascade, including the
//      SQL floor (parity-checked against the TS `applyPlaceLocationFloor`),
//      ARCHIVED handling, the DAY_BEFORE default, NEVER, and the reveal
//      cursor stamp;
//   3. the backfill migration `20260925160000_...` — idempotent, and leaves
//      no true copy behind.
//
// Plus the advisory lock: an exclusive holder blocks a saver's shared lock.
//
// The full migration set is applied to a throwaway container, so column and
// enum names are the real ones. FK triggers on Event are disabled so fixtures
// need no Org/Human graph — nothing under test joins through them.
//
// SEED TIMESTAMPS ARE ISO STRINGS in raw SQL (node-pg serialises a Date as
// LOCAL wall-clock and `timestamp(3)` would drop the offset).
// ---------------------------------------------------------------------------

const HOUSE = "70000000-0000-4000-8000-000000000001";
const HIDDEN_HOUSE = "70000000-0000-4000-8000-000000000002";
const CLUB = "70000000-0000-4000-8000-000000000003";
const OTHER_HOUSE = "70000000-0000-4000-8000-000000000004";
const ORG = "70000000-0000-4000-8000-0000000000aa";

const STREET = "1417 Shelby Ave, Nashville, TN 37206";
const TRUE_LAT = 36.1775;
const TRUE_LNG = -86.7412;

const NOW = new Date("2026-09-25T12:00:00.000Z");

const MIGRATION_SQL = readFileSync(
  path.join(
    __dirname,
    "../../../../../db/prisma/migrations/20260925160000_event_withheld_venue_location_projection/migration.sql",
  ),
  "utf8",
);

/** The place as the core projector sees it (mirrors the adapter's mapping). */
function source(id: string, place: {
  locationMode: string;
  locationRadiusMeters: number | null;
  locationLabel: string | null;
  lat: number | null;
  lng: number | null;
}) {
  return {
    id,
    locationMode: place.locationMode,
    locationRadiusMeters: place.locationRadiusMeters,
    locationLabel: place.locationLabel,
    formattedAddress: STREET,
    city: "Nashville",
    region: "TN",
    countryCode: "US",
    postalCode: "37206",
    lat: place.lat,
    lng: place.lng,
  };
}

describe("events adapter — Place → Event location under withholding (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    await runPrismaMigrateDeploy(pgContainer.databaseUrl);
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(`ALTER TABLE "Event" DISABLE TRIGGER ALL`);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    configureLocationObfuscation({ secret: "events-place-location-it" });
  }, 300_000);

  afterAll(async () => {
    resetLocationObfuscationForTests();
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  beforeEach(async () => {
    await pool!.query(`TRUNCATE "Event", "Place" CASCADE`);
    const place = (
      id: string,
      mode: string,
      radius: number | null,
      label: string | null,
    ) =>
      pool!.query(
        `INSERT INTO "Place" (id, name, address, "addrLine1", city, region, postcode, country, lat, lng,
                              location_mode, location_radius_meters, location_label, "updatedAt")
         VALUES ($1, 'Venue', $2, '1417 Shelby Ave', 'Nashville', 'TN', '37206', 'US', $3, $4,
                 $5::"EventLocationMode", $6, $7, '2026-01-01T00:00:00Z')`,
        [id, STREET, TRUE_LAT, TRUE_LNG, mode, radius, label],
      );
    await place(HOUSE, "OBSCURED", 800, "East Nashville");
    await place(HIDDEN_HOUSE, "OBSCURED", null, null);
    await place(CLUB, "EXACT", null, null);
    await place(OTHER_HOUSE, "OBSCURED", 800, "Madison");
    // TRUNCATE … CASCADE over the full migrated schema overran the 10 s
    // default on a loaded machine (every test failed in this hook).
  }, 60_000);

  const repo = () => makeEventsRepo(prisma!);

  async function row(id: string) {
    const { rows } = await pool!.query(
      `SELECT "locationMode", "locationRadiusMeters", lat, lng, geohash6, geohash8,
              "addressText", locality, region, "countryCode", "postalCode",
              address_reveal_preset,
              -- timestamp(3) holds UTC wall-clock; pin it so node-pg does not
              -- read it as LOCAL time.
              (address_reveal_at AT TIME ZONE 'UTC') AS address_reveal_at,
              address_reveal_notified_at, status
         FROM "Event" WHERE id = $1`,
      [id],
    );
    return rows[0] as Record<string, unknown>;
  }

  function draft(overrides: Partial<SaveEventInput> = {}): SaveEventInput {
    return {
      eventId: null,
      orgId: ORG,
      humanId: null,
      title: "Basement Show",
      startsAt: new Date("2026-10-10T20:00:00.000Z"),
      endsAt: new Date("2026-10-10T23:00:00.000Z"),
      status: "DRAFT",
      location: { kind: "place", placeId: HOUSE },
      ...overrides,
    };
  }

  function expectNoTruth(r: Record<string, unknown>) {
    expect(r.lat).not.toBe(TRUE_LAT);
    expect(r.lng).not.toBe(TRUE_LNG);
    expect(r.postalCode).toBeNull();
    expect(r.geohash8).toBeNull();
    expect(String(r.addressText)).not.toContain("Shelby");
    // `geohash6` is pinned per test to the REDACTOR's value (derived from the
    // public centre). It is not asserted "≠ the true point's cell" here: a
    // centre within 800 m may legitimately share the house's ~1.2 km cell.
  }

  // ── 1. upsertDraft ───────────────────────────────────────────────────────

  describe("upsertDraft", () => {
    test("CREATE at a circle venue stores the venue's public projection, floored", async () => {
      // A series-generation-style create: no privacy passed at all.
      const created = await repo().upsertDraft(draft());
      const r = await row(created.id);
      const venuePublic = redactPlaceLocation(
        source(HOUSE, {
          locationMode: "OBSCURED",
          locationRadiusMeters: 800,
          locationLabel: "East Nashville",
          lat: TRUE_LAT,
          lng: TRUE_LNG,
        }),
      );

      expect(venuePublic.lat).not.toBeNull();
      expect(r).toMatchObject({
        locationMode: "OBSCURED",
        // default 500 floored up to the venue's 800
        locationRadiusMeters: 800,
        lat: expect.closeTo(venuePublic.lat!, 9),
        lng: expect.closeTo(venuePublic.lng!, 9),
        geohash6: venuePublic.geohash6,
        addressText: "East Nashville",
        locality: "Nashville",
        region: "TN",
        countryCode: "US",
        postalCode: null,
        // It asked for EXACT (the create default) and got OBSCURED, with no
        // schedule: it gets the default one so holders are not locked out.
        address_reveal_preset: WITHHELD_EVENT_DEFAULT_REVEAL.preset,
      });
      expect((r.address_reveal_at as Date).getTime()).toBe(
        new Date("2026-10-09T20:00:00.000Z").getTime(),
      );
      expectNoTruth(r);
    });

    test("CREATE at a FULLY HIDDEN venue stores no coordinates at all", async () => {
      const created = await repo().upsertDraft(
        draft({
          location: { kind: "place", placeId: HIDDEN_HOUSE },
          locationMode: "OBSCURED",
          locationRadiusMeters: 2000,
          addressRevealPreset: "WEEK_BEFORE",
          addressRevealAt: new Date("2026-10-03T20:00:00.000Z"),
        }),
      );
      const r = await row(created.id);
      expect(r).toMatchObject({
        locationMode: "OBSCURED",
        locationRadiusMeters: null,
        lat: null,
        lng: null,
        geohash6: null,
        addressText: "Nashville, TN",
        postalCode: null,
        // An explicit schedule is the caller's and is kept.
        address_reveal_preset: "WEEK_BEFORE",
      });
    });

    test("CREATE at an EXACT venue is stored exactly as before (the legacy copy)", async () => {
      const created = await repo().upsertDraft(
        draft({
          location: { kind: "place", placeId: CLUB },
          locationMode: "OBSCURED",
          locationRadiusMeters: 250,
        }),
      );
      const r = await row(created.id);
      expect(r).toMatchObject({
        // The event's own privacy choice is untouched at an EXACT venue.
        locationMode: "OBSCURED",
        locationRadiusMeters: 250,
        lat: TRUE_LAT,
        lng: TRUE_LNG,
        geohash6: encodeGeohash(TRUE_LAT, TRUE_LNG, 6),
        addressText: STREET,
        locality: "Nashville",
        region: "TN",
        countryCode: "US",
        postalCode: "37206",
        address_reveal_preset: null,
      });
    });

    test("UPDATE that omits privacy is floored from the STORED row (series-sync shape)", async () => {
      const created = await repo().upsertDraft(
        draft({
          location: { kind: "place", placeId: CLUB },
          locationMode: "OBSCURED",
          locationRadiusMeters: 3000,
          addressRevealPreset: "NEVER",
          addressRevealAt: null,
        }),
      );
      // Moved to the house, privacy fields omitted.
      await repo().upsertDraft({
        ...draft({ eventId: created.id }),
        location: { kind: "place", placeId: HOUSE },
      });
      const r = await row(created.id);
      expect(r).toMatchObject({
        locationMode: "OBSCURED",
        // max(stored 3000, venue 800)
        locationRadiusMeters: 3000,
        addressText: "East Nashville",
        postalCode: null,
        // NEVER stays NEVER.
        address_reveal_preset: "NEVER",
        address_reveal_at: null,
      });
      expectNoTruth(r);
    });

    test("an explicit NULL radius on CREATE is stored NULL (fully hidden), not 500", async () => {
      const created = await repo().upsertDraft(
        draft({
          location: {
            kind: "freeform",
            addressText: "9 Elm St",
            lat: 36.1,
            lng: -86.7,
          },
          locationMode: "OBSCURED",
          locationRadiusMeters: null,
        }),
      );
      expect((await row(created.id)).locationRadiusMeters).toBeNull();
    });
  });

  // ── 2. reprojectLocationForPlace ─────────────────────────────────────────

  async function seedEvent(opts: {
    id: string;
    placeId: string;
    status?: string;
    mode?: "EXACT" | "OBSCURED";
    radius?: number | null;
    preset?: string | null;
    revealAt?: string | null;
    startsAt?: string;
  }) {
    const startsAt = opts.startsAt ?? "2026-10-10T20:00:00.000Z";
    await pool!.query(
      `INSERT INTO "Event" (id, title, "startsAt", "endsAt", status, "placeId",
                            "locationMode", "locationRadiusMeters",
                            address_reveal_preset, address_reveal_at,
                            "addressText", lat, lng, geohash6, geohash8, locality, region, "countryCode", "postalCode",
                            "updatedAt")
       VALUES ($1, 'e', $2, $2, $3::"EventStatus", $4, $5::"EventLocationMode", $6,
               $7::"AddressRevealPreset", $8,
               $9, $10, $11, $12, 'dn6m9s4v', 'Nashville', 'TN', 'US', '37206',
               '2026-01-01T00:00:00Z')`,
      [
        opts.id,
        startsAt,
        opts.status ?? "PUBLISHED",
        opts.placeId,
        opts.mode ?? "EXACT",
        opts.radius === undefined ? 500 : opts.radius,
        opts.preset ?? null,
        opts.revealAt ?? null,
        STREET,
        TRUE_LAT,
        TRUE_LNG,
        encodeGeohash(TRUE_LAT, TRUE_LNG, 6),
      ],
    );
  }

  const ev = (n: number) => `71000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  describe("reprojectLocationForPlace — withheld", () => {
    const houseProjection = () =>
      projectPlaceLocationForEvents(
        source(HOUSE, {
          locationMode: "OBSCURED",
          locationRadiusMeters: 800,
          locationLabel: "East Nashville",
          lat: TRUE_LAT,
          lng: TRUE_LNG,
        }),
      );

    test("rewrites every event at the venue in one statement; nothing else moves", async () => {
      await seedEvent({ id: ev(1), placeId: HOUSE }); // EXACT, no schedule, future
      await seedEvent({
        id: ev(2),
        placeId: HOUSE,
        startsAt: "2026-09-25T20:00:00.000Z", // reveal (−24h) already passed
      });
      await seedEvent({ id: ev(3), placeId: HOUSE, mode: "OBSCURED", radius: 5000, preset: "WEEK_BEFORE", revealAt: "2026-10-03T20:00:00.000Z" });
      await seedEvent({ id: ev(4), placeId: HOUSE, mode: "OBSCURED", radius: null, preset: "DAY_BEFORE", revealAt: "2026-10-09T20:00:00.000Z" });
      await seedEvent({ id: ev(5), placeId: HOUSE, mode: "OBSCURED", radius: 500, preset: "NEVER", revealAt: null });
      await seedEvent({ id: ev(6), placeId: HOUSE, status: "ARCHIVED" });
      await seedEvent({ id: ev(7), placeId: OTHER_HOUSE }); // different venue

      const projection = houseProjection();
      expect(projection.kind).toBe("withheld");
      const ids = await repo().reprojectLocationForPlace({
        placeId: HOUSE,
        projection,
        now: NOW,
        defaultReveal: WITHHELD_EVENT_DEFAULT_REVEAL,
      });

      expect(ids.sort()).toEqual([ev(1), ev(2), ev(3), ev(4), ev(5), ev(6)].sort());
      const centre = projection.kind === "withheld" ? projection.publicCentre! : null;

      const e1 = await row(ev(1));
      expect(e1).toMatchObject({
        locationMode: "OBSCURED",
        locationRadiusMeters: 800,
        lat: expect.closeTo(centre!.lat!, 9),
        lng: expect.closeTo(centre!.lng!, 9),
        geohash6: centre!.geohash6,
        addressText: "East Nashville",
        postalCode: null,
        geohash8: null,
        address_reveal_preset: "DAY_BEFORE",
        address_reveal_notified_at: null,
      });
      expect((e1.address_reveal_at as Date).toISOString()).toBe(
        "2026-10-09T20:00:00.000Z",
      );
      expectNoTruth(e1);

      // Reveal already passed at the moment it became withheld: the cursor is
      // stamped so the reveal job never retro-announces it.
      const e2 = await row(ev(2));
      expect(e2.address_reveal_preset).toBe("DAY_BEFORE");
      expect((e2.address_reveal_notified_at as Date).toISOString()).toBe(
        NOW.toISOString(),
      );

      // A wider event radius stands; its own schedule stands.
      expect(await row(ev(3))).toMatchObject({
        locationRadiusMeters: 5000,
        lat: expect.closeTo(centre!.lat!, 9),
        address_reveal_preset: "WEEK_BEFORE",
      });
      // A fully-hidden event stays fully hidden: no centre.
      expect(await row(ev(4))).toMatchObject({
        locationRadiusMeters: null,
        lat: null,
        lng: null,
        geohash6: null,
      });
      // NEVER stays NEVER.
      expect(await row(ev(5))).toMatchObject({
        address_reveal_preset: "NEVER",
        address_reveal_at: null,
        locationRadiusMeters: 800,
      });
      // ARCHIVED is tightened too: no row keeps a true copy.
      const e6 = await row(ev(6));
      expect(e6.status).toBe("ARCHIVED");
      expectNoTruth(e6);
      // The other venue's event is untouched.
      expect(await row(ev(7))).toMatchObject({
        lat: TRUE_LAT,
        addressText: STREET,
        postalCode: "37206",
      });
    });

    test("the SQL floor equals applyPlaceLocationFloor for every (event, venue) pair", async () => {
      const venueRadii: Array<number | null> = [null, 800];
      const requests: Array<{ mode: "EXACT" | "OBSCURED"; radius: number | null }> = [
        { mode: "EXACT", radius: 500 },
        { mode: "EXACT", radius: null },
        { mode: "OBSCURED", radius: null },
        { mode: "OBSCURED", radius: 250 },
        { mode: "OBSCURED", radius: 3000 },
      ];
      let n = 100;
      for (const venueRadius of venueRadii) {
        await pool!.query(`TRUNCATE "Event" CASCADE`);
        const expected = new Map<string, number | null>();
        for (const req of requests) {
          const id = ev(n++);
          await seedEvent({ id, placeId: HOUSE, mode: req.mode, radius: req.radius });
          expected.set(
            id,
            applyPlaceLocationFloor(
              { locationMode: req.mode, locationRadiusMeters: req.radius },
              { locationMode: "OBSCURED", locationRadiusMeters: venueRadius },
            ).locationRadiusMeters,
          );
        }
        await repo().reprojectLocationForPlace({
          placeId: HOUSE,
          projection: projectPlaceLocationForEvents(
            source(HOUSE, {
              locationMode: "OBSCURED",
              locationRadiusMeters: venueRadius,
              locationLabel: "East Nashville",
              lat: TRUE_LAT,
              lng: TRUE_LNG,
            }),
          ),
          now: NOW,
          defaultReveal: WITHHELD_EVENT_DEFAULT_REVEAL,
        });
        for (const [id, radius] of expected) {
          const r = await row(id);
          expect({ id, radius: r.locationRadiusMeters }).toEqual({ id, radius });
          // No radius → no coordinates.
          if (radius === null) expect(r.lat).toBeNull();
        }
      }
    });
  });

  describe("reprojectLocationForPlace — restore to EXACT", () => {
    test("restores the true columns; leaves privacy, schedule and ARCHIVED rows alone", async () => {
      await seedEvent({ id: ev(1), placeId: HOUSE, mode: "OBSCURED", radius: 800, preset: "DAY_BEFORE", revealAt: "2026-10-09T20:00:00.000Z" });
      await seedEvent({ id: ev(2), placeId: HOUSE, status: "ARCHIVED", mode: "OBSCURED", radius: 800 });
      // Put both into the withheld projection first.
      await pool!.query(
        `UPDATE "Event" SET lat = NULL, lng = NULL, "postalCode" = NULL, "addressText" = 'East Nashville'
          WHERE "placeId" = $1`,
        [HOUSE],
      );
      await pool!.query(
        `UPDATE "Place" SET location_mode = 'EXACT' WHERE id = $1`,
        [HOUSE],
      );

      const ids = await repo().reprojectLocationForPlace({
        placeId: HOUSE,
        projection: projectPlaceLocationForEvents(
          source(HOUSE, {
            locationMode: "EXACT",
            locationRadiusMeters: 800,
            locationLabel: "East Nashville",
            lat: TRUE_LAT,
            lng: TRUE_LNG,
          }),
        ),
        now: NOW,
        defaultReveal: WITHHELD_EVENT_DEFAULT_REVEAL,
      });

      expect(ids).toEqual([ev(1)]);
      expect(await row(ev(1))).toMatchObject({
        lat: TRUE_LAT,
        lng: TRUE_LNG,
        addressText: STREET,
        postalCode: "37206",
        // Privacy stays as private as it is now.
        locationMode: "OBSCURED",
        locationRadiusMeters: 800,
        address_reveal_preset: "DAY_BEFORE",
      });
      expect(await row(ev(2))).toMatchObject({
        lat: null,
        addressText: "East Nashville",
      });
    });
  });

  describe("followPlaceAddress (events follow an EXACT place's address edit)", () => {
    const MOVED = "1500 Shelby Ave, Nashville, TN 37206";
    const MOVED_LAT = 36.1781;
    const MOVED_LNG = -86.7389;
    const columns = () =>
      exactPlaceLocationColumns({
        ...source(CLUB, {
          locationMode: "EXACT",
          locationRadiusMeters: null,
          locationLabel: null,
          lat: MOVED_LAT,
          lng: MOVED_LNG,
        }),
        formattedAddress: MOVED,
      });
    const future = "2026-10-10T20:00:00.000Z"; // after NOW
    const past = "2026-09-01T20:00:00.000Z"; // before NOW

    const expectMoved = async (id: string) =>
      expect(await row(id)).toMatchObject({
        addressText: MOVED,
        lat: MOVED_LAT,
        lng: MOVED_LNG,
        geohash6: encodeGeohash(MOVED_LAT, MOVED_LNG, 6),
        geohash8: null,
        locationMode: "EXACT",
      });
    const expectKept = async (id: string) =>
      expect(await row(id)).toMatchObject({
        addressText: STREET,
        lat: TRUE_LAT,
        geohash8: "dn6m9s4v",
      });

    test("writes upcoming DRAFT/PUBLISHED events (in-progress and a recurring listing with a date ahead included); history and other places keep theirs", async () => {
      await seedEvent({ id: ev(1), placeId: CLUB, startsAt: future });
      await seedEvent({ id: ev(2), placeId: CLUB, status: "DRAFT", startsAt: future });
      await seedEvent({ id: ev(3), placeId: CLUB, startsAt: past });
      await seedEvent({ id: ev(4), placeId: CLUB, status: "ARCHIVED", startsAt: future });
      await seedEvent({ id: ev(5), placeId: CLUB, status: "CANCELLED", startsAt: future });
      await seedEvent({ id: ev(6), placeId: HOUSE, startsAt: future });
      await seedEvent({ id: ev(7), placeId: CLUB, status: "COMPLETED", startsAt: future });
      // In progress: started before NOW, ends after it — not ended, so it follows.
      await seedEvent({ id: ev(8), placeId: CLUB, startsAt: "2026-09-25T10:00:00.000Z" });
      await pool!.query(`UPDATE "Event" SET "endsAt" = '2026-09-25T14:00:00.000Z' WHERE id = $1`, [ev(8)]);
      // Recurring listing whose startsAt/endsAt mirror still sits on a past
      // night, with a SCHEDULED date ahead: follows. A second one whose only
      // future date is CANCELLED: does not.
      await seedEvent({ id: ev(9), placeId: CLUB, startsAt: past });
      await seedEvent({ id: ev(10), placeId: CLUB, startsAt: past });
      const date = (id: string, eventId: string, startsAt: string, status: string) =>
        pool!.query(
          `INSERT INTO "EventDate" (id, "eventId", ordinal, "startsAt", "endsAt", status, "updatedAt")
           VALUES ($1, $2, 0, $3, NULL, $4::"EventDateStatus", '2026-01-01T00:00:00Z')`,
          [id, eventId, startsAt, status],
        );
      await date("72000000-0000-4000-8000-000000000001", ev(9), future, "SCHEDULED");
      await date("72000000-0000-4000-8000-000000000002", ev(10), future, "CANCELLED");

      const out = await repo().followPlaceAddress({
        placeId: CLUB,
        columns: columns(),
        timezone: "America/Chicago",
        now: NOW,
      });

      expect([...out.followedIds].sort()).toEqual([ev(1), ev(2), ev(8), ev(9)]);
      expect(out.skippedIds).toEqual([]);
      for (const id of out.followedIds) await expectMoved(id);
      for (const id of [ev(3), ev(4), ev(5), ev(6), ev(7), ev(10)]) await expectKept(id);
    });

    test("only events already in the place's zone follow; the rest come back as skipped", async () => {
      await seedEvent({ id: ev(1), placeId: CLUB, startsAt: future });
      await seedEvent({ id: ev(2), placeId: CLUB, startsAt: future });
      await seedEvent({ id: ev(3), placeId: CLUB, startsAt: past });
      await pool!.query(`UPDATE "Event" SET timezone = 'America/Denver' WHERE id IN ($1, $2)`, [ev(2), ev(3)]);

      const out = await repo().followPlaceAddress({
        placeId: CLUB,
        columns: columns(),
        timezone: "America/Chicago",
        now: NOW,
      });

      expect(out).toEqual({ followedIds: [ev(1)], skippedIds: [ev(2)] });
      await expectMoved(ev(1));
      await expectKept(ev(2));
    });

    test("an unknown zone (null) writes nothing and skips every upcoming event", async () => {
      await seedEvent({ id: ev(1), placeId: CLUB, startsAt: future });
      await seedEvent({ id: ev(2), placeId: CLUB, startsAt: past });

      const out = await repo().followPlaceAddress({
        placeId: CLUB,
        columns: columns(),
        timezone: null,
        now: NOW,
      });

      expect(out).toEqual({ followedIds: [], skippedIds: [ev(1)] });
      await expectKept(ev(1));
    });
  });

  // ── 3. the lock ──────────────────────────────────────────────────────────

  test("an EXCLUSIVE place-location lock blocks a saver's SHARED lock until commit", async () => {
    const key = `place_location:${HOUSE}`;
    const probe = async () => {
      const client = await pool!.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(
          `SELECT pg_try_advisory_xact_lock_shared(hashtext($1)) AS got`,
          [key],
        );
        await client.query("COMMIT");
        return rows[0].got as boolean;
      } finally {
        client.release();
      }
    };

    let heldInside: boolean | undefined;
    await prisma!.$transaction(async (tx) => {
      await makeEventsRepo(tx as never).lockLocationsAtPlace({
        placeId: HOUSE,
        mode: "exclusive",
      });
      heldInside = await probe();
    });
    expect(heldInside).toBe(false);
    expect(await probe()).toBe(true);
  });

  // ── 4. the backfill migration ────────────────────────────────────────────

  describe("migration 20260925160000 — backfill of rows copied before D1", () => {
    test("re-projects every legacy true copy at a withheld venue, idempotently", async () => {
      // The backfill compares the reveal moment (startsAt − 24h) with the
      // DATABASE's now(), not the injected NOW. A "reveal still in the future"
      // fixture must therefore sit far ahead of the real calendar, or it turns
      // into "already passed" (and gets stamped) the day the date goes by.
      const FUTURE_STARTS_AT = "2099-10-10T20:00:00.000Z";
      await seedEvent({ id: ev(1), placeId: HOUSE, startsAt: FUTURE_STARTS_AT }); // EXACT legacy copy, reveal in the future
      await seedEvent({ id: ev(2), placeId: HIDDEN_HOUSE, mode: "OBSCURED", radius: 5000, preset: "DAY_BEFORE", revealAt: "2026-10-09T20:00:00.000Z" });
      await seedEvent({ id: ev(3), placeId: HOUSE, status: "ARCHIVED" });
      await seedEvent({ id: ev(4), placeId: CLUB }); // EXACT venue: untouched
      await seedEvent({ id: ev(5), placeId: HOUSE, startsAt: "2020-01-01T20:00:00.000Z" }); // long past

      await pool!.query(MIGRATION_SQL);
      const once = await pool!.query(`SELECT * FROM "Event" ORDER BY id`);
      await pool!.query(MIGRATION_SQL);
      const twice = await pool!.query(`SELECT * FROM "Event" ORDER BY id`);
      expect(twice.rows).toEqual(once.rows);

      const e1 = await row(ev(1));
      expect(e1).toMatchObject({
        locationMode: "OBSCURED",
        locationRadiusMeters: 800,
        // The centre needs the keyed TS redactor: SQL sets NULL, the next
        // save / privacy change repopulates it.
        lat: null,
        lng: null,
        geohash6: null,
        geohash8: null,
        addressText: "East Nashville",
        postalCode: null,
        address_reveal_preset: "DAY_BEFORE",
        address_reveal_notified_at: null,
      });
      expect((e1.address_reveal_at as Date).toISOString()).toBe(
        "2099-10-09T20:00:00.000Z",
      );
      expect(await row(ev(2))).toMatchObject({
        locationRadiusMeters: null,
        addressText: "Nashville, TN",
        postalCode: null,
        lat: null,
      });
      expectNoTruth(await row(ev(3)));
      expect(await row(ev(4))).toMatchObject({
        locationMode: "EXACT",
        lat: TRUE_LAT,
        addressText: STREET,
        postalCode: "37206",
      });
      // A long-past show gets its cursor stamped (no retro-announcement).
      expect((await row(ev(5))).address_reveal_notified_at).not.toBeNull();

      // Across the whole table: no event at a withheld venue holds the truth.
      const { rows: leaks } = await pool!.query(
        `SELECT e.id FROM "Event" e JOIN "Place" p ON p.id = e."placeId"
          WHERE p.location_mode <> 'EXACT'
            AND (e.lat IS NOT NULL OR e."postalCode" IS NOT NULL OR e."addressText" ILIKE '%Shelby%')`,
      );
      expect(leaks).toEqual([]);
    });
  });
});
