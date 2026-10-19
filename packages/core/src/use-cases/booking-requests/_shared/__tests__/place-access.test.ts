import { describe, expect, it, vi } from "vitest";

import type { OrgMembership } from "@th/ports/repos/authz";
import type { HumanDelegateRecord } from "@th/ports/repos/human-delegates";

import { createFakePlaceBookingGrantsRepo } from "../../../booking-holds/__tests__/fakes";
import {
  findPlaceBookerGrant,
  listPlaceBookerGrants,
  requirePlaceBookerAuthority,
  requirePlaceBookingAuthority,
  requirePlaceOwnership,
  type PlaceBookerAuthorityRepos,
} from "../place-access";

// ─────────────────────────────────────────────────────────────────────────────
// holds-without-a-request FR-002: the grant arm left the staff gate.
//   - `requirePlaceBookingAuthority`: owner / owning-org edit-role member.
//     Never reads grants; a grantee is refused like a stranger.
//   - `requirePlaceBookerAuthority` / `findPlaceBookerGrant`: an ACTIVE grant
//     resolved through its grantee (the person, the person's edit-role
//     delegates, the grantee org's edit-role members). Never staff-by-role.
// ─────────────────────────────────────────────────────────────────────────────

const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_PLACE_ID = "34343434-3434-4343-8343-343434343434";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const GRANTEE_ORG_ID = "23232323-2323-4232-8232-232323232323";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const EDITOR_ID = "12121212-1212-4121-8121-121212121212";
const VIEWER_ID = "13131313-1313-4131-8131-131313131313";
const STRANGER_ID = "14141414-1414-4141-8141-141414141414";
/** A person grantee. */
const BOOKER_ID = "15151515-1515-4151-8151-151515151515";
/** BOOKER's EDITOR delegate. */
const DELEGATE_ID = "16161616-1616-4161-8161-161616161616";
/** BOOKER's VIEWER delegate. */
const VIEWER_DELEGATE_ID = "17171717-1717-4171-8171-171717171717";
/** EDITOR of the grantee org. */
const GRANTEE_ORG_EDITOR_ID = "18181818-1818-4181-8181-181818181818";
/** VIEWER of the grantee org. */
const GRANTEE_ORG_VIEWER_ID = "19191919-1919-4191-8191-191919191919";
const CALENDAR_A = "cacacaca-caca-4cac-8cac-cacacacacaca";
const CALENDAR_B = "cbcbcbcb-cbcb-4cbc-8cbc-cbcbcbcbcbcb";
/** A calendar of OTHER_PLACE_ID. */
const OTHER_PLACE_CALENDAR = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
/**
 * Covered three ways at once: its own person grant, BOOKER's EDITOR
 * delegate, and an EDITOR of the grantee org.
 */
