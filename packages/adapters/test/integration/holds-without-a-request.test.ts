import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeBookingHoldsRepo } from "../../src/db/prisma/booking-holds";
import { makeBookingRequestsRepo } from "../../src/db/prisma/booking-requests";
import { makeCalendarsRepo } from "../../src/db/prisma/calendars";
import { makeEventsRepo } from "../../src/db/prisma/events";
import { makeHumanDelegatesRepo } from "../../src/db/prisma/human-delegates";
import { makePlaceBookingGrantsRepo } from "../../src/db/prisma/place-booking-grants";
import { createPrismaRepos } from "../../src/db/prisma";
import { givePlaceBookingGrant } from "@th/core/use-cases/place-booking-grants/give";
import {
  findPlaceBookerGrant,
  listPlaceBookerGrants,
} from "@th/core/use-cases/booking-requests/_shared/place-access";

// ---------------------------------------------------------------------------
// Holds without a request (spec 2026-09-30, plan step 2), against REAL
// Postgres via `prisma migrate deploy` — which also proves
// 20261015140000_holds_without_a_request and
// 20261015170000_booking_hold_grant_no_action replay on a fresh database.
// Client construction copies event-saves.test.ts EXACTLY: the repo's Prisma
// client runs in driver-adapter mode, so a bare `new PrismaClient()` throws
// and the whole suite would silently skip.
//
// Pins: request-less holds round-trip through the owner-kind CHECK; the
// per-holder partial uniques map to booking_hold_holder_exists; line reads
// return every kind while request reads return REQUEST only; the grant
// lifecycle (pending → accept / decline, update, revoke, the active rule);
// the note's edited-at check on all three tables; and the NO ACTION FK lets
// an org delete cascade through a BOOKER hold and its grant together.
// ---------------------------------------------------------------------------

const DATE = "2026-11-06";
const NOW = new Date("2026-10-15T12:00:00.000Z");

