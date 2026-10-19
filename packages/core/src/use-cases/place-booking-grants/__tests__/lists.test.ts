import { describe, expect, it } from "vitest";

import { listMyPlaceBookingGrants } from "../list-mine";
import { listPlaceBookingGrantsForPlace } from "../list-for-place";
import {
  ADMIN_MEMBER,
  BOOKER_ADMIN,
  BOOKER_EDITOR,
  BOOKER_ORG,
  BOOKER_VIEWER,
  CALENDAR_ID,
  DELEGATE_ID,
  DIRECT_OWNER_ID,
  EDITOR_MEMBER,
  FOREIGN_PLACE_ID,
  NOW,
  OTHER_ORG,
  OWNER_MEMBER,
  PERSON_ID,
  PLACE_ID,
  STRANGER_ID,
  VIEWER_MEMBER,
  buildGrantTestContext,
} from "./grant-test-context";

const HIDDEN_PERSON = STRANGER_ID; // has only a PRIVATE page in the harness

describe("listPlaceBookingGrantsForPlace", () => {
  function scene() {
    const ctx = buildGrantTestContext();
    const org = ctx.placeBookingGrants.seed({
      placeId: PLACE_ID,
      grantee: { kind: "org", orgId: BOOKER_ORG },
      calendarId: CALENDAR_ID,
      createdAt: new Date(NOW.getTime() - 3000),
    });
    const person = ctx.placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: PERSON_ID,
      acceptedAt: null,
      createdAt: new Date(NOW.getTime() - 2000),
    });
    const hidden = ctx.placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: HIDDEN_PERSON,
      expiresAt: new Date(NOW.getTime() - 1),
      createdAt: new Date(NOW.getTime() - 1000),
    });
    const revoked = ctx.placeBookingGrants.seed({
      placeId: PLACE_ID,
      grantee: { kind: "org", orgId: OTHER_ORG },
      revokedAt: NOW,
      createdAt: new Date(NOW.getTime() - 500),
    });
    const elsewhere = ctx.placeBookingGrants.seed({
      placeId: FOREIGN_PLACE_ID,
      humanId: PERSON_ID,
    });
    return { ctx, org, person, hidden, revoked, elsewhere };
  }

  const list = (
    ctx: ReturnType<typeof buildGrantTestContext>,
    actorHumanId: string,
    includeEnded = false,
  ) =>
    listPlaceBookingGrantsForPlace(ctx.deps, {
      actorHumanId,
      placeId: PLACE_ID,
      includeEnded,
    });

  it("staff read the place's grants with names, page slugs, calendar and status; ended ones only on request", async () => {
    const { ctx, org, person, hidden, revoked } = scene();
    const out = await list(ctx, ADMIN_MEMBER);
    expect(out.canManage).toBe(true);
    expect(out.grants.map((g) => [g.grant.id, g.grant.status])).toEqual([
      [hidden.id, "expired"],
      [person.id, "pending"],
      [org.id, "active"],
    ]);
    const byId = new Map(out.grants.map((g) => [g.grant.id, g]));
    expect(byId.get(org.id)).toMatchObject({
      grantee: { kind: "org", id: BOOKER_ORG, name: "Night Shift Promotions", slug: "night-shift-promotions" },
      calendarName: "Main Room",
    });
    expect(byId.get(person.id)).toMatchObject({
      grantee: { kind: "person", id: PERSON_ID, name: "Dana Regular", slug: "dana-regular" },
      calendarName: null,
    });
    // A person whose only page is PRIVATE: no name, no link.
    expect(byId.get(hidden.id)?.grantee).toEqual({
      kind: "person",
      id: HIDDEN_PERSON,
      name: null,
      slug: null,
    });

    const withEnded = await list(ctx, ADMIN_MEMBER, true);
    expect(withEnded.grants.map((g) => g.grant.id)).toContain(revoked.id);
    expect(withEnded.grants.find((g) => g.grant.id === revoked.id)?.grant.status).toBe("revoked");
  });

  it("an org whose page is PRIVATE is named by the org's own name, never the page's, with no link", async () => {
    const { ctx, org } = scene();
    const real = ctx.entityPages.getByOwners.getMockImplementation()!;
    ctx.entityPages.getByOwners.mockImplementation(async (ownerType, ownerIds) =>
      (await real(ownerType, ownerIds)).map((p) =>
        p.ownerId === BOOKER_ORG ? { ...p, visibility: "PRIVATE" as const } : p,
      ),
    );
    const out = await list(ctx, ADMIN_MEMBER);
    expect(out.grants.find((g) => g.grant.id === org.id)?.grantee).toEqual({
      kind: "org",
      id: BOOKER_ORG,
      name: "Night Shift LLC",
      slug: null,
    });
  });

  it("an EDITOR reads but does not manage; the direct owner and an org OWNER manage", async () => {
    const { ctx } = scene();
    await expect(list(ctx, EDITOR_MEMBER)).resolves.toMatchObject({ canManage: false });
    await expect(list(ctx, DIRECT_OWNER_ID)).resolves.toMatchObject({ canManage: true });
    await expect(list(ctx, OWNER_MEMBER)).resolves.toMatchObject({ canManage: true });
  });

  it("a VIEWER, a grantee and a stranger are refused", async () => {
    const { ctx } = scene();
    await expect(list(ctx, VIEWER_MEMBER)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    await expect(list(ctx, BOOKER_ADMIN)).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(list(ctx, PERSON_ID)).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(list(ctx, STRANGER_ID)).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(ctx.placeBookingGrants.listForPlace).not.toHaveBeenCalled();
  });
});