const MULTI_ID = "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a";
/** A grantee org MULTI holds no role in. */
const OUTSIDE_ORG_ID = "24242424-2424-4242-8242-242424242424";
const NOW = new Date("2026-09-02T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function build(
  options: {
    place?: { orgIdsWithAccess?: string[]; humanIdsWithAccess?: string[] };
  } = {},
) {
  const memberships: OrgMembership[] = [
    { orgId: ORG_ID, humanId: EDITOR_ID, role: "EDITOR" },
    { orgId: ORG_ID, humanId: VIEWER_ID, role: "VIEWER" },
    { orgId: GRANTEE_ORG_ID, humanId: GRANTEE_ORG_EDITOR_ID, role: "EDITOR" },
    { orgId: GRANTEE_ORG_ID, humanId: GRANTEE_ORG_VIEWER_ID, role: "VIEWER" },
    { orgId: GRANTEE_ORG_ID, humanId: MULTI_ID, role: "EDITOR" },
  ];
  const delegations: HumanDelegateRecord[] = [
    {
      id: "d1",
      principalId: BOOKER_ID,
      delegateId: DELEGATE_ID,
      role: "EDITOR",
      createdAt: NOW,
    },
    {
      id: "d2",
      principalId: BOOKER_ID,
      delegateId: VIEWER_DELEGATE_ID,
      role: "VIEWER",
      createdAt: NOW,
    },
    {
      id: "d3",
      principalId: BOOKER_ID,
      delegateId: MULTI_ID,
      role: "EDITOR",
      createdAt: NOW,
    },
  ];
  const authz = {
    getOrgMemberships: vi.fn(
      async (input: { orgIds: string[]; humanId: string }) =>
        memberships.filter(
          (m) => m.humanId === input.humanId && input.orgIds.includes(m.orgId),
        ),
    ),
    listOrgMembershipsByHumanId: vi.fn(
      async (input: { humanId: string; roles?: string[] }) =>
        memberships.filter(
          (m) =>
            m.humanId === input.humanId &&
            (!input.roles || input.roles.includes(m.role)),
        ),
    ),
  };
  const humanDelegates = {
    listPrincipalsForDelegate: vi.fn(
      async (input: {
        delegateId: string;
        roles: readonly string[];
        principalIds?: readonly string[];
      }) =>
        delegations
          .filter(
            (d) =>
              d.delegateId === input.delegateId &&
              input.roles.includes(d.role) &&
              (!input.principalIds || input.principalIds.includes(d.principalId)),
          )
          .map((d) => d.principalId)
          .sort(),
    ),
  };
  const calendarPlaces: Record<string, string> = {
    [CALENDAR_A]: PLACE_ID,
    [CALENDAR_B]: PLACE_ID,
    [OTHER_PLACE_CALENDAR]: OTHER_PLACE_ID,
  };
  const calendars = {
    findById: vi.fn(async (id: string) =>
      calendarPlaces[id] ? { id, placeId: calendarPlaces[id] } : null,
    ),
  };
  const placeBookingGrants = createFakePlaceBookingGrantsRepo();
  const place = {
    id: PLACE_ID,
    orgIdsWithAccess: options.place?.orgIdsWithAccess ?? [ORG_ID],
    humanIdsWithAccess: options.place?.humanIdsWithAccess ?? [OWNER_ID],
  };
  const repos = {
    authz,
    humanDelegates,
    placeBookingGrants,
    calendars: calendars as unknown as PlaceBookerAuthorityRepos["calendars"],
  };
  const staff = (actorHumanId: string) =>
    requirePlaceBookingAuthority(repos, place, actorHumanId);
  const booker = (
    actorHumanId: string,
    opts: Partial<Parameters<typeof requirePlaceBookerAuthority>[3]> = {},
  ) =>
    requirePlaceBookerAuthority(repos, place, actorHumanId, {
      now: NOW,
      ...opts,
    });
  return {
    repos,
    place,
    authz,
    humanDelegates,
    calendars,
    placeBookingGrants,
    staff,
    booker,
  };
}

describe("requirePlaceBookingAuthority — the STAFF gate (no grant arm)", () => {
  it("a direct human owner passes via human, never role-gated", async () => {
    const { staff, authz } = build();
    await expect(staff(OWNER_ID)).resolves.toEqual({
      via: "human",
      orgId: null,
      orgRole: null,
    });
    expect(authz.getOrgMemberships).not.toHaveBeenCalled();
  });

  it("an owning-org EDITOR passes via org", async () => {
    const { staff } = build();
    await expect(staff(EDITOR_ID)).resolves.toEqual({
      via: "org",
      orgId: ORG_ID,
      orgRole: "EDITOR",
    });
  });

  it("an owning-org VIEWER is INSUFFICIENT_ROLE", async () => {
    const { staff } = build();
    await expect(staff(VIEWER_ID)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
  });

  it("a stranger is NOT_RESOURCE_OWNER", async () => {
    const { staff } = build();
    await expect(staff(STRANGER_ID)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
      meta: { entity: "place" },
    });
  });

  it("REFUSES every kind of grantee and never reads grants (was: passed via grant)", async () => {
    const { staff, placeBookingGrants } = build();
    placeBookingGrants.seed({ placeId: PLACE_ID, humanId: BOOKER_ID });
    placeBookingGrants.seed({
      placeId: PLACE_ID,
      grantee: { kind: "org", orgId: GRANTEE_ORG_ID },
    });
    for (const actor of [BOOKER_ID, DELEGATE_ID, GRANTEE_ORG_EDITOR_ID]) {
      await expect(staff(actor)).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
      });
    }
    expect(placeBookingGrants.findActiveForActor).not.toHaveBeenCalled();
    expect(placeBookingGrants.listActiveForActor).not.toHaveBeenCalled();
    expect(placeBookingGrants.listForPlace).not.toHaveBeenCalled();
  });

  it("an owning-org VIEWER holding a grant is NOT rescued by it (was: grant beat the role denial)", async () => {
    const { staff, placeBookingGrants } = build();
    placeBookingGrants.seed({ placeId: PLACE_ID, humanId: VIEWER_ID });
    await expect(staff(VIEWER_ID)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
  });
});

