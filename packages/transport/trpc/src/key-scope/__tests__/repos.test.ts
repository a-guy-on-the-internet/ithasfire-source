import { describe, expect, it, vi } from "vitest";
import type { ApiKeyScope } from "@th/ports/authn";
import type { Repos } from "@th/ports/repos";

import {
  listPlaceBookerGrants,
  requirePlaceBookerAuthority,
  requirePlaceBookingAuthority,
} from "@th/core/use-cases/booking-requests/_shared/place-access";
import { resolveAskOwnership } from "@th/core/use-cases/volunteering/_shared/resolve-ask-ownership";

import { scopeReposToKey } from "../repos";

const HOLDER = "11111111-1111-4111-8111-111111111111";
const KEY_ORG = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";

type Scoped = Extract<ApiKeyScope, { kind: "scoped" }>;
const key = (subject: Scoped["subject"]): Scoped => ({
  kind: "scoped",
  keyId: "k",
  requestId: "r",
  subject,
  access: "READ",
  orgId: subject === "ORG" ? KEY_ORG : null,
});

const membership = (orgId: string) => ({ orgId, humanId: HOLDER, role: "OWNER" });

/** The real repo: the holder is OWNER of both orgs and a platform ADMIN. */
const authzRepo = () => ({
  getOrgMembership: vi.fn(async (i: { orgId: string }) => membership(i.orgId)),
  getOrgMemberships: vi.fn(async (i: { orgIds: string[] }) =>
    i.orgIds.map(membership),
  ),
  listOrgMembershipsByHumanId: vi.fn(async () => [
    membership(KEY_ORG),
    membership(OTHER_ORG),
  ]),
  getStaffRolesForHumanId: vi.fn(async () => ["ADMIN"]),
  getHumanDelegation: vi.fn(async () => membership(OTHER_ORG)),
  listHumanIdsByStaffRole: vi.fn(async () => [HOLDER]),
  getEventOrgId: vi.fn(async () => OTHER_ORG),
});

const makeRepos = () => {
  const outer = authzRepo();
  const inner = authzRepo();
  const events = { getById: vi.fn() };
  const tx = vi.fn(async (fn: (tx: unknown) => unknown, _options?: unknown) =>
    fn({ authz: inner, events }),
  );
  const repos = { authz: outer, events, tx } as unknown as Repos;
  return { repos, outer, inner, events, tx };
};

describe("scopeReposToKey", () => {
  it("ORG: memberships only in the key's org, outside and inside a tx", async () => {
    const { repos, outer, inner, tx } = makeRepos();
    const scoped = scopeReposToKey(repos, key("ORG"));

    for (const authz of [
      scoped.authz,
      await scoped.tx(async (t) => t.authz, { timeout: 5 }),
    ]) {
      expect(await authz.getOrgMembership({ orgId: KEY_ORG, humanId: HOLDER })).toEqual(
        membership(KEY_ORG),
      );
      expect(
        await authz.getOrgMembership({ orgId: OTHER_ORG, humanId: HOLDER }),
      ).toBeNull();
      expect(
        await authz.getOrgMemberships({ orgIds: [KEY_ORG, OTHER_ORG], humanId: HOLDER }),
      ).toEqual([membership(KEY_ORG)]);
      expect(
        await authz.getOrgMemberships({ orgIds: [OTHER_ORG], humanId: HOLDER }),
      ).toEqual([]);
      expect(await authz.listOrgMembershipsByHumanId({ humanId: HOLDER })).toEqual([
        membership(KEY_ORG),
      ]);
      expect(await authz.getStaffRolesForHumanId(HOLDER)).toEqual([]);
      expect(
        await authz.getHumanDelegation({ principalId: OTHER_ORG, delegateId: HOLDER }),
      ).toBeNull();
    }
    // The other org was never even asked about.
    for (const r of [outer, inner]) {
      expect(r.getOrgMembership).not.toHaveBeenCalledWith(
        expect.objectContaining({ orgId: OTHER_ORG }),
      );
      expect(r.getOrgMemberships).toHaveBeenCalledWith({
        orgIds: [KEY_ORG],
        humanId: HOLDER,
      });
    }
    // tx options pass through untouched.
    expect(tx).toHaveBeenCalledWith(expect.any(Function), { timeout: 5 });
  });

  it.each(["PERSONAL", "STAFF", "PLATFORM_WIDE"] as const)(
    "%s: no org membership anywhere",
    async (subject) => {
      const { repos } = makeRepos();
      const scoped = scopeReposToKey(repos, key(subject));
      const authz = await scoped.tx(async (t) => t.authz);
      for (const a of [scoped.authz, authz]) {
        expect(await a.getOrgMembership({ orgId: KEY_ORG, humanId: HOLDER })).toBeNull();
        expect(
          await a.getOrgMemberships({ orgIds: [KEY_ORG], humanId: HOLDER }),
        ).toEqual([]);
        expect(await a.listOrgMembershipsByHumanId({ humanId: HOLDER })).toEqual([]);
      }
    },
  );

  it("staff roles only under a STAFF key", async () => {
    for (const subject of ["ORG", "PERSONAL", "PLATFORM_WIDE"] as const) {
      const scoped = scopeReposToKey(makeRepos().repos, key(subject));
      expect(await scoped.authz.getStaffRolesForHumanId(HOLDER)).toEqual([]);
    }
    const staff = scopeReposToKey(makeRepos().repos, key("STAFF"));
    expect(await staff.authz.getStaffRolesForHumanId(HOLDER)).toEqual(["ADMIN"]);
    expect(
      await (await staff.tx(async (t) => t.authz)).getStaffRolesForHumanId(HOLDER),
    ).toEqual(["ADMIN"]);
  });

  it("leaves fan-out, resource lookups and other repos alone", async () => {
    const { repos, events } = makeRepos();
    const scoped = scopeReposToKey(repos, key("PERSONAL"));
    expect(await scoped.authz.listHumanIdsByStaffRole("ADMIN")).toEqual([HOLDER]);
    expect(await scoped.authz.getEventOrgId("e")).toBe(OTHER_ORG);
    expect(scoped.events).toBe(events);
    expect(await scoped.tx(async (t) => t.events)).toBe(events);
  });
});

