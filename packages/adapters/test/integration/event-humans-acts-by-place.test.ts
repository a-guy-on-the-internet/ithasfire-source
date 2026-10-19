import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEventHumansRepo } from "../../src/db/prisma/event-humans";

/**
 * `EventHumansRepo.listActsByPlace` (venue-track-record spec 2026-09-24,
 * FR-013 / R7; FU-006 moved the per-act grouping from core into this SQL).
 *
 * Two things are pinned here. The GATE: a credit counts only when the event
 * page would already show the lineup — PUBLISHED-or-COMPLETED, PUBLIC, ENDED,
 * venue-confirmed for THIS place — and a profile link only when the act's
 * page is PUBLIC; every exclusion is a way a venue page could disclose
 * something an event page does not. And the GROUPING: one act per linked
 * human or per trimmed, case-folded stage name; distinct shows counted;
 * ordered lastPlayedAt DESC then name; LIMIT in SQL with the total intact.
 */
describe("Prisma adapters integration – listActsByPlace", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  const NOW = new Date("2026-09-01T12:00:00.000Z");
  const ids: Record<string, string> = {};

  async function makeHuman(name: string | null): Promise<string> {
    const h = await prisma!.human.create({ data: { name, status: "ACTIVE" } });
    return h.id;
  }

  async function makePage(
    humanId: string,
    slug: string,
    visibility: "PUBLIC" | "PRIVATE" | "UNLISTED",
  ) {
    await prisma!.entityPage.create({
      data: {
        ownerType: "HUMAN",
        ownerId: humanId,
        slug,
        visibility,
        displayName: `Page ${slug}`,
      },
    });
  }

  async function makeEvent(opts: {
    title: string;
    startsAt: Date;
    endsAt?: Date;
    placeId?: string;
    status?: "DRAFT" | "PUBLISHED" | "CANCELLED" | "COMPLETED";
    visibility?: "PUBLIC" | "PRIVATE";
    stampedFor?: string | null;
    withdrawn?: boolean;
    ownerHumanId?: string | null;
    stewardship?: "COMMUNITY";
  }): Promise<string> {
    const ev = await prisma!.event.create({
      data: {
        title: opts.title,
        startsAt: opts.startsAt,
        endsAt:
          opts.endsAt ?? new Date(opts.startsAt.getTime() + 3 * 60 * 60 * 1000),
        status: opts.status ?? "PUBLISHED",
        visibility: opts.visibility ?? "PUBLIC",
        placeId: opts.placeId ?? ids.place!,
        humanId: opts.ownerHumanId ?? null,
        ...(opts.stampedFor
          ? {
              venueConfirmedAt: new Date("2026-01-01T00:00:00.000Z"),
              venueConfirmedPlaceId: opts.stampedFor,
              ...(opts.withdrawn
                ? {
                    venueConfirmationWithdrawnAt: new Date(
                      "2026-01-02T00:00:00.000Z",
                    ),
                  }
                : {}),
            }
          : {}),
        // A COMMUNITY listing is ownerless and RSVP by check constraint
        // (`event_community_ownerless_rsvp_check`).
        ...(opts.stewardship
          ? { stewardship: opts.stewardship, attendanceMode: "RSVP" as const }
          : {}),
      },
    });
    return ev.id;
  }

  async function credit(
    eventId: string,
    opts: {
      humanId?: string;
      externalName?: string | null;
      role?: "PERFORMER" | "DJ" | "HOST";
      sortOrder?: number;
    },
  ) {
    await prisma!.eventHuman.create({
      data: {
        eventId,
        humanId: opts.humanId ?? null,
        externalName: opts.externalName ?? null,
        role: opts.role ?? "PERFORMER",
        sortOrder: opts.sortOrder ?? 0,
      },
    });
  }

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const place = await prisma.place.create({
        data: { name: "The Room", address: "1 Room St", status: "ACTIVE" },
      });
      ids.place = place.id;
      const other = await prisma.place.create({
        data: { name: "Elsewhere", address: "2 Other St", status: "ACTIVE" },
      });
      ids.otherPlace = other.id;

      ids.owner = await makeHuman("Venue Owner");
      ids.publicAct = await makeHuman("Linked Public");
      await makePage(ids.publicAct, "linked-public", "PUBLIC");
      ids.privateAct = await makeHuman("Linked Private");
      await makePage(ids.privateAct, "linked-private", "PRIVATE");
      ids.unlistedAct = await makeHuman("Linked Unlisted");
      await makePage(ids.unlistedAct, "linked-unlisted", "UNLISTED");
      ids.pagelessAct = await makeHuman("Linked Pageless");
      ids.namelessAct = await makeHuman(null);

      // ── Included: stamped for THIS place, ended, PUBLISHED PUBLIC.
      ids.stamped = await makeEvent({
        title: "Stamped",
        startsAt: new Date("2026-06-01T20:00:00.000Z"),
        stampedFor: ids.place,
      });
      await credit(ids.stamped, { humanId: ids.publicAct, sortOrder: 0 });
      await credit(ids.stamped, { humanId: ids.privateAct, sortOrder: 1 });
      await credit(ids.stamped, { humanId: ids.unlistedAct, sortOrder: 2 });
      await credit(ids.stamped, { humanId: ids.pagelessAct, sortOrder: 3 });
      await credit(ids.stamped, {
        externalName: "Free Text Act",
        sortOrder: 4,
      });
      // Not acts on the bill: a DJ and a host credit.
      await credit(ids.stamped, {
        externalName: "Some DJ",
        role: "DJ",
        sortOrder: 5,
      });
      await credit(ids.stamped, {
        externalName: "The Host",
        role: "HOST",
        sortOrder: 6,
      });
      // Nothing to name: linked human with no name and no stage name; blank
      // stage name; free-text row with neither.
      await credit(ids.stamped, { humanId: ids.namelessAct, sortOrder: 7 });
      await credit(ids.stamped, { externalName: "   ", sortOrder: 8 });
      await credit(ids.stamped, { externalName: null, sortOrder: 9 });

      // ── Included: OWNED by the venue's human (owner arm), earlier night.
      ids.owned = await makeEvent({
        title: "Owned",
        startsAt: new Date("2026-05-01T20:00:00.000Z"),
        ownerHumanId: ids.owner,
      });
      await credit(ids.owned, { externalName: "Free Text Act", sortOrder: 0 });
      await credit(ids.owned, { humanId: ids.publicAct, sortOrder: 1 });

      // ── Included: COMPLETED (R10) — `completeEvent` closed it out, it
      // still happened. Oldest night, so it lands last.
      ids.completed = await makeEvent({
        title: "Completed",
        startsAt: new Date("2026-03-01T20:00:00.000Z"),
        status: "COMPLETED",
        stampedFor: ids.place,
      });
      await credit(ids.completed, { externalName: "Completed Act" });

      // ── Excluded: CANCELLED, even though stamped and "ended".
      ids.cancelled = await makeEvent({
        title: "Cancelled",
        startsAt: new Date("2026-03-02T20:00:00.000Z"),
        status: "CANCELLED",
        stampedFor: ids.place,
      });
      await credit(ids.cancelled, { externalName: "Cancelled Act" });

      // ── Included only when the venue accepts community listings.
      ids.community = await makeEvent({
        title: "Community",
        startsAt: new Date("2026-04-01T20:00:00.000Z"),
        stewardship: "COMMUNITY",
      });
      await credit(ids.community, { externalName: "Community Act" });

      // ── Excluded, one reason each.
      ids.draft = await makeEvent({
        title: "Draft",
        startsAt: new Date("2026-06-02T20:00:00.000Z"),
        status: "DRAFT",
        stampedFor: ids.place,
      });
      await credit(ids.draft, { externalName: "Draft Act" });

      ids.privateEvent = await makeEvent({
        title: "Private",
        startsAt: new Date("2026-06-03T20:00:00.000Z"),
        visibility: "PRIVATE",
        stampedFor: ids.place,
      });
      await credit(ids.privateEvent, { externalName: "Private Act" });

      // Started before NOW, ends after it — in progress is not history.
      ids.inProgress = await makeEvent({
        title: "In progress",
        startsAt: new Date("2026-09-01T10:00:00.000Z"),
        endsAt: new Date("2026-09-01T14:00:00.000Z"),
        stampedFor: ids.place,
      });
      await credit(ids.inProgress, { externalName: "In Progress Act" });

      ids.unconfirmed = await makeEvent({
        title: "Unconfirmed third party",
        startsAt: new Date("2026-06-04T20:00:00.000Z"),
      });
      await credit(ids.unconfirmed, { externalName: "Planted Act" });

      ids.withdrawn = await makeEvent({
        title: "Withdrawn",
        startsAt: new Date("2026-06-05T20:00:00.000Z"),
        stampedFor: ids.place,
        withdrawn: true,
      });
      await credit(ids.withdrawn, { externalName: "Withdrawn Act" });

      // Stamp bound to ANOTHER place — the event moved after confirmation.
      ids.movedStamp = await makeEvent({
        title: "Moved stamp",
        startsAt: new Date("2026-06-06T20:00:00.000Z"),
        stampedFor: ids.otherPlace,
      });
      await credit(ids.movedStamp, { externalName: "Moved Act" });

      ids.elsewhere = await makeEvent({
        title: "Elsewhere",
        startsAt: new Date("2026-06-07T20:00:00.000Z"),
        placeId: ids.otherPlace,
        stampedFor: ids.otherPlace,
      });
      await credit(ids.elsewhere, { externalName: "Elsewhere Act" });

      // ── GROUPING fixtures, on their own place so the gate tests above stay
      // crisp. Every show is OWNED by the venue's human (owner arm).
      const grouping = await prisma.place.create({
        data: { name: "Grouping Room", address: "3 Group St", status: "ACTIVE" },
      });
      ids.gplace = grouping.id;
      const gEvent = (
        title: string,
        startsAt: string,
        status?: "PUBLISHED" | "COMPLETED" | "CANCELLED",
      ) =>
        makeEvent({
          title,
          startsAt: new Date(startsAt),
          placeId: ids.gplace!,
          ownerHumanId: ids.owner!,
          ...(status ? { status } : {}),
        });

      // Newest night: the linked act, an UNLINKED act with the SAME name
      // (two acts — the link is the identity), and the Sundowners.
      ids.g1 = await gEvent("G1", "2026-08-01T20:00:00.000Z");
      await credit(ids.g1, { humanId: ids.publicAct, sortOrder: 0 });
      await credit(ids.g1, { externalName: "Linked Public", sortOrder: 1 });
      await credit(ids.g1, { externalName: "The Sundowners", sortOrder: 2 });

      // Older night: the Sundowners billed TWICE on one show under other
      // spellings (trim + case fold → same act; one show, not two), and the
      // linked act again.
      ids.g2 = await gEvent("G2", "2026-07-01T20:00:00.000Z");
      await credit(ids.g2, { externalName: "  the sundowners\t", sortOrder: 0 });
      await credit(ids.g2, { externalName: "the SUNDOWNERS", sortOrder: 1 });
      await credit(ids.g2, { humanId: ids.publicAct, sortOrder: 2 });

      // Two stages at the same instant are two shows.
      ids.g3 = await gEvent("G3 main stage", "2026-06-01T20:00:00.000Z");
      await credit(ids.g3, { externalName: "Stage Act" });
      ids.g4 = await gEvent("G4 side stage", "2026-06-01T20:00:00.000Z");
      await credit(ids.g4, { externalName: "Stage Act " });

      // R10: COMPLETED counts; CANCELLED does not.
      ids.g5 = await gEvent("G5", "2026-05-01T20:00:00.000Z", "COMPLETED");
      await credit(ids.g5, { externalName: "Closer" });
      ids.g6 = await gEvent("G6", "2026-05-02T20:00:00.000Z", "CANCELLED");
      await credit(ids.g6, { externalName: "Cancelled Grouping Act" });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("listActsByPlace setup failed:", error);
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

  const OWNER_ARM = () => ({
    orgIds: [],
    humanIds: [ids.owner!],
    acceptsCommunityListings: false,
  });
  const NO_OWNER_ARM = {
    orgIds: [],
    humanIds: [],
    acceptsCommunityListings: false,
  };

  test("gate: only confirmed, ended, PUBLISHED-or-COMPLETED PUBLIC PERFORMER credits with a name", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventHumansRepo(prisma);
    const page = await repo.listActsByPlace({
      placeId: ids.place!,
      now: NOW,
      venueConfirmedFor: OWNER_ARM(),
      limit: null,
    });

    // lastPlayedAt DESC, then name. Free Text Act and Linked Public played
    // the stamped AND the owned show, so they count 2; the stamped night is
    // their latest.
    expect(
      page.acts.map((a) => [a.name, a.timesPlayed, a.lastPlayedAt.toISOString()]),
    ).toStrictEqual([
      ["Free Text Act", 2, "2026-06-01T20:00:00.000Z"],
      ["Linked Pageless", 1, "2026-06-01T20:00:00.000Z"],
      ["Linked Private", 1, "2026-06-01T20:00:00.000Z"],
      ["Linked Public", 2, "2026-06-01T20:00:00.000Z"],
      ["Linked Unlisted", 1, "2026-06-01T20:00:00.000Z"],
      // COMPLETED (R10) counts.
      ["Completed Act", 1, "2026-03-01T20:00:00.000Z"],
    ]);
    expect(page.totalActs).toBe(6);

    // Nothing from the excluded shows or roles leaked, and nothing nameless.
    const names = page.acts.map((a) => a.name);
    for (const leaked of [
      "Cancelled Act",
      "Community Act",
      "Draft Act",
      "Private Act",
      "In Progress Act",
      "Planted Act",
      "Withdrawn Act",
      "Moved Act",
      "Elsewhere Act",
      "Some DJ",
      "The Host",
      "",
    ]) {
      expect(names).not.toContain(leaked);
    }
  }, 60_000);

  test("without the owner arm the owned show drops out — counts follow the filter", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventHumansRepo(prisma);
    const page = await repo.listActsByPlace({
      placeId: ids.place!,
      now: NOW,
      venueConfirmedFor: NO_OWNER_ARM,
      limit: null,
    });
    const byName = new Map(page.acts.map((a) => [a.name, a.timesPlayed]));
    expect(byName.get("Free Text Act")).toBe(1);
    expect(byName.get("Linked Public")).toBe(1);
    expect(page.totalActs).toBe(6);
  }, 60_000);

  test("profileSlug ONLY for a PUBLIC page (PRIVATE / UNLISTED / no page → null); linked vs unlinked shape", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventHumansRepo(prisma);
    const page = await repo.listActsByPlace({
      placeId: ids.place!,
      now: NOW,
      venueConfirmedFor: NO_OWNER_ARM,
      limit: null,
    });
    const at = new Date("2026-06-01T20:00:00.000Z");

    expect(page.acts.slice(0, 5)).toStrictEqual([
      {
        humanId: null,
        externalName: "Free Text Act",
        name: "Free Text Act",
        profileSlug: null,
        timesPlayed: 1,
        lastPlayedAt: at,
      },
      {
        humanId: ids.pagelessAct,
        externalName: null,
        name: "Linked Pageless",
        profileSlug: null,
        timesPlayed: 1,
        lastPlayedAt: at,
      },
      {
        humanId: ids.privateAct,
        externalName: null,
        name: "Linked Private",
        profileSlug: null,
        timesPlayed: 1,
        lastPlayedAt: at,
      },
      {
        humanId: ids.publicAct,
        externalName: null,
        name: "Linked Public",
        profileSlug: "linked-public",
        timesPlayed: 1,
        lastPlayedAt: at,
      },
      {
        humanId: ids.unlistedAct,
        externalName: null,
        name: "Linked Unlisted",
        profileSlug: null,
        timesPlayed: 1,
        lastPlayedAt: at,
      },
    ]);
  }, 60_000);

  test("the community arm admits an accepted COMMUNITY listing only when the venue consents", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventHumansRepo(prisma);
    const withConsent = await repo.listActsByPlace({
      placeId: ids.place!,
      now: NOW,
      venueConfirmedFor: { ...NO_OWNER_ARM, acceptsCommunityListings: true },
      limit: null,
    });
    const names = withConsent.acts.map((a) => a.name);
    expect(names).toContain("Community Act");
    // The unconfirmed third-party event is still out: COMMUNITY stewardship
    // is what the arm keys on, not "no stamp".
    expect(names).not.toContain("Planted Act");
  }, 60_000);

  test("grouping: linked vs unlinked same name stay apart; trim + case fold; duplicate credit on one show = 1; two stages = 2; COMPLETED in, CANCELLED out", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventHumansRepo(prisma);
    const page = await repo.listActsByPlace({
      placeId: ids.gplace!,
      now: NOW,
      venueConfirmedFor: OWNER_ARM(),
      limit: null,
    });

    expect(page.acts).toStrictEqual([
      // Same night, same name: the LINKED act (humanId sorts first) and the
      // unlinked one are two acts. The linked one played G1 and G2.
      {
        humanId: ids.publicAct,
        externalName: null,
        name: "Linked Public",
        profileSlug: "linked-public",
        timesPlayed: 2,
        lastPlayedAt: new Date("2026-08-01T20:00:00.000Z"),
      },
      {
        humanId: null,
        externalName: "Linked Public",
        name: "Linked Public",
        profileSlug: null,
        timesPlayed: 1,
        lastPlayedAt: new Date("2026-08-01T20:00:00.000Z"),
      },
      // Three spellings, one act; billed twice on G2 but that is ONE show.
      // The display name is the most recent spelling.
      {
        humanId: null,
        externalName: "The Sundowners",
        name: "The Sundowners",
        profileSlug: null,
        timesPlayed: 2,
        lastPlayedAt: new Date("2026-08-01T20:00:00.000Z"),
      },
      // Two Event rows at one instant are two shows.
      {
        humanId: null,
        externalName: "Stage Act",
        name: "Stage Act",
        profileSlug: null,
        timesPlayed: 2,
        lastPlayedAt: new Date("2026-06-01T20:00:00.000Z"),
      },
      {
        humanId: null,
        externalName: "Closer",
        name: "Closer",
        profileSlug: null,
        timesPlayed: 1,
        lastPlayedAt: new Date("2026-05-01T20:00:00.000Z"),
      },
    ]);
    expect(page.totalActs).toBe(5);
    expect(page.acts.map((a) => a.name)).not.toContain(
      "Cancelled Grouping Act",
    );
  }, 60_000);

  test("LIMIT is applied in SQL after grouping; totalActs still counts every act", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventHumansRepo(prisma);
    const page = await repo.listActsByPlace({
      placeId: ids.gplace!,
      now: NOW,
      venueConfirmedFor: OWNER_ARM(),
      limit: 2,
    });
    expect(page.acts.map((a) => [a.name, a.humanId === null])).toStrictEqual([
      ["Linked Public", false],
      ["Linked Public", true],
    ]);
    expect(page.totalActs).toBe(5);

    // A limit past the end returns everything, same total.
    const all = await repo.listActsByPlace({
      placeId: ids.gplace!,
      now: NOW,
      venueConfirmedFor: OWNER_ARM(),
      limit: 500,
    });
    expect(all.acts).toHaveLength(5);
    expect(all.totalActs).toBe(5);
  }, 60_000);

  test("an empty history is { acts: [], totalActs: 0 } — and `now` bounds it", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventHumansRepo(prisma);
    // Before any grouping show ended.
    const page = await repo.listActsByPlace({
      placeId: ids.gplace!,
      now: new Date("2026-01-01T00:00:00.000Z"),
      venueConfirmedFor: OWNER_ARM(),
      limit: 8,
    });
    expect(page).toStrictEqual({ acts: [], totalActs: 0 });

    // Between G5 (ended 05-01 23:00) and G3/G4: only the Closer.
    const early = await repo.listActsByPlace({
      placeId: ids.gplace!,
      now: new Date("2026-05-15T00:00:00.000Z"),
      venueConfirmedFor: OWNER_ARM(),
      limit: 8,
    });
    expect(early.acts.map((a) => a.name)).toStrictEqual(["Closer"]);
    expect(early.totalActs).toBe(1);
  }, 60_000);

  test("lineup v3 FR-015: a GROUP row is its own act (by orgId), named by the org, linked only to a PUBLIC page; listByEvent resolves it too", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventHumansRepo(prisma);
    const room = await prisma.place.create({
      data: { name: "Group Room", address: "4 Group St", status: "ACTIVE" },
    });
    const band = await prisma.organization.create({
      data: { name: "Paper Moth", slug: `paper-moth-${room.id.slice(0, 8)}` },
    });
    const hidden = await prisma.organization.create({
      data: { name: "Hidden Band", slug: `hidden-band-${room.id.slice(0, 8)}` },
    });
    await prisma.entityPage.create({
      data: {
        ownerType: "ORGANIZATION",
        ownerId: band.id,
        slug: `paper-moth-page-${room.id.slice(0, 8)}`,
        visibility: "PUBLIC",
        displayName: "Paper Moth (page)",
      },
    });
    await prisma.entityPage.create({
      data: {
        ownerType: "ORGANIZATION",
        ownerId: hidden.id,
        slug: `hidden-band-page-${room.id.slice(0, 8)}`,
        visibility: "PRIVATE",
      },
    });
    const show = (title: string, startsAt: string) =>
      makeEvent({
        title,
        startsAt: new Date(startsAt),
        placeId: room.id,
        ownerHumanId: ids.owner!,
      });
    const groupCredit = (eventId: string, orgId: string, externalName: string, sortOrder: number) =>
      prisma!.eventHuman.create({
        data: { eventId, orgId, externalName, role: "PERFORMER", sortOrder },
      });

    const first = await show("Band night 1", "2026-07-01T20:00:00.000Z");
    const second = await show("Band night 2", "2026-08-01T20:00:00.000Z");
    // The band on two shows, under two stage-name snapshots: ONE act.
    await groupCredit(first, band.id, "paper moth", 0);
    await groupCredit(second, band.id, "Paper Moth", 0);
    // A FREE-TEXT act with the band's exact name is a different act.
    await credit(second, { externalName: "Paper Moth", sortOrder: 1 });
    // A group whose page is PRIVATE: named, never linked.
    await groupCredit(second, hidden.id, "Hidden", 2);

    const page = await repo.listActsByPlace({
      placeId: room.id,
      now: NOW,
      venueConfirmedFor: OWNER_ARM(),
      limit: null,
    });

    const byName = (name: string, orgId?: string) =>
      page.acts.find((a) => a.name === name && (orgId ? a.orgId === orgId : !a.orgId));
    expect(page.totalActs).toBe(3);
    expect(byName("Paper Moth", band.id)).toStrictEqual({
      humanId: null,
      externalName: null,
      name: "Paper Moth",
      profileSlug: null,
      orgId: band.id,
      orgPageSlug: `paper-moth-page-${room.id.slice(0, 8)}`,
      timesPlayed: 2,
      lastPlayedAt: new Date("2026-08-01T20:00:00.000Z"),
    });
    // The free-text namesake: unchanged shape (no org keys at all).
    expect(byName("Paper Moth")).toStrictEqual({
      humanId: null,
      externalName: "Paper Moth",
      name: "Paper Moth",
      profileSlug: null,
      timesPlayed: 1,
      lastPlayedAt: new Date("2026-08-01T20:00:00.000Z"),
    });
    expect(byName("Hidden Band", hidden.id)).toMatchObject({ orgPageSlug: null });

    // listByEvent: the group row carries the org's display name and ONLY a
    // PUBLIC page; the free-text row carries no org keys.
    const lineup = await repo.listByEvent(second);
    expect(lineup.map((row) => [row.orgId, row.orgName, row.orgPageSlug])).toStrictEqual([
      [band.id, "Paper Moth (page)", `paper-moth-page-${room.id.slice(0, 8)}`],
      [null, undefined, undefined],
      [hidden.id, "Hidden Band", null],
    ]);
  }, 60_000);
});