describe("requirePlaceBookerAuthority — the BOOKER gate", () => {
  it("the person grantee passes, returning the grant and the person as holder", async () => {
    const { booker, placeBookingGrants } = build();
    const grant = placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: BOOKER_ID,
    });
    await expect(booker(BOOKER_ID)).resolves.toEqual({
      via: "grant",
      grant,
      holder: { kind: "person", humanId: BOOKER_ID },
    });
  });

  it("the person's EDITOR delegate passes as the person", async () => {
    const { booker, placeBookingGrants } = build();
    const grant = placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: BOOKER_ID,
    });
    await expect(booker(DELEGATE_ID)).resolves.toMatchObject({
      grant: { id: grant.id },
      holder: { kind: "person", humanId: BOOKER_ID },
    });
  });

  it("the person's VIEWER delegate is refused (delegates need an edit role)", async () => {
    const { booker, placeBookingGrants } = build();
    placeBookingGrants.seed({ placeId: PLACE_ID, humanId: BOOKER_ID });
    await expect(booker(VIEWER_DELEGATE_ID)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
  });

  it("an EDITOR of a grantee org passes as the org", async () => {
    const { booker, placeBookingGrants } = build();
    const grant = placeBookingGrants.seed({
      placeId: PLACE_ID,
      grantee: { kind: "org", orgId: GRANTEE_ORG_ID },
    });
    await expect(booker(GRANTEE_ORG_EDITOR_ID)).resolves.toMatchObject({
      grant: { id: grant.id },
      holder: { kind: "org", orgId: GRANTEE_ORG_ID },
    });
  });

  it("a VIEWER of a grantee org is refused (org members need an edit role)", async () => {
    const { booker, placeBookingGrants } = build();
    placeBookingGrants.seed({
      placeId: PLACE_ID,
      grantee: { kind: "org", orgId: GRANTEE_ORG_ID },
    });
    await expect(booker(GRANTEE_ORG_VIEWER_ID)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
  });

  it("a PENDING grant authorizes nothing", async () => {
    const { booker, placeBookingGrants } = build();
    placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: BOOKER_ID,
      acceptedAt: null,
    });
    await expect(booker(BOOKER_ID)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
  });

  it("a DECLINED grant authorizes nothing", async () => {
    const { booker, placeBookingGrants } = build();
    placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: BOOKER_ID,
      acceptedAt: null,
      declinedAt: new Date(NOW.getTime() - DAY_MS),
    });
    await expect(booker(BOOKER_ID)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
  });

  it("a REVOKED grant authorizes nothing", async () => {
    const { booker, placeBookingGrants } = build();
    placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: BOOKER_ID,
      revokedAt: new Date(NOW.getTime() - DAY_MS),
    });
    await expect(booker(BOOKER_ID)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
  });

  it("an EXPIRED grant authorizes nothing; judged at the caller's `now`", async () => {
    const { booker, placeBookingGrants } = build();
    placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: BOOKER_ID,
      expiresAt: new Date(NOW.getTime() - 1),
    });
    await expect(booker(BOOKER_ID)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
    await expect(
      booker(BOOKER_ID, { now: new Date(NOW.getTime() - DAY_MS) }),
    ).resolves.toMatchObject({ via: "grant" });
  });

  it("a calendar-scoped grant covers only its calendar (not another, not a place-level action)", async () => {
    const { booker, placeBookingGrants } = build();
    placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: BOOKER_ID,
      calendarId: CALENDAR_A,
    });
    await expect(
      booker(BOOKER_ID, { calendarId: CALENDAR_A }),
    ).resolves.toMatchObject({ via: "grant" });
    await expect(
      booker(BOOKER_ID, { calendarId: CALENDAR_B }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(booker(BOOKER_ID, { calendarId: null })).rejects.toMatchObject(
      { code: "NOT_RESOURCE_OWNER" },
    );
  });

  it("a whole-place grant covers every calendar", async () => {
    const { booker, placeBookingGrants } = build();
    placeBookingGrants.seed({ placeId: PLACE_ID, humanId: BOOKER_ID });
    await expect(
      booker(BOOKER_ID, { calendarId: CALENDAR_B }),
    ).resolves.toMatchObject({ via: "grant" });
  });

  it("a grant on ANOTHER place never authorizes this one (nor does its delegate)", async () => {
    const { booker, placeBookingGrants } = build();
    placeBookingGrants.seed({ placeId: OTHER_PLACE_ID, humanId: BOOKER_ID });
    placeBookingGrants.seed({
      placeId: OTHER_PLACE_ID,
      grantee: { kind: "org", orgId: GRANTEE_ORG_ID },
    });
    for (const actor of [BOOKER_ID, DELEGATE_ID, GRANTEE_ORG_EDITOR_ID]) {
      await expect(booker(actor)).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
      });
    }
  });

  it("staff do NOT pass by being staff: the owner and an owning-org EDITOR with no grant are refused", async () => {
    const { booker } = build();
    for (const actor of [OWNER_ID, EDITOR_ID]) {
      await expect(booker(actor)).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
      });
    }
  });

  it("a stranger with no delegation is never matched to a person grant", async () => {
    const { booker, placeBookingGrants, humanDelegates } = build();
    placeBookingGrants.seed({ placeId: PLACE_ID, humanId: BOOKER_ID });
    await expect(booker(STRANGER_ID)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
    // One reverse read for the actor's principals; the place's grants are
    // never scanned to find candidates.
    expect(humanDelegates.listPrincipalsForDelegate).toHaveBeenCalledTimes(1);
    expect(humanDelegates.listPrincipalsForDelegate).toHaveBeenCalledWith({
      delegateId: STRANGER_ID,
      roles: ["OWNER", "ADMIN", "EDITOR"],
    });
    expect(placeBookingGrants.listForPlace).not.toHaveBeenCalled();
  });

  it.each([
    ["PENDING", { acceptedAt: null }],
    ["REVOKED", { revokedAt: new Date(NOW.getTime() - DAY_MS) }],
    ["EXPIRED", { expiresAt: new Date(NOW.getTime() - 1) }],
  ] as const)(
    "the EDITOR delegate gets nothing from the principal's %s grant",
    async (_label, state) => {
      const { booker, placeBookingGrants } = build();
      placeBookingGrants.seed({ placeId: PLACE_ID, humanId: BOOKER_ID, ...state });
      await expect(booker(DELEGATE_ID)).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
      });
      await expect(
        booker(DELEGATE_ID, { as: { kind: "person", humanId: BOOKER_ID } }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    },
  );

  it("the EDITOR delegate gets the principal's calendar-scoped grant only on that calendar", async () => {
    const { booker, placeBookingGrants } = build();
    placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: BOOKER_ID,
      calendarId: CALENDAR_A,
    });
    await expect(
      booker(DELEGATE_ID, { calendarId: CALENDAR_A }),
    ).resolves.toMatchObject({ holder: { kind: "person", humanId: BOOKER_ID } });
    await expect(
      booker(DELEGATE_ID, { calendarId: CALENDAR_B }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(booker(DELEGATE_ID)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
  });

  it("delegation runs one way: the PRINCIPAL gets nothing from its delegate's grant", async () => {
    // BOOKER made DELEGATE its delegate; a grant to DELEGATE is DELEGATE's.
    const { booker, placeBookingGrants } = build();
    placeBookingGrants.seed({ placeId: PLACE_ID, humanId: DELEGATE_ID });
    await expect(booker(BOOKER_ID)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
    await expect(
      booker(BOOKER_ID, { as: { kind: "person", humanId: DELEGATE_ID } }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    // The delegate itself still passes on its own grant.
    await expect(booker(DELEGATE_ID)).resolves.toMatchObject({
      holder: { kind: "person", humanId: DELEGATE_ID },
    });
  });

  it("a calendar of ANOTHER place matches nothing, even under a whole-place grant, and reads no grants", async () => {
    const { booker, repos, place, placeBookingGrants } = build();
    placeBookingGrants.seed({ placeId: PLACE_ID, humanId: BOOKER_ID });
    await expect(
      booker(BOOKER_ID, { calendarId: OTHER_PLACE_CALENDAR }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(
      listPlaceBookerGrants(repos, place, BOOKER_ID, {
        calendarId: OTHER_PLACE_CALENDAR,
        now: NOW,
      }),
    ).resolves.toEqual([]);
    // An unknown calendar id reads the same.
    await expect(
      booker(BOOKER_ID, { calendarId: "cececece-cece-4cec-8cec-cececececece" }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(placeBookingGrants.findActiveForActor).not.toHaveBeenCalled();
    expect(placeBookingGrants.listActiveForActor).not.toHaveBeenCalled();
    // The place's own calendar still resolves.
    await expect(
      booker(BOOKER_ID, { calendarId: CALENDAR_A }),
    ).resolves.toMatchObject({ via: "grant" });
  });

  it("findPlaceBookerGrant returns null instead of throwing", async () => {
    const { repos, place } = build();
    await expect(
      findPlaceBookerGrant(repos, place, BOOKER_ID, { now: NOW }),
    ).resolves.toBeNull();
  });
});

describe("the booker gate for an actor covered by several grants (`as`, listPlaceBookerGrants)", () => {
  /** MULTI's own grant, BOOKER's (MULTI is its EDITOR delegate), GRANTEE_ORG's (MULTI is its EDITOR). */
  function seedMulti(placeBookingGrants: ReturnType<typeof build>["placeBookingGrants"]) {
    const org = placeBookingGrants.seed({
      placeId: PLACE_ID,
      grantee: { kind: "org", orgId: GRANTEE_ORG_ID },
      createdAt: new Date(NOW.getTime() - 3 * DAY_MS),
    });
    const principal = placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: BOOKER_ID,
      createdAt: new Date(NOW.getTime() - 2 * DAY_MS),
    });
    const own = placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: MULTI_ID,
      createdAt: new Date(NOW.getTime() - DAY_MS),
    });
    // Grants MULTI cannot act under.
    placeBookingGrants.seed({
      placeId: PLACE_ID,
      grantee: { kind: "org", orgId: OUTSIDE_ORG_ID },
    });
    placeBookingGrants.seed({ placeId: PLACE_ID, humanId: STRANGER_ID });
    return { org, principal, own };
  }

  it("each `as` resolves to that party's own grant", async () => {
    const { booker, placeBookingGrants } = build();
    const { org, principal, own } = seedMulti(placeBookingGrants);
    await expect(
      booker(MULTI_ID, { as: { kind: "person", humanId: MULTI_ID } }),
    ).resolves.toEqual({
      via: "grant",
      grant: own,
      holder: { kind: "person", humanId: MULTI_ID },
    });
    await expect(
      booker(MULTI_ID, { as: { kind: "person", humanId: BOOKER_ID } }),
    ).resolves.toEqual({
      via: "grant",
      grant: principal,
      holder: { kind: "person", humanId: BOOKER_ID },
    });
    await expect(
      booker(MULTI_ID, { as: { kind: "org", orgId: GRANTEE_ORG_ID } }),
    ).resolves.toEqual({
      via: "grant",
      grant: org,
      holder: { kind: "org", orgId: GRANTEE_ORG_ID },
    });
  });

  it("an `as` the actor cannot act for is refused, though that party holds an active grant", async () => {
    const { booker, repos, place, placeBookingGrants } = build();
    seedMulti(placeBookingGrants);
    for (const as of [
      { kind: "org", orgId: OUTSIDE_ORG_ID },
      { kind: "person", humanId: STRANGER_ID },
    ] as const) {
      await expect(booker(MULTI_ID, { as })).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
      });
      await expect(
        listPlaceBookerGrants(repos, place, MULTI_ID, { as, now: NOW }),
      ).resolves.toEqual([]);
    }
  });

  it("an `as` org where the actor is only a VIEWER, or a principal who made it a VIEWER delegate, is refused", async () => {
    const { booker, placeBookingGrants } = build();
    placeBookingGrants.seed({
      placeId: PLACE_ID,
      grantee: { kind: "org", orgId: GRANTEE_ORG_ID },
    });
    placeBookingGrants.seed({ placeId: PLACE_ID, humanId: BOOKER_ID });
    await expect(
      booker(GRANTEE_ORG_VIEWER_ID, { as: { kind: "org", orgId: GRANTEE_ORG_ID } }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(
      booker(VIEWER_DELEGATE_ID, { as: { kind: "person", humanId: BOOKER_ID } }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("an `as` whose party has no grant here is refused even when the actor has one of its own", async () => {
    const { booker, placeBookingGrants } = build();
    placeBookingGrants.seed({ placeId: PLACE_ID, humanId: MULTI_ID });
    await expect(
      booker(MULTI_ID, { as: { kind: "org", orgId: GRANTEE_ORG_ID } }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("listPlaceBookerGrants returns every covering grant, whole-place then oldest, and nothing it cannot act under", async () => {
    const { repos, place, placeBookingGrants } = build();
    const { org, principal, own } = seedMulti(placeBookingGrants);
    const calendarGrant = placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: MULTI_ID,
      calendarId: CALENDAR_A,
      createdAt: new Date(NOW.getTime() - 9 * DAY_MS),
    });
    const placeLevel = await listPlaceBookerGrants(repos, place, MULTI_ID, {
      now: NOW,
    });
    expect(placeLevel.map((r) => r.grant.id)).toEqual([
      org.id,
      principal.id,
      own.id,
    ]);
    expect(placeLevel.map((r) => r.holder)).toEqual([
      { kind: "org", orgId: GRANTEE_ORG_ID },
      { kind: "person", humanId: BOOKER_ID },
      { kind: "person", humanId: MULTI_ID },
    ]);
    const onCalendar = await listPlaceBookerGrants(repos, place, MULTI_ID, {
      calendarId: CALENDAR_A,
      now: NOW,
    });
    expect(onCalendar.map((r) => r.grant.id)).toEqual([
      org.id,
      principal.id,
      own.id,
      calendarGrant.id,
    ]);
    // `as` narrows the list to that party's grants.
    const ownOnly = await listPlaceBookerGrants(repos, place, MULTI_ID, {
      as: { kind: "person", humanId: MULTI_ID },
      calendarId: CALENDAR_A,
      now: NOW,
    });
    expect(ownOnly.map((r) => r.grant.id)).toEqual([own.id, calendarGrant.id]);
  });

  it("without `as`, findPlaceBookerGrant answers with the list's first entry", async () => {
    const { repos, place, placeBookingGrants } = build();
    const { org } = seedMulti(placeBookingGrants);
    await expect(
      findPlaceBookerGrant(repos, place, MULTI_ID, { now: NOW }),
    ).resolves.toMatchObject({ grant: { id: org.id } });
  });
});

describe("requirePlaceOwnership (unchanged — staff only)", () => {
  it("NEVER consults grants: a grantee is still NOT_RESOURCE_OWNER", async () => {
    const { repos, place, placeBookingGrants } = build();
    placeBookingGrants.seed({ placeId: PLACE_ID, humanId: STRANGER_ID });
    await expect(
      requirePlaceOwnership(repos, place, STRANGER_ID),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(placeBookingGrants.findActiveForActor).not.toHaveBeenCalled();
  });

  it("keeps its shape: human owner, org member (any role when unconstrained), INSUFFICIENT_ROLE when constrained", async () => {
    const { repos, place } = build();
    await expect(requirePlaceOwnership(repos, place, OWNER_ID)).resolves.toEqual(
      { via: "human", orgId: null, orgRole: null },
    );
    await expect(
      requirePlaceOwnership(repos, place, VIEWER_ID),
    ).resolves.toEqual({ via: "org", orgId: ORG_ID, orgRole: "VIEWER" });
    await expect(
      requirePlaceOwnership(repos, place, VIEWER_ID, {
        requiredOrgRoles: ["OWNER", "ADMIN", "EDITOR"],
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});