describe("listMyPlaceBookingGrants", () => {
  function scene() {
    const ctx = buildGrantTestContext();
    const orgPending = ctx.placeBookingGrants.seed({
      placeId: PLACE_ID,
      grantee: { kind: "org", orgId: BOOKER_ORG },
      acceptedAt: null,
      createdAt: new Date(NOW.getTime() - 3000),
    });
    const orgActive = ctx.placeBookingGrants.seed({
      placeId: PLACE_ID,
      grantee: { kind: "org", orgId: BOOKER_ORG },
      calendarId: CALENDAR_ID,
      createdAt: new Date(NOW.getTime() - 2000),
    });
    const otherOrg = ctx.placeBookingGrants.seed({
      placeId: PLACE_ID,
      grantee: { kind: "org", orgId: OTHER_ORG },
      acceptedAt: null,
    });
    const personPending = ctx.placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: PERSON_ID,
      acceptedAt: null,
      createdAt: new Date(NOW.getTime() - 1000),
    });
    const personDeclined = ctx.placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: PERSON_ID,
      acceptedAt: null,
      declinedAt: NOW,
    });
    return { ctx, orgPending, orgActive, otherOrg, personPending, personDeclined };
  }

  const mine = (ctx: ReturnType<typeof buildGrantTestContext>, actorHumanId: string) =>
    listMyPlaceBookingGrants(ctx.deps, { actorHumanId });

  it("an org ADMIN sees the org's pending and active grants, may answer the pending one, with the place's name", async () => {
    const { ctx, orgPending, orgActive } = scene();
    const out = await mine(ctx, BOOKER_ADMIN);
    expect(out.grants.map((g) => [g.grant.id, g.grant.status, g.canRespond])).toEqual([
      [orgActive.id, "active", false],
      [orgPending.id, "pending", true],
    ]);
    expect(out.grants[0]).toMatchObject({
      place: { id: PLACE_ID, name: "Test Venue" },
      calendarName: "Main Room",
      grantee: { kind: "org", id: BOOKER_ORG, name: "Night Shift Promotions" },
    });
    // The grantee's view: which manager gave it stays with the place.
    for (const row of out.grants) {
      expect(row.grant).not.toHaveProperty("grantedByHumanId");
    }
  });

  it("an org EDITOR sees the org's grants (H2: editors act under them) but cannot answer", async () => {
    const { ctx, orgPending } = scene();
    const out = await mine(ctx, BOOKER_EDITOR);
    expect(out.grants.find((g) => g.grant.id === orgPending.id)).toMatchObject({
      canRespond: false,
    });
    expect(out.grants).toHaveLength(2);
  });

  it("an org VIEWER sees none of the org's grants; another org's grants are never listed", async () => {
    const { ctx, otherOrg } = scene();
    expect((await mine(ctx, BOOKER_VIEWER)).grants).toEqual([]);
    const admin = await mine(ctx, BOOKER_ADMIN);
    expect(admin.grants.map((g) => g.grant.id)).not.toContain(otherOrg.id);
  });

  it("a person sees their own pending grant (answerable), not a declined one; their delegate sees none", async () => {
    const { ctx, personPending, personDeclined } = scene();
    const out = await mine(ctx, PERSON_ID);
    expect(out.grants.map((g) => [g.grant.id, g.canRespond])).toEqual([[personPending.id, true]]);
    expect(out.grants.map((g) => g.grant.id)).not.toContain(personDeclined.id);
    expect((await mine(ctx, DELEGATE_ID)).grants).toEqual([]);
  });

  it("place staff with no grants see an empty list", async () => {
    const { ctx } = scene();
    expect((await mine(ctx, ADMIN_MEMBER)).grants).toEqual([]);
  });
});