// Authority outside repos.authz that belongs to a person: a delegation from
// another human, and a place booking grant. Driven through the REAL core
// readers, outside and inside a tx.
describe("scopeReposToKey: delegations and place booking grants", () => {
  const PRINCIPAL = "44444444-4444-4444-8444-444444444444";
  const PLACE = "55555555-5555-4555-8555-555555555555";
  const NOW = new Date("2026-10-13T12:00:00Z");
  const place = {
    id: PLACE,
    humanIdsWithAccess: [] as string[],
    orgIdsWithAccess: [OTHER_ORG],
  };

  const holderGrant = {
    id: "grant-1",
    placeId: PLACE,
    grantee: { kind: "person" as const, humanId: HOLDER },
  };
  const principalGrant = {
    id: "grant-principal",
    placeId: PLACE,
    grantee: { kind: "person" as const, humanId: PRINCIPAL },
  };

  /** The holder is an ADMIN delegate of PRINCIPAL and holds a grant at PLACE. */
  const personalRepos = () => {
    const parts = () => ({
      // Not a member of the place's org: only the grant can authorise.
      authz: { ...authzRepo(), getOrgMemberships: vi.fn(async () => []) },
      humanDelegates: {
        getDelegation: vi.fn(async () => ({
          principalId: PRINCIPAL,
          delegateId: HOLDER,
          role: "ADMIN",
        })),
        // The booker gate's reverse read: HOLDER is PRINCIPAL's delegate.
        listPrincipalsForDelegate: vi.fn(async () => [PRINCIPAL]),
        listDelegates: vi.fn(async () => ({ items: [], total: 0 })),
      },
      placeBookingGrants: {
        // HOLDER's own grant, plus PRINCIPAL's (reachable only through the
        // delegation).
        findActiveForActor: vi.fn(
          async (input: { humanIds: readonly string[] }) =>
            [holderGrant, principalGrant].find((g) =>
              input.humanIds.includes(g.grantee.humanId),
            ) ?? null,
        ),
        listActiveForActor: vi.fn(
          async (input: { humanIds: readonly string[] }) =>
            [holderGrant, principalGrant].filter((g) =>
              input.humanIds.includes(g.grantee.humanId),
            ),
        ),
        listForPlace: vi.fn(async () => []),
      },
      calendars: { findById: vi.fn(async () => null) },
    });
    const outer = parts();
    const inner = parts();
    const tx = vi.fn(async (fn: (tx: unknown) => unknown) => fn(inner));
    return { repos: { ...outer, tx } as unknown as Repos, outer, inner };
  };

  const askAsDelegate = (r: Pick<Repos, "humanDelegates" | "authz">) =>
    resolveAskOwnership(
      r as never,
      { subjectType: "HUMAN", subjectId: PRINCIPAL, orgId: null },
      HOLDER,
    );
  // The BOOKER gate (holds-without-a-request FR-002): the only gate a grant
  // authorises. The staff gate never reads grants.
  type BookerRepos = Pick<
    Repos,
    "placeBookingGrants" | "authz" | "humanDelegates" | "calendars"
  >;
  const bookAtPlace = (r: BookerRepos) =>
    requirePlaceBookerAuthority(r, place, HOLDER, { now: NOW });
  /** Every grant HOLDER can act under at PLACE, by grant id. */
  const bookerGrantIds = async (r: BookerRepos) =>
    (await listPlaceBookerGrants(r, place, HOLDER, { now: NOW })).map(
      (g) => g.grant.id,
    );
  /** HOLDER acting for PRINCIPAL: only the delegation reaches that grant. */
  const bookAsPrincipal = (r: BookerRepos) =>
    requirePlaceBookerAuthority(r, place, HOLDER, {
      now: NOW,
      as: { kind: "person", humanId: PRINCIPAL },
    });

  it("without a key, the delegation and the grant authorise (the fixture is live)", async () => {
    const { repos } = personalRepos();
    await expect(askAsDelegate(repos)).resolves.toMatchObject({ event: null });
    await expect(bookAtPlace(repos)).resolves.toMatchObject({
      via: "grant",
      grant: { id: "grant-1" },
    });
    await expect(bookAsPrincipal(repos)).resolves.toMatchObject({
      grant: { id: "grant-principal" },
      holder: { kind: "person", humanId: PRINCIPAL },
    });
    await expect(bookerGrantIds(repos)).resolves.toEqual([
      "grant-1",
      "grant-principal",
    ]);
  });

  it("the grant never makes the holder STAFF: requirePlaceBookingAuthority refuses even without a key", async () => {
    const { repos, outer } = personalRepos();
    await expect(
      requirePlaceBookingAuthority(repos, place, HOLDER),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(outer.placeBookingGrants.findActiveForActor).not.toHaveBeenCalled();
  });

  it.each(["ORG", "STAFF", "PLATFORM_WIDE"] as const)(
    "%s key: resolveAskOwnership and requirePlaceBookerAuthority refuse, in and out of a tx",
    async (subject) => {
      const { repos, outer, inner } = personalRepos();
      const scoped = scopeReposToKey(repos, key(subject));
      await expect(askAsDelegate(scoped)).rejects.toMatchObject({
        code: "INSUFFICIENT_ROLE",
      });
      await expect(bookAtPlace(scoped)).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
      });
      await scoped.tx(async (t) => {
        await expect(askAsDelegate(t)).rejects.toMatchObject({
          code: "INSUFFICIENT_ROLE",
        });
        await expect(bookAtPlace(t)).rejects.toMatchObject({
          code: "NOT_RESOURCE_OWNER",
        });
      });
      await expect(bookAsPrincipal(scoped)).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
      });
      await expect(bookerGrantIds(scoped)).resolves.toEqual([]);
      // Refused without asking the real repos.
      for (const r of [outer, inner]) {
        expect(r.humanDelegates.getDelegation).not.toHaveBeenCalled();
        expect(r.humanDelegates.listPrincipalsForDelegate).not.toHaveBeenCalled();
        expect(r.placeBookingGrants.findActiveForActor).not.toHaveBeenCalled();
        expect(r.placeBookingGrants.listActiveForActor).not.toHaveBeenCalled();
      }
    },
  );

  it("PERSONAL key: the grant still authorises; a delegation never does", async () => {
    const { repos } = personalRepos();
    const scoped = scopeReposToKey(repos, key("PERSONAL"));
    await expect(bookAtPlace(scoped)).resolves.toMatchObject({
      grant: { id: "grant-1" },
    });
    await expect(scoped.tx((t) => bookAtPlace(t))).resolves.toMatchObject({
      grant: { id: "grant-1" },
    });
    await expect(askAsDelegate(scoped)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
    // The delegation's reverse read is [] under every key, so the holder
    // never reaches PRINCIPAL's grant, with `as` or in the list.
    await expect(bookAsPrincipal(scoped)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
    await expect(bookerGrantIds(scoped)).resolves.toEqual(["grant-1"]);
    await expect(
      scoped.tx((t) => bookerGrantIds(t)),
    ).resolves.toEqual(["grant-1"]);
  });

  it.each(["ORG", "STAFF", "PLATFORM_WIDE", "PERSONAL"] as const)(
    "%s key: listPrincipalsForDelegate is [] without asking the real repo, in and out of a tx",
    async (subject) => {
      const { repos, outer, inner } = personalRepos();
      const scoped = scopeReposToKey(repos, key(subject));
      const read = (r: Pick<Repos, "humanDelegates">) =>
        r.humanDelegates.listPrincipalsForDelegate({
          delegateId: HOLDER,
          roles: ["ADMIN"],
        });
      await expect(read(scoped)).resolves.toEqual([]);
      await scoped.tx(async (t) => {
        await expect(read(t)).resolves.toEqual([]);
      });
      for (const r of [outer, inner]) {
        expect(r.humanDelegates.listPrincipalsForDelegate).not.toHaveBeenCalled();
      }
    },
  );

  // holds-without-a-request step 4: an ORG key does not act under its org's
  // grant either; only a PERSONAL key reaches the real lookup.
  const findForActor = (r: Pick<Repos, "placeBookingGrants">) =>
    r.placeBookingGrants.findActiveForActor({
      placeId: "place-1",
      humanIds: [HOLDER],
      orgIds: [],
      now: NOW,
    });

  it.each(["ORG", "STAFF", "PLATFORM_WIDE"] as const)(
    "%s key: findActiveForActor finds no grant, in and out of a tx",
    async (subject) => {
      const { repos, outer, inner } = personalRepos();
      const scoped = scopeReposToKey(repos, key(subject));
      await expect(findForActor(scoped)).resolves.toBeNull();
      await scoped.tx(async (t) => {
        await expect(findForActor(t)).resolves.toBeNull();
      });
      for (const r of [outer, inner]) {
        expect(r.placeBookingGrants.findActiveForActor).not.toHaveBeenCalled();
      }
    },
  );

  const listForActor = (r: Pick<Repos, "placeBookingGrants">) =>
    r.placeBookingGrants.listActiveForActor({
      placeId: PLACE,
      humanIds: [HOLDER],
      orgIds: [],
      now: NOW,
    });

  it.each(["ORG", "STAFF", "PLATFORM_WIDE"] as const)(
    "%s key: listActiveForActor finds no grant, in and out of a tx",
    async (subject) => {
      const { repos, outer, inner } = personalRepos();
      const scoped = scopeReposToKey(repos, key(subject));
      await expect(listForActor(scoped)).resolves.toEqual([]);
      await scoped.tx(async (t) => {
        await expect(listForActor(t)).resolves.toEqual([]);
      });
      for (const r of [outer, inner]) {
        expect(r.placeBookingGrants.listActiveForActor).not.toHaveBeenCalled();
      }
    },
  );

  it("PERSONAL key: listActiveForActor passes through", async () => {
    const { repos } = personalRepos();
    const scoped = scopeReposToKey(repos, key("PERSONAL"));
    await expect(listForActor(scoped)).resolves.toMatchObject([{ id: "grant-1" }]);
  });

  it("PERSONAL key: findActiveForActor passes through", async () => {
    const { repos } = personalRepos();
    const scoped = scopeReposToKey(repos, key("PERSONAL"));
    await expect(findForActor(scoped)).resolves.toMatchObject({ id: "grant-1" });
  });

  it("leaves the delegate list (no authority) alone", async () => {
    const { repos } = personalRepos();
    const scoped = scopeReposToKey(repos, key("ORG"));
    expect(
      await scoped.humanDelegates.listDelegates({ principalId: PRINCIPAL } as never),
    ).toEqual({ items: [], total: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// holds-without-a-request step 5 (carried item j): the grant LIFECYCLE is
// session-only under every key subject, PERSONAL included. Reads see no
// grant; writes are refused with the gate's FORBIDDEN shape; the real repo
// is never asked.
// ─────────────────────────────────────────────────────────────────────────────

describe("scopeReposToKey: the booking grant lifecycle is session-only", () => {
  const GRANT = "44444444-4444-4444-8444-444444444444";
  const NOW_AT = new Date("2026-10-16T00:00:00.000Z");
  const grantRow = {
    id: GRANT,
    placeId: "55555555-5555-4555-8555-555555555555",
    calendarId: null,
    grantee: { kind: "person" as const, humanId: HOLDER },
    grantedByHumanId: OTHER_ORG,
    expiresAt: null,
    revokedAt: null,
    acceptedAt: null,
    declinedAt: null,
    expiryWarnedAt: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
  };
  const lifecycleRepos = () => {
    const parts = () => ({
      authz: {
        listOrgMembershipsByHumanId: vi.fn(async () => []),
        getOrgMemberships: vi.fn(async () => []),
      },
      humanDelegates: { listPrincipalsForDelegate: vi.fn(async () => []) },
      audit: { log: vi.fn(async () => {}) },
      placeBookingGrants: {
        getForPlace: vi.fn(async () => grantRow),
        getForGrantee: vi.fn(async () => grantRow),
        listForPlace: vi.fn(async () => [grantRow]),
        listForGrantee: vi.fn(async () => [grantRow]),
        create: vi.fn(async () => grantRow),
        accept: vi.fn(async () => ({ ...grantRow, acceptedAt: NOW_AT })),
        decline: vi.fn(async () => grantRow),
        update: vi.fn(async () => grantRow),
        revoke: vi.fn(async () => grantRow),
        listExpiring: vi.fn(async () => [grantRow]),
        markExpiryWarned: vi.fn(async () => true),
      },
    });
    const outer = parts();
    const inner = parts();
    const tx = vi.fn(async (fn: (tx: unknown) => unknown) => fn(inner));
    return { repos: { ...outer, tx } as unknown as Repos, outer, inner };
  };

  it.each(["ORG", "STAFF", "PLATFORM_WIDE", "PERSONAL"] as const)(
    "%s key: reads find no grant and writes are refused, in and out of a tx, without the real repo",
    async (subject) => {
      const { repos, outer, inner } = lifecycleRepos();
      const scoped = scopeReposToKey(repos, key(subject));
      const check = async (r: Pick<Repos, "placeBookingGrants">) => {
        const g = r.placeBookingGrants;
        await expect(g.getForPlace({ id: GRANT, placeId: grantRow.placeId })).resolves.toBeNull();
        await expect(
          g.getForGrantee({ id: GRANT, humanIds: [HOLDER], orgIds: [] }),
        ).resolves.toBeNull();
        await expect(g.listForPlace({ placeId: grantRow.placeId })).resolves.toEqual([]);
        await expect(
          g.listForGrantee({ humanIds: [HOLDER], orgIds: [], now: NOW_AT }),
        ).resolves.toEqual([]);
        const refused = {
          code: "FORBIDDEN",
          message: "API_KEY_SCOPE: place_booking_grant_session_only",
        };
        await expect(
          g.create({
            placeId: grantRow.placeId,
            grantee: grantRow.grantee,
            grantedByHumanId: HOLDER,
          }),
        ).rejects.toMatchObject(refused);
        const answer = { id: GRANT, humanIds: [HOLDER], orgIds: [], now: NOW_AT };
        await expect(g.accept(answer)).rejects.toMatchObject(refused);
        await expect(g.decline(answer)).rejects.toMatchObject(refused);
        await expect(
          g.update({ id: GRANT, placeId: grantRow.placeId, expiresAt: null }),
        ).rejects.toMatchObject(refused);
        await expect(
          g.revoke({ id: GRANT, placeId: grantRow.placeId, now: NOW_AT }),
        ).rejects.toMatchObject(refused);
      };
      await check(scoped);
      await scoped.tx(async (t) => check(t));
      for (const r of [outer, inner]) {
        for (const fn of Object.entries(r.placeBookingGrants)) {
          if (fn[0] === "listExpiring" || fn[0] === "markExpiryWarned") continue;
          expect(fn[1], fn[0]).not.toHaveBeenCalled();
        }
      }
    },
  );

  it("the expiry job's reads pass through (no key ever runs them, nothing to narrow)", async () => {
    const { repos } = lifecycleRepos();
    const scoped = scopeReposToKey(repos, key("STAFF"));
    await expect(
      scoped.placeBookingGrants.listExpiring({
        expiresBefore: NOW_AT,
        unwarnedOnly: true,
        limit: 10,
      }),
    ).resolves.toHaveLength(1);
  });

  it("PERSONAL key: the grantee's own answer through the use case reads not found (session-only)", async () => {
    const { respondToPlaceBookingGrant } = await import(
      "@th/core/use-cases/place-booking-grants/respond"
    );
    const { repos, outer, inner } = lifecycleRepos();
    const scoped = scopeReposToKey(repos, key("PERSONAL"));
    await expect(
      respondToPlaceBookingGrant(
        { repos: scoped, clock: { now: () => NOW_AT } },
        { actorHumanId: HOLDER, grantId: GRANT, answer: "accept" },
      ),
    ).rejects.toMatchObject({ code: "PLACE_BOOKING_GRANT_NOT_FOUND" });
    // Without a key the same call reaches the repo and answers.
    await expect(
      respondToPlaceBookingGrant(
        { repos, clock: { now: () => NOW_AT } },
        { actorHumanId: HOLDER, grantId: GRANT, answer: "accept" },
      ),
    ).resolves.toMatchObject({ alreadyAnswered: false });
    expect(inner.placeBookingGrants.accept).toHaveBeenCalledTimes(1);
    expect(outer.placeBookingGrants.getForGrantee).toHaveBeenCalledTimes(1);
  });
});