describe("Prisma adapters integration – holds without a request", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let ownerHumanId: string;
  let personId: string;
  let placeId: string;
  let calendarId: string;
  let orgId: string;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      ownerHumanId = (
        await prisma.human.create({ data: { name: "Place Owner", status: "ACTIVE" } })
      ).id;
      personId = (
        await prisma.human.create({ data: { name: "Regular Booker", status: "ACTIVE" } })
      ).id;
      placeId = (
        await prisma.place.create({
          data: { name: "The Back Room", address: "2 Test St, Nashville, TN" },
        })
      ).id;
      const room = await prisma.space.create({
        data: { placeId, name: "Main Room", sortOrder: 0 },
      });
      calendarId = (
        await prisma.calendar.create({
          data: {
            placeId,
            name: "Live Music",
            slug: "live-music",
            isDefault: true,
            primarySpaceId: room.id,
            calendarSpaces: { create: [{ spaceId: room.id }] },
          },
        })
      ).id;
      orgId = (
        await prisma.organization.create({
          data: { name: "Booker Org", slug: `booker-org-${Date.now()}` },
        })
      ).id;
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("holds-without-a-request integration setup failed:", error);
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

  // Not skippable: a setup failure FAILS the suite instead of a wall of skips.
  test("setup succeeded (container + migrate deploy + driver-adapter client)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  const mkRequest = async (name: string, date = DATE): Promise<string> => {
    const act = await prisma!.human.create({ data: { name, status: "ACTIVE" } });
    return (
      await prisma!.bookingRequest.create({
        data: {
          placeId,
          calendarId,
          performerOwnerType: "human",
          performerOwnerId: act.id,
          message: `${name} wants to play`,
          preferredDates: [date],
          expiresAt: new Date("2026-12-01T00:00:00.000Z"),
        },
      })
    ).id;
  };

  const mkAcceptedGrant = async (
    grantee: { kind: "org"; orgId: string } | { kind: "person"; humanId: string },
  ) =>
    makePlaceBookingGrantsRepo(prisma!).create({
      placeId,
      grantee,
      grantedByHumanId: ownerHumanId,
      acceptedAt: NOW,
    });

  test("request-less holds round-trip, share the line with requests, and stay out of request reads", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const holds = makeBookingHoldsRepo(prisma!);
    const date = "2026-11-07";
    const requestId = await mkRequest("Line Act", date);
    const orgGrant = await mkAcceptedGrant({ kind: "org", orgId });

    const requestHold = await holds.create({
      bookingRequestId: requestId,
      calendarId,
      date,
      position: 1,
      placedByHumanId: ownerHumanId,
    });
    const booker = await holds.createRequestless({
      ownerKind: "BOOKER",
      grantId: orgGrant.id,
      holder: { kind: "org", orgId },
      calendarId,
      date,
      position: 2,
      placedByHumanId: ownerHumanId,
      now: NOW,
    });
    const place = await holds.createRequestless({
      ownerKind: "PLACE",
      holder: { kind: "person", humanId: personId },
      calendarId,
      date,
      position: 3,
      placedByHumanId: ownerHumanId,
      now: NOW,
      note: "Their birthday show",
    });
    const unassigned = await holds.createRequestless({
      ownerKind: "PLACE",
      holder: null,
      calendarId,
      date,
      position: 4,
      placedByHumanId: ownerHumanId,
      now: NOW,
    });

    expect(requestHold).toMatchObject({ ownerKind: "REQUEST", bookingRequestId: requestId });
    expect(booker).toMatchObject({
      ownerKind: "BOOKER",
      grantId: orgGrant.id,
      holder: { kind: "org", orgId },
      status: "ACTIVE",
      date,
      note: null,
    });
    expect(place).toMatchObject({
      ownerKind: "PLACE",
      holder: { kind: "person", humanId: personId },
      note: "Their birthday show",
      noteUpdatedByHumanId: ownerHumanId,
    });
    expect(place.noteUpdatedAt).toEqual(NOW);
    expect(unassigned).toMatchObject({ ownerKind: "PLACE", holder: null });

    // Line reads see every kind, in position order; mapping survives the read.
    const line = await holds.listLine({ calendarId, date });
    expect(line.map((h) => [h.position, h.ownerKind])).toEqual([
      [1, "REQUEST"],
      [2, "BOOKER"],
      [3, "PLACE"],
      [4, "PLACE"],
    ]);
    expect(await holds.getById(booker.id)).toEqual(booker);
    const withTerms = await holds.listLineWithTerms({ calendarId, date });
    expect(withTerms.map((h) => h.id)).toEqual(line.map((h) => h.id));

    // Request reads are REQUEST only.
    expect((await holds.listForRequest(requestId)).map((h) => h.id)).toEqual([
      requestHold.id,
    ]);
    expect(
      (await holds.listLiveForRequests([requestId])).map((h) => h.ownerKind),
    ).toEqual(["REQUEST"]);
  }, 60_000);

  test("one live hold per holder per line → booking_hold_holder_exists; unassigned holds are unlimited; a released holder may hold again", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const holds = makeBookingHoldsRepo(prisma!);
    const date = "2026-11-08";
    const personGrant = await mkAcceptedGrant({ kind: "person", humanId: personId });

    const first = await holds.createRequestless({
      ownerKind: "BOOKER",
      grantId: personGrant.id,
      holder: { kind: "person", humanId: personId },
      calendarId,
      date,
      position: 1,
      placedByHumanId: personId,
      now: NOW,
    });
    // Same person, same line — as a PLACE hold naming them too: the unique is
    // per holder, not per kind.
    await expect(
      holds.createRequestless({
        ownerKind: "PLACE",
        holder: { kind: "person", humanId: personId },
        calendarId,
        date,
        position: 2,
        placedByHumanId: ownerHumanId,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "conflict", message: "booking_hold_holder_exists" });

    for (const position of [2, 3]) {
      await holds.createRequestless({
        ownerKind: "PLACE",
        holder: null,
        calendarId,
        date,
        position,
        placedByHumanId: ownerHumanId,
        now: NOW,
      });
    }

    await prisma!.bookingHold.update({
      where: { id: first.id },
      data: { status: "RELEASED", releasedReason: "MANUAL", releasedAt: NOW },
    });
    const again = await holds.createRequestless({
      ownerKind: "BOOKER",
      grantId: personGrant.id,
      holder: { kind: "person", humanId: personId },
      calendarId,
      date,
      position: 4,
      placedByHumanId: personId,
      now: NOW,
    });
    expect(again.status).toBe("ACTIVE");
  }, 60_000);

  test("the owner-kind CHECK refuses a BOOKER hold without a holder", async ({ skip }) => {
    if (!ready(skip)) return;
    const grant = await mkAcceptedGrant({ kind: "org", orgId });
    await expect(
      prisma!.bookingHold.create({
        data: {
          ownerKind: "BOOKER",
          grantId: grant.id,
          calendarId,
          date: new Date("2026-11-09T00:00:00.000Z"),
          position: 1,
          placedByHumanId: ownerHumanId,
        },
      }),
    ).rejects.toThrow(/BookingHold_owner_kind_shape|check constraint/i);
  }, 60_000);

  test("grant lifecycle: pending is inactive; accept / decline CAS once; update and revoke are place-scoped", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const grants = makePlaceBookingGrantsRepo(prisma!);
    const human = (
      await prisma!.human.create({ data: { name: "Invitee", status: "ACTIVE" } })
    ).id;
    const actor = { placeId, humanIds: [human], orgIds: [] as string[], now: NOW };

    const pending = await grants.create({
      placeId,
      grantee: { kind: "person", humanId: human },
      grantedByHumanId: ownerHumanId,
    });
    expect(pending).toMatchObject({
      grantee: { kind: "person", humanId: human },
      acceptedAt: null,
      declinedAt: null,
    });
    // H3: the record carries no capability flags (the columns keep their
    // defaults until the contract migration, plan step 18).
    expect(pending).not.toHaveProperty("canPlaceHolds");
    // Dual-write: the deprecated column carries the person until step 18.
    expect(
      (await prisma!.placeBookingGrant.findUniqueOrThrow({ where: { id: pending.id } }))
        .humanId,
    ).toBe(human);

    // Pending: listed for the grantee to answer, but grants nothing.
    expect(await grants.findActiveForActor(actor)).toBeNull();
    expect((await grants.listForGrantee(actor)).map((g) => g.id)).toEqual([pending.id]);

    const answerer = { humanIds: [human], orgIds: [] as string[], now: NOW };
    const accepted = await grants.accept({ id: pending.id, ...answerer });
    expect(accepted.acceptedAt).toEqual(NOW);
    expect((await grants.findActiveForActor(actor))?.id).toBe(pending.id);
    await expect(grants.accept({ id: pending.id, ...answerer })).rejects.toMatchObject({
      message: "place_booking_grant_not_pending",
    });
    await expect(grants.decline({ id: pending.id, ...answerer })).rejects.toMatchObject({
      message: "place_booking_grant_not_pending",
    });
    await expect(
      grants.accept({ id: "00000000-0000-4000-8000-000000000000", ...answerer }),
    ).rejects.toMatchObject({ code: "not_found" });

    // Update: moving the date clears the warning stamp; another place's id
    // matches nothing.
    const firstExpiry = new Date("2026-10-19T12:00:00.000Z");
    await grants.update({ id: pending.id, placeId, now: NOW, expiresAt: firstExpiry });
    expect(
      await grants.markExpiryWarned({ id: pending.id, expiresAt: firstExpiry, now: NOW }),
    ).toBe(true);
    const expiresAt = new Date("2026-10-20T12:00:00.000Z");
    const moved = await grants.update({ id: pending.id, placeId, now: NOW, expiresAt });
    expect(moved).toMatchObject({ expiresAt, expiryWarnedAt: null });
    // A run that read the OLD date does not stamp the new one.
    expect(
      await grants.markExpiryWarned({ id: pending.id, expiresAt: firstExpiry, now: NOW }),
    ).toBe(false);
    expect(
      (await grants.getForPlace({ id: pending.id, placeId }))?.expiryWarnedAt,
    ).toBeNull();
    const elsewhere = (
      await prisma!.place.create({ data: { name: "Elsewhere", address: "3 Away St" } })
    ).id;
    expect(await grants.update({ id: pending.id, placeId: elsewhere, now: NOW, expiresAt: null })).toBeNull();
    expect(await grants.revoke({ id: pending.id, placeId: elsewhere, now: NOW })).toBeNull();
    // An ended grant (expired, or declined) is not edited: the write matches
    // nothing and the stored expiry stays.
    const lapsedAt = new Date(NOW.getTime() - 1000);
    const lapsed = await grants.create({
      placeId,
      grantee: { kind: "person", humanId: human },
      grantedByHumanId: ownerHumanId,
      acceptedAt: NOW,
      expiresAt: lapsedAt,
    });
    expect(
      await grants.update({ id: lapsed.id, placeId, now: NOW, expiresAt: new Date(NOW.getTime() + 30 * 86_400_000) }),
    ).toBeNull();
    expect((await grants.getForPlace({ id: lapsed.id, placeId }))?.expiresAt).toEqual(lapsedAt);
    await prisma!.placeBookingGrant.update({
      where: { id: lapsed.id },
      data: { expiresAt: null, declinedAt: NOW, acceptedAt: null },
    });
    expect(await grants.update({ id: lapsed.id, placeId, now: NOW, expiresAt: expiresAt })).toBeNull();
    expect((await grants.getForPlace({ id: lapsed.id, placeId }))?.expiresAt).toBeNull();
    await prisma!.placeBookingGrant.delete({ where: { id: lapsed.id } });
    // getForPlace: the staff read is place-scoped the same way.
    expect((await grants.getForPlace({ id: pending.id, placeId }))?.id).toBe(pending.id);
    expect(await grants.getForPlace({ id: pending.id, placeId: elsewhere })).toBeNull();

    // Expiring: accepted, unwarned, by the cutoff; the warning is once only.
    const cutoff = new Date("2026-10-22T12:00:00.000Z");
    const expiring = await grants.listExpiring({
      expiresBefore: cutoff,
      unwarnedOnly: true,
      limit: 50,
    });
    expect(expiring.map((g) => g.id)).toContain(pending.id);
    expect(await grants.markExpiryWarned({ id: pending.id, expiresAt, now: NOW })).toBe(true);
    expect(await grants.markExpiryWarned({ id: pending.id, expiresAt, now: NOW })).toBe(false);
    expect(
      (
        await grants.listExpiring({ expiresBefore: cutoff, unwarnedOnly: true, limit: 50 })
      ).map((g) => g.id),
    ).not.toContain(pending.id);

    // Revoke: once, then gone from the place's list (unless includeEnded).
    const revoked = await grants.revoke({ id: pending.id, placeId, now: NOW });
    expect(revoked?.revokedAt).toEqual(NOW);
    expect(await grants.revoke({ id: pending.id, placeId, now: NOW })).toBeNull();
    expect(await grants.findActiveForActor(actor)).toBeNull();
    const listed = (await grants.listForPlace({ placeId })).map((g) => g.id);
    expect(listed).not.toContain(pending.id);
    expect(
      (await grants.listForPlace({ placeId, includeEnded: true })).map((g) => g.id),
    ).toContain(pending.id);

    // Decline: a second invite, declined, never becomes active and drops off
    // both lists.
    const second = await grants.create({
      placeId,
      grantee: { kind: "person", humanId: human },
      grantedByHumanId: ownerHumanId,
    });
    expect((await grants.decline({ id: second.id, ...answerer })).declinedAt).toEqual(NOW);
    expect(await grants.findActiveForActor(actor)).toBeNull();
    expect((await grants.listForGrantee(actor)).map((g) => g.id)).not.toContain(second.id);
  }, 60_000);

  test("accept / decline are grantee-scoped: another person's or org's grant reads not_found and stays pending", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const grants = makePlaceBookingGrantsRepo(prisma!);
    const invitee = (
      await prisma!.human.create({ data: { name: "Scoped Invitee", status: "ACTIVE" } })
    ).id;
    const stranger = (
      await prisma!.human.create({ data: { name: "Scoped Stranger", status: "ACTIVE" } })
    ).id;
    const org = (
      await prisma!.organization.create({
        data: { name: "Scoped Org", slug: `scoped-org-${Date.now()}` },
      })
    ).id;
    const otherOrg = (
      await prisma!.organization.create({
        data: { name: "Other Org", slug: `other-org-${Date.now()}` },
      })
    ).id;
    const personGrant = await grants.create({
      placeId,
      grantee: { kind: "person", humanId: invitee },
      grantedByHumanId: ownerHumanId,
    });
    const orgGrant = await grants.create({
      placeId,
      grantee: { kind: "org", orgId: org },
      grantedByHumanId: ownerHumanId,
    });
    const unchanged = async (id: string) =>
      prisma!.placeBookingGrant.findUniqueOrThrow({
        where: { id },
        select: { acceptedAt: true, declinedAt: true },
      });

    // A stranger, a person answering an org's grant by their own id, another
    // org, and no sets at all: all not_found, never not_pending.
    for (const who of [
      { humanIds: [stranger], orgIds: [] as string[] },
      { humanIds: [stranger], orgIds: [otherOrg] },
      { humanIds: [] as string[], orgIds: [] as string[] },
    ]) {
      for (const id of [personGrant.id, orgGrant.id]) {
        await expect(grants.accept({ id, ...who, now: NOW })).rejects.toMatchObject({
          code: "not_found",
          message: "place_booking_grant_not_found",
        });
        await expect(grants.decline({ id, ...who, now: NOW })).rejects.toMatchObject({
          code: "not_found",
        });
      }
    }
    // An org id in humanIds does not answer the org grant (sets are typed).
    await expect(
      grants.accept({ id: orgGrant.id, humanIds: [org], orgIds: [], now: NOW }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await unchanged(personGrant.id)).toEqual({ acceptedAt: null, declinedAt: null });
    expect(await unchanged(orgGrant.id)).toEqual({ acceptedAt: null, declinedAt: null });

    // Their own grantees answer them.
    expect(
      (await grants.accept({ id: personGrant.id, humanIds: [invitee], orgIds: [], now: NOW }))
        .acceptedAt,
    ).toEqual(NOW);
    expect(
      (await grants.decline({ id: orgGrant.id, humanIds: [stranger], orgIds: [org], now: NOW }))
        .declinedAt,
    ).toEqual(NOW);
    // Once answered, a stranger still reads not_found (not not_pending).
    await expect(
      grants.accept({ id: personGrant.id, humanIds: [stranger], orgIds: [], now: NOW }),
    ).rejects.toMatchObject({ code: "not_found" });
  }, 60_000);

  test("findActiveForActor matches an org grantee through the caller's org set", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const grants = makePlaceBookingGrantsRepo(prisma!);
    const org = (
      await prisma!.organization.create({
        data: { name: "Actor Org", slug: `actor-org-${Date.now()}` },
      })
    ).id;
    const grant = await mkAcceptedGrant({ kind: "org", orgId: org });
    expect(
      (
        await grants.findActiveForActor({
          placeId,
          calendarId,
          // Org only: personId already holds an older person grant here.
          humanIds: [],
          orgIds: [org],
          now: NOW,
        })
      )?.id,
    ).toBe(grant.id);
    expect(
      await grants.findActiveForActor({
        placeId,
        humanIds: [],
        orgIds: ["00000000-0000-4000-8000-000000000000"],
        now: NOW,
      }),
    ).toBeNull();
    // Sets are typed: a person id never matches the org grant.
    expect(
      await grants.findActiveForActor({
        placeId,
        humanIds: [personId],
        orgIds: [],
        now: NOW,
      }),
    ).not.toMatchObject({ id: grant.id });
  }, 60_000);

  test("listPrincipalsForDelegate: one reverse read, by role, narrowed to candidates, one way only", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const delegates = makeHumanDelegatesRepo(prisma!);
    const mk = async (name: string) =>
      (await prisma!.human.create({ data: { name, status: "ACTIVE" } })).id;
    const delegate = await mk("Delegate");
    const editorOf = await mk("Principal (EDITOR)");
    const adminOf = await mk("Principal (ADMIN)");
    const viewerOf = await mk("Principal (VIEWER)");
    await delegates.addDelegate({ principalId: editorOf, delegateId: delegate, role: "EDITOR" });
    await delegates.addDelegate({ principalId: adminOf, delegateId: delegate, role: "ADMIN" });
    await delegates.addDelegate({ principalId: viewerOf, delegateId: delegate, role: "VIEWER" });
    // The reverse direction: `delegate` is the PRINCIPAL here.
    await delegates.addDelegate({ principalId: delegate, delegateId: editorOf, role: "EDITOR" });

    const edit = ["OWNER", "ADMIN", "EDITOR"] as const;
    expect(
      await delegates.listPrincipalsForDelegate({ delegateId: delegate, roles: edit }),
    ).toEqual([editorOf, adminOf].sort());
    expect(
      await delegates.listPrincipalsForDelegate({
        delegateId: delegate,
        roles: edit,
        principalIds: [adminOf, viewerOf],
      }),
    ).toEqual([adminOf]);
    expect(
      await delegates.listPrincipalsForDelegate({
        delegateId: delegate,
        roles: edit,
        principalIds: [],
      }),
    ).toEqual([]);
    expect(
      await delegates.listPrincipalsForDelegate({ delegateId: delegate, roles: [] }),
    ).toEqual([]);
    // One way: `editorOf` is `delegate`'s delegate, not the other way round.
    expect(
      await delegates.listPrincipalsForDelegate({ delegateId: editorOf, roles: edit }),
    ).toEqual([delegate]);
  }, 60_000);

  test("the booker gate on real repos: as-narrowing, every covering grant, a foreign calendar refused", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const grants = makePlaceBookingGrantsRepo(prisma!);
    const delegates = makeHumanDelegatesRepo(prisma!);
    const mk = async (name: string) =>
      (await prisma!.human.create({ data: { name, status: "ACTIVE" } })).id;
    const actor = await mk("Many-hatted booker");
    const principal = await mk("Principal");
    const outsider = await mk("Outsider");
    const gatePlace = (
      await prisma!.place.create({
        data: { name: "The Gate Room", address: "3 Test St, Nashville, TN" },
      })
    ).id;
    const gateRoom = await prisma!.space.create({
      data: { placeId: gatePlace, name: "Gate Room", sortOrder: 0 },
    });
    const gateCalendar = (
      await prisma!.calendar.create({
        data: {
          placeId: gatePlace,
          name: "Nights",
          slug: "nights",
          isDefault: true,
          primarySpaceId: gateRoom.id,
          calendarSpaces: { create: [{ spaceId: gateRoom.id }] },
        },
      })
    ).id;
    const actorOrg = (
      await prisma!.organization.create({
        data: { name: "Actor's Org", slug: `actors-org-${Date.now()}` },
      })
    ).id;
    await delegates.addDelegate({ principalId: principal, delegateId: actor, role: "EDITOR" });
    const give = (
      grantee: { kind: "org"; orgId: string } | { kind: "person"; humanId: string },
      extra: { calendarId?: string; acceptedAt?: Date | null } = {},
    ) =>
      grants.create({
        placeId: gatePlace,
        grantee,
        grantedByHumanId: ownerHumanId,
        acceptedAt: NOW,
        ...extra,
      });
    const orgGrant = await give({ kind: "org", orgId: actorOrg });
    const principalGrant = await give({ kind: "person", humanId: principal });
    const ownGrant = await give({ kind: "person", humanId: actor });
    const ownCalendarGrant = await give(
      { kind: "person", humanId: actor },
      { calendarId: gateCalendar },
    );
    // Pin createdAt a second apart: back-to-back inserts can share a
    // millisecond, and the order would then fall to the random id.
    for (const [i, g] of [orgGrant, principalGrant, ownGrant, ownCalendarGrant].entries()) {
      await prisma!.placeBookingGrant.update({
        where: { id: g.id },
        data: { createdAt: new Date(NOW.getTime() - (10 - i) * 1000) },
      });
    }
    await give({ kind: "person", humanId: outsider });
    // Pending: covers nobody.
    await give({ kind: "person", humanId: principal }, { acceptedAt: null });

    const repos = {
      // The actor edits actorOrg (the authz adapter is not under test here).
      authz: {
        listOrgMembershipsByHumanId: async ({ humanId }: { humanId: string }) =>
          humanId === actor
            ? [{ orgId: actorOrg, humanId: actor, role: "EDITOR" as const }]
            : [],
      },
      humanDelegates: delegates,
      placeBookingGrants: grants,
      calendars: makeCalendarsRepo(prisma!),
    };
    const place = { id: gatePlace };
    const opts = { now: NOW };

    expect(
      (await listPlaceBookerGrants(repos, place, actor, opts)).map((g) => g.grant.id),
    ).toEqual([orgGrant.id, principalGrant.id, ownGrant.id]);
    expect(
      (
        await listPlaceBookerGrants(repos, place, actor, {
          ...opts,
          calendarId: gateCalendar,
        })
      ).map((g) => g.grant.id),
    ).toEqual([orgGrant.id, principalGrant.id, ownGrant.id, ownCalendarGrant.id]);

    for (const [as, grantId] of [
      [{ kind: "org", orgId: actorOrg }, orgGrant.id],
      [{ kind: "person", humanId: principal }, principalGrant.id],
      [{ kind: "person", humanId: actor }, ownGrant.id],
    ] as const) {
      expect(
        (await findPlaceBookerGrant(repos, place, actor, { ...opts, as }))?.grant.id,
      ).toBe(grantId);
    }
    expect(
      await findPlaceBookerGrant(repos, place, actor, {
        ...opts,
        as: { kind: "person", humanId: outsider },
      }),
    ).toBeNull();
    // A calendar of ANOTHER place (the suite's own) matches nothing.
    expect(
      await findPlaceBookerGrant(repos, place, actor, { ...opts, calendarId }),
    ).toBeNull();
  }, 60_000);

  test("setNote on a hold, a request and an event: saves, checks the edited-at stamp, clears, and says not_found", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const holds = makeBookingHoldsRepo(prisma!);
    const requests = makeBookingRequestsRepo(prisma!);
    const events = makeEventsRepo(prisma!);

    const hold = await holds.createRequestless({
      ownerKind: "PLACE",
      holder: null,
      calendarId,
      date: "2026-11-10",
      position: 1,
      placedByHumanId: ownerHumanId,
      now: NOW,
    });
    const requestId = await mkRequest("Note Act", "2026-11-10");
    const eventId = (
      await prisma!.event.create({
        data: {
          title: "Noted Night",
          startsAt: new Date("2026-11-10T20:00:00.000Z"),
          endsAt: new Date("2026-11-10T23:00:00.000Z"),
          status: "DRAFT",
          humanId: ownerHumanId,
        },
      })
    ).id;

    const repos = [
      ["hold", hold.id, holds.setNote.bind(holds)],
      ["request", requestId, requests.setNote.bind(requests)],
      ["event", eventId, events.setNote.bind(events)],
    ] as const;

    for (const [label, id, setNote] of repos) {
      const first = new Date("2026-10-15T12:00:00.000Z");
      const second = new Date("2026-10-15T12:05:00.000Z");

      // A never-saved note: expected null matches.
      const saved = await setNote({
        id,
        note: `${label} note`,
        updatedByHumanId: ownerHumanId,
        now: first,
        expectedUpdatedAt: null,
      });
      expect(saved, label).toEqual({
        status: "saved",
        note: { note: `${label} note`, noteUpdatedByHumanId: ownerHumanId, noteUpdatedAt: first },
      });

      // A second editor who also opened the empty note loses, and is shown
      // what landed.
      const stale = await setNote({
        id,
        note: "other text",
        updatedByHumanId: personId,
        now: second,
        expectedUpdatedAt: null,
      });
      expect(stale, label).toEqual({
        status: "conflict",
        current: { note: `${label} note`, noteUpdatedByHumanId: ownerHumanId, noteUpdatedAt: first },
      });

      // With the current stamp, the edit lands; "" clears to null.
      const cleared = await setNote({
        id,
        note: "",
        updatedByHumanId: personId,
        now: second,
        expectedUpdatedAt: first,
      });
      expect(cleared, label).toMatchObject({ status: "saved", note: { note: null } });

      expect(
        await setNote({
          id: "00000000-0000-4000-8000-000000000000",
          note: "x",
          updatedByHumanId: ownerHumanId,
          now: second,
        }),
        label,
      ).toEqual({ status: "not_found" });
    }
  }, 60_000);

  test("NO ACTION grant FK: deleting the org cascades its BOOKER hold and its grant together; deleting a held grant alone is refused", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const holds = makeBookingHoldsRepo(prisma!);
    const org = (
      await prisma!.organization.create({
        data: { name: "Leaving Org", slug: `leaving-org-${Date.now()}` },
      })
    ).id;
    const grant = await mkAcceptedGrant({ kind: "org", orgId: org });
    const hold = await holds.createRequestless({
      ownerKind: "BOOKER",
      grantId: grant.id,
      holder: { kind: "org", orgId: org },
      calendarId,
      date: "2026-11-11",
      position: 1,
      placedByHumanId: ownerHumanId,
      now: NOW,
    });

    // The FK still guards the grant on its own.
    await expect(
      prisma!.placeBookingGrant.delete({ where: { id: grant.id } }),
    ).rejects.toThrow();

    // Under RESTRICT this delete failed: the grant's cascade was checked
    // before the hold's cascade removed the referencing row.
    await prisma!.organization.delete({ where: { id: org } });
    expect(await prisma!.bookingHold.count({ where: { id: hold.id } })).toBe(0);
    expect(await prisma!.placeBookingGrant.count({ where: { id: grant.id } })).toBe(0);
  }, 60_000);
  test("revoke support: listLiveForGrant reads the grant's live BOOKER holds; convertBookerHoldToPlace keeps the holder, drops the grant, CASes once", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const holds = makeBookingHoldsRepo(prisma!);
    const grants = makePlaceBookingGrantsRepo(prisma!);
    const org = (
      await prisma!.organization.create({
        data: { name: "Revoked Booker", slug: `revoked-booker-${Date.now()}` },
      })
    ).id;
    const grant = await mkAcceptedGrant({ kind: "org", orgId: org });
    const otherGrant = await mkAcceptedGrant({ kind: "person", humanId: personId });
    const mk = (date: string, g = grant.id, holder: { kind: "org"; orgId: string } | { kind: "person"; humanId: string } = { kind: "org", orgId: org }) =>
      holds.createRequestless({
        ownerKind: "BOOKER",
        grantId: g,
        holder,
        calendarId,
        date,
        position: 1,
        placedByHumanId: ownerHumanId,
        note: "first choice",
        now: NOW,
      });
    const late = await mk("2026-11-21");
    const early = await mk("2026-11-20");
    const released = await mk("2026-11-22");
    await holds.updateStatus({
      id: released.id,
      status: "RELEASED",
      expectedFrom: ["ACTIVE"],
      releasedAt: NOW,
      releasedReason: "MANUAL",
    });
    const foreign = await mk("2026-11-20", otherGrant.id, { kind: "person", humanId: personId });

    const live = await holds.listLiveForGrant(grant.id);
    expect(live.map((h) => h.id)).toEqual([early.id, late.id]);
    expect(live.every((h) => h.ownerKind === "BOOKER" && h.grantId === grant.id)).toBe(true);

    // The CHECK is why the conversion clears the grant: a PLACE row with a
    // grant is refused by Postgres.
    await expect(
      prisma!.$executeRawUnsafe(
        `UPDATE "BookingHold" SET "ownerKind" = 'PLACE' WHERE "id" = $1`,
        early.id,
      ),
    ).rejects.toThrow(/BookingHold_owner_kind_shape|check constraint/i);

    // Wrong grant / not live → null, nothing written.
    expect(await holds.convertBookerHoldToPlace({ id: early.id, grantId: otherGrant.id })).toBeNull();
    expect(await holds.convertBookerHoldToPlace({ id: released.id, grantId: grant.id })).toBeNull();
    expect((await holds.getById(early.id))?.ownerKind).toBe("BOOKER");

    const converted = await holds.convertBookerHoldToPlace({ id: early.id, grantId: grant.id });
    expect(converted).toMatchObject({
      id: early.id,
      ownerKind: "PLACE",
      holder: { kind: "org", orgId: org },
      status: "ACTIVE",
      position: 1,
      note: "first choice",
    });
    const row = await prisma!.bookingHold.findUniqueOrThrow({ where: { id: early.id } });
    expect(row).toMatchObject({ ownerKind: "PLACE", grantId: null, holderOrgId: org });
    // Once: the second conversion loses the CAS.
    expect(await holds.convertBookerHoldToPlace({ id: early.id, grantId: grant.id })).toBeNull();
    // The converted hold no longer rides the grant; the foreign one never did.
    expect((await holds.listLiveForGrant(grant.id)).map((h) => h.id)).toEqual([late.id]);
    expect((await holds.listLiveForGrant(otherGrant.id)).map((h) => h.id)).toEqual([foreign.id]);
    // The grant itself can now be revoked with its kept hold alive.
    await expect(grants.revoke({ id: grant.id, placeId, now: NOW })).resolves.toMatchObject({
      revokedAt: NOW,
    });
  }, 60_000);

  test("getForGrantee reads a grant in any state only for its grantee", async ({ skip }) => {
    if (!ready(skip)) return;
    const grants = makePlaceBookingGrantsRepo(prisma!);
    const pending = await grants.create({
      placeId,
      grantee: { kind: "org", orgId },
      grantedByHumanId: ownerHumanId,
    });
    await grants.decline({ id: pending.id, humanIds: [], orgIds: [orgId], now: NOW });
    await expect(
      grants.getForGrantee({ id: pending.id, humanIds: [], orgIds: [orgId] }),
    ).resolves.toMatchObject({ id: pending.id, declinedAt: NOW });
    await expect(
      grants.getForGrantee({ id: pending.id, humanIds: [orgId, personId], orgIds: [] }),
    ).resolves.toBeNull();
    await expect(
      grants.getForGrantee({ id: pending.id, humanIds: [], orgIds: [] }),
    ).resolves.toBeNull();
  }, 60_000);

  test("accept / decline refuse a pending grant past its expiry at `now`: not_pending, row unchanged", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const grants = makePlaceBookingGrantsRepo(prisma!);
    const lapsed = await grants.create({
      placeId,
      grantee: { kind: "org", orgId },
      grantedByHumanId: ownerHumanId,
      expiresAt: NOW,
    });
    const asOrg = { humanIds: [], orgIds: [orgId], now: NOW };
    await expect(grants.accept({ id: lapsed.id, ...asOrg })).rejects.toMatchObject({
      code: "conflict",
      message: "place_booking_grant_not_pending",
    });
    await expect(grants.decline({ id: lapsed.id, ...asOrg })).rejects.toMatchObject({
      message: "place_booking_grant_not_pending",
    });
    await expect(
      prisma!.placeBookingGrant.findUnique({ where: { id: lapsed.id } }),
    ).resolves.toMatchObject({ acceptedAt: null, declinedAt: null });
    // A second before its expiry it can still be accepted.
    const accepted = await grants.accept({
      id: lapsed.id,
      ...asOrg,
      now: new Date(NOW.getTime() - 1000),
    });
    expect(accepted.acceptedAt).toEqual(new Date(NOW.getTime() - 1000));
  }, 60_000);

  test("two gives at once write ONE grant: the second waits on the place's grant-set lock, then returns the first", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const giver = (
      await prisma!.human.create({ data: { name: "Racing Giver", status: "ACTIVE" } })
    ).id;
    const racePlace = (
      await prisma!.place.create({
        data: { name: "The Race Room", address: "9 Test St, Nashville, TN" },
      })
    ).id;
    await prisma!.placeOwnership.create({
      data: { placeId: racePlace, ownerType: "HUMAN", ownerId: giver, verified: true },
    });
    const raceOrg = (
      await prisma!.organization.create({
        data: { name: "Double Submit Promotions", slug: `double-submit-${Date.now()}` },
      })
    ).id;
    const page = await prisma!.entityPage.create({
      data: {
        ownerType: "ORGANIZATION",
        ownerId: raceOrg,
        slug: `double-submit-${Date.now()}`,
        visibility: "PUBLIC",
      },
    });

    // Workers on their own pool, tagged so the test can see them queue.
    const applicationName = `grant-give-race-${Date.now()}`;
    const url = new URL(pg!.databaseUrl);
    url.searchParams.set("application_name", applicationName);
    const workerPool = new Pool({ connectionString: url.toString() });
    const workerPrisma = new PrismaClient({ adapter: new PrismaPg(workerPool) });
    const deps = {
      repos: createPrismaRepos(workerPrisma),
      clock: { now: () => new Date() },
    };

    // Hold the SAME key lockPlace takes, from another transaction, so both
    // gives queue at the lock instead of racing on event-loop timing.
    let release!: () => void;
    const mayRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const isAcquired = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holder = prisma!.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`place_booking_grants:${racePlace}`}))`;
        acquired();
        await mayRelease;
      },
      { timeout: 20_000 },
    );
    try {
      await isAcquired;
      const input = { actorHumanId: giver, placeId: racePlace, granteePageId: page.id };
      const gives = [
        givePlaceBookingGrant(deps, input),
        givePlaceBookingGrant(deps, input),
      ];
      // Both reached the lock (neither could have written yet).
      let waiting = 0;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const rows = await prisma!.$queryRaw<{ waiting: number }[]>`
          SELECT COUNT(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database()
            AND application_name = ${applicationName}
            AND wait_event_type = 'Lock'`;
        waiting = rows[0]?.waiting ?? 0;
        if (waiting >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(2);
      expect(
        await prisma!.placeBookingGrant.count({ where: { placeId: racePlace } }),
      ).toBe(0);

      release();
      await holder;
      const results = await Promise.all(gives);
      expect(results.map((r) => r.alreadyGiven).sort()).toEqual([false, true]);
      expect(results[0]!.grant.id).toBe(results[1]!.grant.id);
      // One notice, from the give that wrote.
      expect(results.flatMap((r) => r.notificationIntents)).toHaveLength(1);
      const rows = await prisma!.placeBookingGrant.findMany({
        where: { placeId: racePlace },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ granteeOrgId: raceOrg, revokedAt: null });
    } finally {
      release();
      await holder.catch(() => undefined);
      await workerPrisma.$disconnect();
      await workerPool.end();
    }
  }, 60_000);

  // ── plan step 6 ──────────────────────────────────────────────────────────

  test("step 6: lockSharedAtPlace is place-scoped; a BOOKER hold reads its grant's revoke and expiry; clearPlaceHolder CASes the named holder off once", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const holds = makeBookingHoldsRepo(prisma!);
    const grants = makePlaceBookingGrantsRepo(prisma!);
    const org = (
      await prisma!.organization.create({
        data: { name: "Step Six Booker", slug: `step-six-booker-${Date.now()}` },
      })
    ).id;
    const expiresAt = new Date("2026-12-31T00:00:00.000Z");
    const grant = await grants.create({
      placeId,
      grantee: { kind: "org", orgId: org },
      grantedByHumanId: ownerHumanId,
      acceptedAt: NOW,
      expiresAt,
    });
    const otherPlace = (
      await prisma!.place.create({ data: { name: "Elsewhere", address: "3 Test St, Nashville, TN" } })
    ).id;

    await prisma!.$transaction(async (tx) => {
      const repo = makePlaceBookingGrantsRepo(tx as never);
      expect(await repo.lockSharedAtPlace({ id: grant.id, placeId })).toMatchObject({
        id: grant.id,
        placeId,
        revokedAt: null,
      });
      expect(await repo.lockSharedAtPlace({ id: grant.id, placeId: otherPlace })).toBeNull();
    });

    const booker = await holds.createRequestless({
      ownerKind: "BOOKER",
      grantId: grant.id,
      holder: { kind: "org", orgId: org },
      calendarId,
      date: "2026-11-27",
      position: 1,
      placedByHumanId: ownerHumanId,
      note: null,
      now: NOW,
    });
    expect(booker).toMatchObject({ ownerKind: "BOOKER", grantRevokedAt: null, grantExpiresAt: expiresAt });
    await grants.revoke({ id: grant.id, placeId, now: NOW });
    expect(await holds.getById(booker.id)).toMatchObject({ grantRevokedAt: NOW, grantExpiresAt: expiresAt });
    const line = await holds.listLine({ calendarId, date: "2026-11-27" });
    expect(line.find((h) => h.id === booker.id)).toMatchObject({ grantRevokedAt: NOW });

    // clearPlaceHolder: only a live PLACE hold naming exactly that holder.
    const named = await holds.createRequestless({
      ownerKind: "PLACE",
      holder: { kind: "person", humanId: personId },
      calendarId,
      date: "2026-11-28",
      position: 1,
      placedByHumanId: ownerHumanId,
      note: "named",
      now: NOW,
    });
    expect(await holds.clearPlaceHolder({ id: named.id, holder: { kind: "org", orgId: org } })).toBeNull();
    expect(await holds.clearPlaceHolder({ id: booker.id, holder: { kind: "org", orgId: org } })).toBeNull();
    const passed = await holds.clearPlaceHolder({ id: named.id, holder: { kind: "person", humanId: personId } });
    expect(passed).toMatchObject({ id: named.id, ownerKind: "PLACE", holder: null, position: 1, status: "ACTIVE", note: "named" });
    expect(
      await prisma!.bookingHold.findUniqueOrThrow({ where: { id: named.id } }),
    ).toMatchObject({ holderOrgId: null, holderHumanId: null });
    // Once.
    expect(await holds.clearPlaceHolder({ id: named.id, holder: { kind: "person", humanId: personId } })).toBeNull();
    // A passed holder may hold the line again (the per-holder unique is free).
    await expect(
      holds.createRequestless({
        ownerKind: "PLACE",
        holder: { kind: "person", humanId: personId },
        calendarId,
        date: "2026-11-28",
        position: 2,
        placedByHumanId: ownerHumanId,
        note: null,
        now: NOW,
      }),
    ).resolves.toMatchObject({ position: 2 });
  }, 60_000);

  test("step 6 trap m: a revoke waits on a placement's FOR SHARE grant lock; two placements share it", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const grants = makePlaceBookingGrantsRepo(prisma!);
    const org = (
      await prisma!.organization.create({
        data: { name: "Share Lock Booker", slug: `share-lock-booker-${Date.now()}` },
      })
    ).id;
    const grant = await grants.create({
      placeId,
      grantee: { kind: "org", orgId: org },
      grantedByHumanId: ownerHumanId,
      acceptedAt: NOW,
    });

    const applicationName = `grant-share-lock-${Date.now()}`;
    const url = new URL(pg!.databaseUrl);
    url.searchParams.set("application_name", applicationName);
    const workerPool = new Pool({ connectionString: url.toString() });
    const workerPrisma = new PrismaClient({ adapter: new PrismaPg(workerPool) });

    let release!: () => void;
    const mayRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const isAcquired = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    // The placement: grant row FOR SHARE, held open (as while it writes holds).
    const placement = prisma!.$transaction(
      async (tx) => {
        const locked = await makePlaceBookingGrantsRepo(tx as never).lockSharedAtPlace({ id: grant.id, placeId });
        expect(locked?.revokedAt).toBeNull();
        acquired();
        await mayRelease;
      },
      { timeout: 20_000 },
    );
    try {
      await isAcquired;
      // A second placement takes the same share lock without waiting.
      await workerPrisma.$transaction(async (tx) => {
        await expect(
          makePlaceBookingGrantsRepo(tx as never).lockSharedAtPlace({ id: grant.id, placeId }),
        ).resolves.toMatchObject({ id: grant.id });
      });

      const revoking = makePlaceBookingGrantsRepo(workerPrisma).revoke({ id: grant.id, placeId, now: NOW });
      let waiting = 0;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const rows = await prisma!.$queryRaw<{ waiting: number }[]>`
          SELECT COUNT(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database()
            AND application_name = ${applicationName}
            AND wait_event_type = 'Lock'`;
        waiting = rows[0]?.waiting ?? 0;
        if (waiting >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(1);
      expect(
        (await prisma!.placeBookingGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedAt,
      ).toBeNull();

      release();
      await placement;
      await expect(revoking).resolves.toMatchObject({ revokedAt: NOW });
    } finally {
      release();
      await placement.catch(() => undefined);
      await workerPrisma.$disconnect();
      await workerPool.end();
    }
  }, 60_000);
});
