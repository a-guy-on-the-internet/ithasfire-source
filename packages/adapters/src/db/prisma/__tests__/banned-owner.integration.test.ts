import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import {
  eventOwnerNotWithheldSubquerySql,
  resolveWithheldOwners,
  SEARCH_DOC_NOT_WITHHELD_SQL,
} from "../banned-owner";
import { canonicalEmail } from "@th/core/lib/event-edit-rights";

import { makeEventsRepo } from "../events";
import { makeHumansRepo } from "../humans";
import { makeNetworkSightingsRepo } from "../network-sightings";

// ---------------------------------------------------------------------------
// Ban that sticks — the withheld-owner rule against REAL Postgres (review
// round 1, item 11). Pins what mocks cannot:
//   · the raw SQL (withheld set, COALESCE'd subquery) and the Prisma id-set
//     filter agree, and both are NULL-safe — org events and ownerless
//     community listings survive (Prisma's `NOT: { col: { in } }` would drop
//     every NULL row; measured 0/45 on the dev DB);
//   · an org stays up while it has ONE un-banned OWNER;
//   · the flagged-sign-ups join is derived, excludes the banned human's own
//     sightings and expired ban rows;
//   · reactivation (status back to ACTIVE) restores everything.
//
// Runs on a throwaway `test_*` database: a Testcontainer by default, or an
// existing server via TESTCONTAINERS_REUSE_DATABASE_URL (no container).
// ---------------------------------------------------------------------------

const BANNED = "10000000-0000-4000-8000-000000000001";
const COOWNER = "10000000-0000-4000-8000-000000000002";
const SIGNUP = "10000000-0000-4000-8000-000000000003";
const ORG_BANNED = "20000000-0000-4000-8000-000000000001";
const ORG_LIVE = "20000000-0000-4000-8000-000000000002";
const EV_BANNED_PERSONAL = "30000000-0000-4000-8000-000000000001";
const EV_BANNED_ORG = "30000000-0000-4000-8000-000000000002";
const EV_LIVE_ORG = "30000000-0000-4000-8000-000000000003";
const EV_COMMUNITY = "30000000-0000-4000-8000-000000000004";
const EV_COOWNER_PERSONAL = "30000000-0000-4000-8000-000000000005";
const NETWORK = "a".repeat(64);
const OTHER_NETWORK = "b".repeat(64);

describe("banned-owner rule on real Postgres", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    await runPrismaMigrateDeploy(pgContainer.databaseUrl);
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

    const now = new Date();
    const later = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    await prisma.human.createMany({
      data: [
        { id: BANNED, name: "Banned", status: "BANNED" },
        { id: COOWNER, name: "Co-owner", status: "ACTIVE" },
        { id: SIGNUP, name: "New account", status: "ACTIVE" },
      ],
    });
    await prisma.authUser.createMany({
      data: [
        { id: "au-banned", humanId: BANNED, name: "B", email: "b@test.dev" },
        { id: "au-signup", humanId: SIGNUP, name: "S", email: "s@test.dev" },
      ],
    });
    await prisma.organization.createMany({
      data: [
        { id: ORG_BANNED, name: "Banned org", slug: "banned-org" },
        { id: ORG_LIVE, name: "Live org", slug: "live-org" },
      ],
    });
    await prisma.orgMember.createMany({
      data: [
        { orgId: ORG_BANNED, humanId: BANNED, role: "OWNER" },
        { orgId: ORG_LIVE, humanId: BANNED, role: "OWNER" },
        { orgId: ORG_LIVE, humanId: COOWNER, role: "OWNER" },
      ],
    });
    const base = {
      status: "PUBLISHED" as const,
      visibility: "PUBLIC" as const,
      countryCode: "US",
      startsAt: later,
      endsAt: new Date(later.getTime() + 3600 * 1000),
    };
    await prisma.event.createMany({
      data: [
        { ...base, id: EV_BANNED_PERSONAL, title: "bp", humanId: BANNED },
        { ...base, id: EV_BANNED_ORG, title: "bo", orgId: ORG_BANNED },
        { ...base, id: EV_LIVE_ORG, title: "lo", orgId: ORG_LIVE },
        {
          ...base,
          id: EV_COMMUNITY,
          title: "cm",
          stewardship: "COMMUNITY",
          attendanceMode: "RSVP",
        },
        { ...base, id: EV_COOWNER_PERSONAL, title: "cp", humanId: COOWNER },
      ],
    });
    await prisma.networkSighting.createMany({
      data: [
        // The new account, on the banned human's network → flagged.
        {
          authUserId: "au-signup",
          humanId: SIGNUP,
          kind: "SIGN_UP",
          ipHash: "c".repeat(64),
          networkHash: NETWORK,
        },
        // The banned human's own sign-up on that network → never flagged.
        {
          authUserId: "au-banned",
          humanId: BANNED,
          kind: "SIGN_UP",
          ipHash: "d".repeat(64),
          networkHash: NETWORK,
        },
        // The new account on a network whose ban row EXPIRED → no match.
        {
          authUserId: "au-signup",
          humanId: SIGNUP,
          kind: "SIGN_UP",
          ipHash: "e".repeat(64),
          networkHash: OTHER_NETWORK,
        },
      ],
    });
    await prisma.bannedIdentity.createMany({
      data: [
        {
          kind: "NETWORK",
          valueHash: NETWORK,
          sourceHumanId: BANNED,
          expiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
        },
        {
          kind: "NETWORK",
          valueHash: OTHER_NETWORK,
          sourceHumanId: BANNED,
          expiresAt: new Date(now.getTime() - 1000),
        },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  const publicIds = async () => {
    const page = await makeEventsRepo(prisma).listPublishedByCountry({
      countryCode: "US",
      limit: 50,
      offset: 0,
    });
    return page.items.map((e) => e.id).sort();
  };
  const rawIds = async () => {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT e.id FROM "Event" e WHERE ${eventOwnerNotWithheldSubquerySql("e")}
    `);
    return rows.map((r) => r.id).sort();
  };

  it("resolves exactly the banned human and the org whose EVERY owner is banned", async () => {
    await expect(resolveWithheldOwners(prisma)).resolves.toEqual({
      humanIds: [BANNED],
      orgIds: [ORG_BANNED],
    });
  });

  it("the Prisma list filter and the raw SQL agree, and keep NULL-owner rows", async () => {
    const kept = [EV_COMMUNITY, EV_COOWNER_PERSONAL, EV_LIVE_ORG].sort();
    await expect(publicIds()).resolves.toEqual(kept);
    await expect(rawIds()).resolves.toEqual(kept);
  });

  it("the opt-in single-row read derives the same answer", async () => {
    const repo = makeEventsRepo(prisma);
    const standing = async (id: string) =>
      (await repo.getById(id, { withOwnerStanding: true }))?.ownerBanned;
    await expect(standing(EV_BANNED_PERSONAL)).resolves.toBe(true);
    await expect(standing(EV_BANNED_ORG)).resolves.toBe(true);
    await expect(standing(EV_LIVE_ORG)).resolves.toBe(false);
    await expect(standing(EV_COMMUNITY)).resolves.toBe(false);
    // Internal reads skip the owner join entirely.
    expect((await repo.getById(EV_BANNED_ORG))?.ownerBanned).toBeUndefined();
  });

  it("flags only the new account, matched to the banned human, via an unexpired ban", async () => {
    const now = new Date();
    const result = await makeNetworkSightingsRepo(prisma).listFlaggedSignups({
      since: new Date(now.getTime() - 30 * 24 * 3600 * 1000),
      now,
      limit: 50,
      offset: 0,
    });
    expect(result.total).toBe(1);
    expect(result.items).toEqual([
      expect.objectContaining({
        humanId: SIGNUP,
        email: "s@test.dev",
        matches: [
          {
            bannedHumanId: BANNED,
            bannedHumanName: "Banned",
            bannedHumanStatus: "BANNED",
          },
        ],
      }),
    ]);
  });

  it("finds alt accounts by mailbox exactly as core's canonicalEmail does", async () => {
    const emails = [
      "Jane.Doe+x@GoogleMail.com",
      "janedoe@gmail.com",
      "j.a.n.e.d.o.e+promo@gmail.com",
      "jane.doe@example.com",
      "jane.doe+y@example.com",
      "janedoe@example.com",
      "JANE.DOE@Example.com",
    ];
    await prisma.authUser.createMany({
      data: emails.map((email, i) => ({
        id: `au-mailbox-${i}`,
        name: "M",
        email,
      })),
    });
    const repo = makeHumansRepo(prisma);
    for (const email of emails) {
      const canonical = canonicalEmail(email)!;
      const expected = emails
        .map((e, i) => ({ e, id: `au-mailbox-${i}` }))
        .filter(({ e }) => canonicalEmail(e) === canonical)
        .map(({ id }) => id)
        .sort();
      const found = (await repo.listAuthUsersByCanonicalEmail(canonical))
        .map((r) => r.authUserId)
        .filter((id) => id.startsWith("au-mailbox-"))
        .sort();
      expect(found, email).toEqual(expected);
    }
  });

  // Search documents: the read-time predicate public search applies (alias
  // `d`). Human docs key on human_id, organization docs on org_id_ref, event
  // docs on owner_human_id / org_id; other types are never withheld.
  const SEARCH_DOCS = [
    { id: "sd-human-banned", type: "human", title: "h", humanId: BANNED },
    { id: "sd-human-live", type: "human", title: "h", humanId: COOWNER },
    { id: "sd-org-banned", type: "organization", title: "o", orgIdRef: ORG_BANNED },
    { id: "sd-org-live", type: "organization", title: "o", orgIdRef: ORG_LIVE },
    { id: "sd-ev-banned-personal", type: "event", title: "e", eventId: EV_BANNED_PERSONAL, ownerHumanId: BANNED },
    { id: "sd-ev-banned-org", type: "event", title: "e", eventId: EV_BANNED_ORG, orgId: ORG_BANNED },
    { id: "sd-ev-live-org", type: "event", title: "e", eventId: EV_LIVE_ORG, orgId: ORG_LIVE },
    { id: "sd-ev-community", type: "event", title: "e", eventId: EV_COMMUNITY },
    { id: "sd-ev-coowner", type: "event", title: "e", eventId: EV_COOWNER_PERSONAL, ownerHumanId: COOWNER },
    // A place doc that happens to carry a withheld id is not a withheld type.
    { id: "sd-place", type: "place", title: "p", humanId: BANNED, orgId: ORG_BANNED },
  ];
  const searchDocIds = async () => {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT d.id FROM "SearchDocument" d WHERE ${SEARCH_DOC_NOT_WITHHELD_SQL}
    `);
    return rows.map((r) => r.id).sort();
  };

  it("the search-document predicate drops exactly the withheld owners' docs", async () => {
    await prisma.searchDocument.createMany({ data: SEARCH_DOCS });
    await expect(searchDocIds()).resolves.toEqual(
      [
        "sd-human-live",
        "sd-org-live",
        "sd-ev-live-org",
        "sd-ev-community",
        "sd-ev-coowner",
        "sd-place",
      ].sort(),
    );
  });

  it("reactivation brings every event back (nothing was stored or deleted)", async () => {
    await prisma.human.update({
      where: { id: BANNED },
      data: { status: "ACTIVE" },
    });
    await expect(resolveWithheldOwners(prisma)).resolves.toEqual({
      humanIds: [],
      orgIds: [],
    });
    const all = [
      EV_BANNED_ORG,
      EV_BANNED_PERSONAL,
      EV_COMMUNITY,
      EV_COOWNER_PERSONAL,
      EV_LIVE_ORG,
    ].sort();
    await expect(publicIds()).resolves.toEqual(all);
    await expect(rawIds()).resolves.toEqual(all);
    await expect(searchDocIds()).resolves.toEqual(
      SEARCH_DOCS.map((d) => d.id).sort(),
    );
  });
});
