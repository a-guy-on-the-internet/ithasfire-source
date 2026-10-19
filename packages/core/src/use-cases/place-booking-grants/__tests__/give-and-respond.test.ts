import { describe, expect, it, vi } from "vitest";

import { givePlaceBookingGrant, PLACE_BOOKING_GRANT_INVITES_PER_DAY } from "../give";
import { respondToPlaceBookingGrant } from "../respond";
import {
  ADMIN_MEMBER,
  ADMIN_SELF_PAGE,
  BANNED_ORG_PAGE,
  BANNED_PAGE,
  BOOKER_ADMIN,
  BOOKER_EDITOR,
  BOOKER_ORG,
  BOOKER_ORG_PAGE,
  BOOKER_OWNER,
  BOOKER_VIEWER,
  CALENDAR_ID,
  DELEGATE_ID,
  DIRECT_OWNER_ID,
  DIRECT_OWNER_PAGE,
  EDITOR_MEMBER,
  FOREIGN_CALENDAR_ID,
  NOW,
  OTHER_CALENDAR_ID,
  OTHER_ORG,
  OWNER_MEMBER,
  OWNING_ORG_PAGE,
  PERSON_ID,
  PERSON_PAGE,
  PLACE_ID,
  PLACE_PAGE,
  PRIVATE_PAGE,
  STRANGER_ID,
  UNLISTED_PAGE,
  VIEWER_MEMBER,
  buildGrantTestContext,
} from "./grant-test-context";

const DAY = 24 * 60 * 60 * 1000;
const NEXT_MONTH = new Date(NOW.getTime() + 30 * DAY);

const give = (
  ctx: ReturnType<typeof buildGrantTestContext>,
  over: Record<string, unknown> = {},
) =>
  givePlaceBookingGrant(ctx.deps, {
    actorHumanId: DIRECT_OWNER_ID,
    placeId: PLACE_ID,
    granteePageId: BOOKER_ORG_PAGE,
    ...over,
  });

describe("givePlaceBookingGrant: who gives (H4)", () => {
  it("the direct owner gives a pending whole-place grant to an org by its page, tells the grantee, audits", async () => {
    const ctx = buildGrantTestContext();
    const out = await give(ctx);

    expect(out.alreadyGiven).toBe(false);
    expect(out.grant).toMatchObject({
      placeId: PLACE_ID,
      calendarId: null,
      grantee: { kind: "org", orgId: BOOKER_ORG },
      grantedByHumanId: DIRECT_OWNER_ID,
      acceptedAt: null,
      status: "pending",
    });
    expect(out.notificationIntents).toEqual([
      {
        kind: "grant.given",
        grantId: out.grant.id,
        placeId: PLACE_ID,
        calendarId: null,
        audience: "grantee",
        grantee: { kind: "org", orgId: BOOKER_ORG },
      },
    ]);
    expect(ctx.actions("place_booking_grant.given")).toEqual([
      expect.objectContaining({
        entityId: out.grant.id,
        data: expect.objectContaining({
          actorHumanId: DIRECT_OWNER_ID,
          grantee: { kind: "org", orgId: BOOKER_ORG },
          granteePageId: BOOKER_ORG_PAGE,
        }),
      }),
    ]);
    // Pending: nothing counts until accepted.
    expect(
      await ctx.placeBookingGrants.findActiveForActor({
        placeId: PLACE_ID,
        humanIds: [],
        orgIds: [BOOKER_ORG],
        now: NOW,
      }),
    ).toBeNull();
  });

  it.each([
    ["org OWNER", OWNER_MEMBER],
    ["org ADMIN", ADMIN_MEMBER],
  ])("an owning-org %s gives", async (_label, actor) => {
    const ctx = buildGrantTestContext();
    const out = await give(ctx, { actorHumanId: actor });
    expect(out.grant.grantedByHumanId).toBe(actor);
  });

  it.each([
    ["org EDITOR", EDITOR_MEMBER, "INSUFFICIENT_ROLE"],
    ["org VIEWER", VIEWER_MEMBER, "INSUFFICIENT_ROLE"],
    ["a stranger", STRANGER_ID, "NOT_RESOURCE_OWNER"],
  ])("%s is refused and nothing is written", async (_label, actor, code) => {
    const ctx = buildGrantTestContext();
    await expect(give(ctx, { actorHumanId: actor })).rejects.toMatchObject({ code });
    expect(ctx.placeBookingGrants.create).not.toHaveBeenCalled();
    expect(ctx.entityPages.getById).not.toHaveBeenCalled();
    expect(ctx.auditRows).toEqual([]);
  });

  it("a grantee (an ACTIVE booker at the place) is refused: a grant is not staff", async () => {
    const ctx = buildGrantTestContext();
    ctx.placeBookingGrants.seed({ placeId: PLACE_ID, humanId: PERSON_ID });
    await expect(
      give(ctx, { actorHumanId: PERSON_ID, granteePageId: BOOKER_ORG_PAGE }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    // A booker-org admin with an accepted org grant is refused too.
    ctx.placeBookingGrants.seed({
      placeId: PLACE_ID,
      grantee: { kind: "org", orgId: BOOKER_ORG },
    });
    await expect(
      give(ctx, { actorHumanId: BOOKER_ADMIN, granteePageId: PERSON_PAGE }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(ctx.placeBookingGrants.create).not.toHaveBeenCalled();
  });
});

describe("givePlaceBookingGrant: the grantee, by public page (NFR-002)", () => {
  it("a person's page names the person; an org's page names the org", async () => {
    const ctx = buildGrantTestContext();
    const person = await give(ctx, { granteePageId: PERSON_PAGE });
    expect(person.grant.grantee).toEqual({ kind: "person", humanId: PERSON_ID });
    const org = await give(ctx, { granteePageId: BOOKER_ORG_PAGE });
    expect(org.grant.grantee).toEqual({ kind: "org", orgId: BOOKER_ORG });
  });

  it("a missing or PRIVATE page reads PAGE_NOT_FOUND; a place's page is not an org or a person", async () => {
    const ctx = buildGrantTestContext();
    await expect(
      give(ctx, { granteePageId: "dfdfdfdf-dfdf-4dfd-8dfd-dfdfdfdfdfdf" }),
    ).rejects.toMatchObject({ code: "PAGE_NOT_FOUND" });
    await expect(give(ctx, { granteePageId: PRIVATE_PAGE })).rejects.toMatchObject({
      code: "PAGE_NOT_FOUND",
    });
    await expect(give(ctx, { granteePageId: PLACE_PAGE })).rejects.toMatchObject({
      code: "PLACE_BOOKING_GRANT_GRANTEE_INVALID",
      meta: { reason: "not_org_or_person" },
    });
    expect(ctx.placeBookingGrants.create).not.toHaveBeenCalled();
  });

  it("an UNLISTED page, a banned person's page and a banned org's page read PAGE_NOT_FOUND, like a missing one (NFR-002)", async () => {
    const ctx = buildGrantTestContext();
    for (const granteePageId of [UNLISTED_PAGE, BANNED_PAGE, BANNED_ORG_PAGE]) {
      await expect(give(ctx, { granteePageId })).rejects.toMatchObject({
        code: "PAGE_NOT_FOUND",
        meta: { pageId: granteePageId },
      });
    }
    expect(ctx.bans.findBannedOwners).toHaveBeenCalledWith({
      humanIds: [],
      orgIds: [expect.any(String)],
    });
    expect(ctx.placeBookingGrants.create).not.toHaveBeenCalled();
    expect(ctx.audit.log).not.toHaveBeenCalled();
  });

  it.each([
    ["the owning org", OWNING_ORG_PAGE, DIRECT_OWNER_ID, "place_owner"],
    ["the direct owner", DIRECT_OWNER_PAGE, ADMIN_MEMBER, "place_owner"],
    ["the giver themself", ADMIN_SELF_PAGE, ADMIN_MEMBER, "self"],
  ])("giving to %s is refused", async (_label, pageId, actor, reason) => {
    const ctx = buildGrantTestContext();
    await expect(
      give(ctx, { granteePageId: pageId, actorHumanId: actor }),
    ).rejects.toMatchObject({
      code: "PLACE_BOOKING_GRANT_GRANTEE_INVALID",
      meta: { reason },
    });
    expect(ctx.placeBookingGrants.create).not.toHaveBeenCalled();
  });
});

describe("givePlaceBookingGrant: self through an org or a delegation (H2)", () => {
  it.each(["OWNER", "ADMIN", "EDITOR"] as const)(
    "a manager who is %s of the grantee org is refused (self); nothing written",
    async (role) => {
      const ctx = buildGrantTestContext({
        extraMemberships: [{ orgId: BOOKER_ORG, humanId: ADMIN_MEMBER, role }],
      });
      await expect(give(ctx, { actorHumanId: ADMIN_MEMBER })).rejects.toMatchObject({
        code: "PLACE_BOOKING_GRANT_GRANTEE_INVALID",
        meta: { reason: "self" },
      });
      expect(ctx.placeBookingGrants.create).not.toHaveBeenCalled();
      expect(ctx.actions("place_booking_grant.given")).toHaveLength(0);
    },
  );

  it("a VIEWER membership in the grantee org does not make it self; another manager gives it", async () => {
    const ctx = buildGrantTestContext({
      extraMemberships: [{ orgId: BOOKER_ORG, humanId: ADMIN_MEMBER, role: "VIEWER" }],
    });
    await expect(give(ctx, { actorHumanId: ADMIN_MEMBER })).resolves.toMatchObject({
      alreadyGiven: false,
    });
    const other = buildGrantTestContext({
      extraMemberships: [{ orgId: BOOKER_ORG, humanId: ADMIN_MEMBER, role: "EDITOR" }],
    });
    await expect(give(other, { actorHumanId: OWNER_MEMBER })).resolves.toMatchObject({
      alreadyGiven: false,
    });
  });

  it("a manager who is an edit-role delegate of the grantee person is refused (self); a VIEWER delegate is not", async () => {
    const ctx = buildGrantTestContext({
      extraDelegations: [{ principalId: PERSON_ID, delegateId: ADMIN_MEMBER, role: "EDITOR" }],
    });
    await expect(
      give(ctx, { actorHumanId: ADMIN_MEMBER, granteePageId: PERSON_PAGE }),
    ).rejects.toMatchObject({
      code: "PLACE_BOOKING_GRANT_GRANTEE_INVALID",
      meta: { reason: "self" },
    });
    expect(ctx.placeBookingGrants.create).not.toHaveBeenCalled();

    const viewer = buildGrantTestContext({
      extraDelegations: [{ principalId: PERSON_ID, delegateId: ADMIN_MEMBER, role: "VIEWER" }],
    });
    await expect(
      give(viewer, { actorHumanId: ADMIN_MEMBER, granteePageId: PERSON_PAGE }),
    ).resolves.toMatchObject({ alreadyGiven: false });
  });
});

describe("givePlaceBookingGrant: two gives at once (a double submit)", () => {
  it("takes the place's grant-set lock before it reads the grants it checks, inside the transaction", async () => {
    const ctx = buildGrantTestContext();
    await give(ctx);
    const lock = vi.mocked(ctx.placeBookingGrants.lockPlace).mock;
    const read = vi.mocked(ctx.placeBookingGrants.listForPlace).mock;
    const create = vi.mocked(ctx.placeBookingGrants.create).mock;
    expect(lock.calls).toEqual([[PLACE_ID]]);
    expect(lock.invocationCallOrder[0]).toBeLessThan(read.invocationCallOrder[0]!);
    expect(read.invocationCallOrder[0]).toBeLessThan(create.invocationCallOrder[0]!);
  });

  it("the identical grant committed while this give waited on the lock is returned: one row, one notice", async () => {
    const ctx = buildGrantTestContext();
    let racer: { id: string } | undefined;
    // The other give commits while this one waits on the place's lock.
    vi.mocked(ctx.placeBookingGrants.lockPlace).mockImplementationOnce(async () => {
      racer = ctx.placeBookingGrants.seed({
        placeId: PLACE_ID,
        grantee: { kind: "org", orgId: BOOKER_ORG },
        acceptedAt: null,
        grantedByHumanId: DIRECT_OWNER_ID,
        createdAt: NOW,
      });
    });
    const out = await give(ctx);
    expect(out).toMatchObject({ alreadyGiven: true, notificationIntents: [] });
    expect(out.grant.id).toBe(racer!.id);
    expect(ctx.placeBookingGrants.rows.size).toBe(1);
    expect(ctx.placeBookingGrants.create).not.toHaveBeenCalled();
    expect(ctx.actions("place_booking_grant.given")).toHaveLength(0);
  });

  it("an overlapping grant committed before this give's transaction is EXISTS, and nothing is written", async () => {
    const ctx = buildGrantTestContext();
    let racer: { id: string } | undefined;
    // The other give committed after this one's gate reads (no grant read
    // happens before the transaction any more).
    ctx.commitBeforeNextTx(() => {
      racer = ctx.placeBookingGrants.seed({
        placeId: PLACE_ID,
        grantee: { kind: "org", orgId: BOOKER_ORG },
        acceptedAt: null,
        createdAt: NOW,
      });
    });
    const error = await give(ctx, { calendarId: CALENDAR_ID }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PLACE_BOOKING_GRANT_EXISTS",
      meta: { grantId: racer!.id },
    });
    expect([...ctx.placeBookingGrants.rows.keys()]).toEqual([racer!.id]);
    expect(ctx.placeBookingGrants.create).not.toHaveBeenCalled();
  });
});

describe("givePlaceBookingGrant: scope, expiry, duplicates, the cap", () => {
  it("scopes to one of the place's calendars; a calendar of another place is refused", async () => {
    const ctx = buildGrantTestContext();
    const out = await give(ctx, { calendarId: CALENDAR_ID });
    expect(out.grant.calendarId).toBe(CALENDAR_ID);
    await expect(
      give(ctx, { calendarId: FOREIGN_CALENDAR_ID, granteePageId: PERSON_PAGE }),
    ).rejects.toMatchObject({
      code: "CALENDAR_NOT_FOUND",
      meta: { reason: "grant_calendar_place_mismatch" },
    });
    expect(ctx.placeBookingGrants.create).toHaveBeenCalledTimes(1);
  });

  it("an expiry must be in the future", async () => {
    const ctx = buildGrantTestContext();
    await expect(give(ctx, { expiresAt: NOW })).rejects.toMatchObject({
      code: "EXPIRES_AT_IN_PAST",
    });
    const out = await give(ctx, { expiresAt: NEXT_MONTH });
    expect(out.grant.expiresAt).toEqual(NEXT_MONTH);
  });

  it("giving the same grant again returns it: no second row, no second notice (idempotent)", async () => {
    const ctx = buildGrantTestContext();
    const first = await give(ctx, { calendarId: CALENDAR_ID, expiresAt: NEXT_MONTH });
    const again = await give(ctx, { calendarId: CALENDAR_ID, expiresAt: NEXT_MONTH });
    expect(again).toMatchObject({ alreadyGiven: true, notificationIntents: [] });
    expect(again.grant.id).toBe(first.grant.id);
    expect(ctx.placeBookingGrants.rows.size).toBe(1);
    expect(ctx.actions("place_booking_grant.given")).toHaveLength(1);
  });

  it("an accepted grant counts as live too: the same give returns it", async () => {
    const ctx = buildGrantTestContext();
    const accepted = ctx.placeBookingGrants.seed({
      placeId: PLACE_ID,
      grantee: { kind: "org", orgId: BOOKER_ORG },
    });
    const again = await give(ctx);
    expect(again).toMatchObject({ alreadyGiven: true, grant: { id: accepted.id, status: "active" } });
  });

  it("an overlapping live grant is EXISTS (edit it instead); another calendar is a second grant", async () => {
    const ctx = buildGrantTestContext();
    const whole = await give(ctx);
    await expect(give(ctx, { calendarId: CALENDAR_ID })).rejects.toMatchObject({
      code: "PLACE_BOOKING_GRANT_EXISTS",
      meta: { grantId: whole.grant.id },
    });
    await expect(give(ctx, { expiresAt: NEXT_MONTH })).rejects.toMatchObject({
      code: "PLACE_BOOKING_GRANT_EXISTS",
    });

    const ctx2 = buildGrantTestContext();
    const main = await give(ctx2, { calendarId: CALENDAR_ID });
    const patio = await give(ctx2, { calendarId: OTHER_CALENDAR_ID });
    expect(patio.grant.id).not.toBe(main.grant.id);
    await expect(give(ctx2)).rejects.toMatchObject({ code: "PLACE_BOOKING_GRANT_EXISTS" });
  });

  it("ended grants (revoked, declined, expired) do not block a new one", async () => {
    const ctx = buildGrantTestContext();
    const grantee = { kind: "org" as const, orgId: BOOKER_ORG };
    ctx.placeBookingGrants.seed({ placeId: PLACE_ID, grantee, revokedAt: NOW });
    ctx.placeBookingGrants.seed({ placeId: PLACE_ID, grantee, acceptedAt: null, declinedAt: NOW });
    ctx.placeBookingGrants.seed({
      placeId: PLACE_ID,
      grantee,
      expiresAt: new Date(NOW.getTime() - 1000),
    });
    const out = await give(ctx);
    expect(out.alreadyGiven).toBe(false);
  });

  it(`refuses the ${PLACE_BOOKING_GRANT_INVITES_PER_DAY + 1}st grant in 24 hours at a place (RATE_LIMITED); older ones do not count; an idempotent retry is not charged`, async () => {
    const ctx = buildGrantTestContext();
    for (let i = 0; i < PLACE_BOOKING_GRANT_INVITES_PER_DAY; i += 1) {
      ctx.placeBookingGrants.seed({
        placeId: PLACE_ID,
        grantee: { kind: "org", orgId: `0000000${i % 10}-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}` },
        acceptedAt: null,
        // Revoked ones count: give → revoke → give spends the budget.
        revokedAt: i % 2 === 0 ? NOW : null,
        createdAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      });
    }
    await expect(give(ctx, { granteePageId: PERSON_PAGE })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      meta: { scope: "place_booking_grant_invites_daily" },
    });
    expect(ctx.placeBookingGrants.create).not.toHaveBeenCalled();

    const old = buildGrantTestContext();
    for (let i = 0; i < PLACE_BOOKING_GRANT_INVITES_PER_DAY; i += 1) {
      old.placeBookingGrants.seed({
        placeId: PLACE_ID,
        grantee: { kind: "org", orgId: `0000000${i % 10}-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}` },
        acceptedAt: null,
        createdAt: new Date(NOW.getTime() - DAY - 1000),
      });
    }
    await expect(give(old, { granteePageId: PERSON_PAGE })).resolves.toMatchObject({
      alreadyGiven: false,
    });
    // At the cap, the same give again is answered, not refused.
    await expect(give(old, { granteePageId: PERSON_PAGE })).resolves.toMatchObject({
      alreadyGiven: true,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const pendingOrgGrant = (ctx: ReturnType<typeof buildGrantTestContext>, orgId = BOOKER_ORG) =>
  ctx.placeBookingGrants.seed({
    placeId: PLACE_ID,
    grantee: { kind: "org", orgId },
    acceptedAt: null,
    grantedByHumanId: ADMIN_MEMBER,
  });
const pendingPersonGrant = (ctx: ReturnType<typeof buildGrantTestContext>) =>
  ctx.placeBookingGrants.seed({
    placeId: PLACE_ID,
    humanId: PERSON_ID,
    acceptedAt: null,
    grantedByHumanId: ADMIN_MEMBER,
  });

const respond = (
  ctx: ReturnType<typeof buildGrantTestContext>,
  actorHumanId: string,
  grantId: string,
  answer: "accept" | "decline" = "accept",
) => respondToPlaceBookingGrant(ctx.deps, { actorHumanId, grantId, answer });

describe("respondToPlaceBookingGrant: who answers (H4)", () => {
  it("the person accepts their own grant; the staff member who gave it is told; audited", async () => {
    const ctx = buildGrantTestContext();
    const grant = pendingPersonGrant(ctx);
    const out = await respond(ctx, PERSON_ID, grant.id);
    expect(out).toMatchObject({
      alreadyAnswered: false,
      grant: { id: grant.id, status: "active", acceptedAt: NOW },
    });
    expect(out.notificationIntents).toEqual([
      {
        kind: "grant.accepted",
        grantId: grant.id,
        placeId: PLACE_ID,
        calendarId: null,
        audience: "granter",
        granterHumanId: ADMIN_MEMBER,
      },
    ]);
    expect(ctx.actions("place_booking_grant.accepted")).toHaveLength(1);
    // The grantee's view: which manager gave it stays with the place.
    expect(out.grant).not.toHaveProperty("grantedByHumanId");
    // Active now: the booker gate's lookup finds it.
    expect(
      await ctx.placeBookingGrants.findActiveForActor({
        placeId: PLACE_ID,
        humanIds: [PERSON_ID],
        orgIds: [],
        now: NOW,
      }),
    ).toMatchObject({ id: grant.id });
  });

  it("an org ADMIN accepts and an org OWNER declines for the org", async () => {
    const ctx = buildGrantTestContext();
    const a = pendingOrgGrant(ctx);
    await expect(respond(ctx, BOOKER_ADMIN, a.id)).resolves.toMatchObject({
      grant: { status: "active" },
    });
    const ctx2 = buildGrantTestContext();
    const b = pendingOrgGrant(ctx2);
    const out = await respond(ctx2, BOOKER_OWNER, b.id, "decline");
    expect(out.grant).toMatchObject({ status: "declined", declinedAt: NOW });
    expect(out.notificationIntents[0]).toMatchObject({ kind: "grant.declined" });
  });

  it.each([
    ["the grantee org's EDITOR", BOOKER_EDITOR, "org"],
    ["the grantee org's VIEWER", BOOKER_VIEWER, "org"],
    ["the person's delegate", DELEGATE_ID, "person"],
    ["a stranger", STRANGER_ID, "org"],
    ["the place's own admin", ADMIN_MEMBER, "org"],
  ] as const)("%s cannot answer: reads as not found, the grant stays pending", async (_l, actor, kind) => {
    const ctx = buildGrantTestContext();
    const grant = kind === "org" ? pendingOrgGrant(ctx) : pendingPersonGrant(ctx);
    for (const answer of ["accept", "decline"] as const) {
      await expect(respond(ctx, actor, grant.id, answer)).rejects.toMatchObject({
        code: "PLACE_BOOKING_GRANT_NOT_FOUND",
      });
    }
    expect(ctx.placeBookingGrants.rows.get(grant.id)).toMatchObject({
      acceptedAt: null,
      declinedAt: null,
    });
    expect(ctx.placeBookingGrants.accept).not.toHaveBeenCalled();
    expect(ctx.placeBookingGrants.decline).not.toHaveBeenCalled();
  });

  it("an admin of ONE org cannot answer a grant given to ANOTHER org", async () => {
    const ctx = buildGrantTestContext();
    const grant = pendingOrgGrant(ctx, OTHER_ORG);
    await expect(respond(ctx, BOOKER_ADMIN, grant.id)).rejects.toMatchObject({
      code: "PLACE_BOOKING_GRANT_NOT_FOUND",
    });
  });
});

describe("respondToPlaceBookingGrant: state", () => {
  it("an expired pending grant cannot be answered (ENDED expired), and stays as it was", async () => {
    const ctx = buildGrantTestContext();
    const grant = ctx.placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: PERSON_ID,
      acceptedAt: null,
      expiresAt: new Date(NOW.getTime() - 1),
    });
    for (const answer of ["accept", "decline"] as const) {
      await expect(respond(ctx, PERSON_ID, grant.id, answer)).rejects.toMatchObject({
        code: "PLACE_BOOKING_GRANT_ENDED",
        meta: { reason: "expired" },
      });
    }
    expect(ctx.placeBookingGrants.accept).not.toHaveBeenCalled();
    expect(ctx.placeBookingGrants.rows.get(grant.id)?.acceptedAt).toBeNull();
  });

  it("a revoked grant cannot be answered (ENDED revoked)", async () => {
    const ctx = buildGrantTestContext();
    const grant = ctx.placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: PERSON_ID,
      acceptedAt: null,
      revokedAt: NOW,
    });
    await expect(respond(ctx, PERSON_ID, grant.id)).rejects.toMatchObject({
      code: "PLACE_BOOKING_GRANT_ENDED",
      meta: { reason: "revoked" },
    });
  });

  it("the same answer twice is idempotent; the other answer after one is NOT_PENDING", async () => {
    const ctx = buildGrantTestContext();
    const grant = pendingPersonGrant(ctx);
    await respond(ctx, PERSON_ID, grant.id);
    const again = await respond(ctx, PERSON_ID, grant.id);
    expect(again).toMatchObject({ alreadyAnswered: true, notificationIntents: [] });
    expect(ctx.placeBookingGrants.accept).toHaveBeenCalledTimes(1);
    expect(ctx.actions("place_booking_grant.accepted")).toHaveLength(1);
    await expect(respond(ctx, PERSON_ID, grant.id, "decline")).rejects.toMatchObject({
      code: "PLACE_BOOKING_GRANT_NOT_PENDING",
    });
  });

  it("a lost CAS (answered in between) is re-read: the same answer reads as already given", async () => {
    const ctx = buildGrantTestContext();
    const grant = pendingOrgGrant(ctx);
    // Another admin accepts first, between this call's read and its write
    // (its own transaction, committed: this one's rollback keeps it).
    ctx.commitBeforeNextTx(() => {
      ctx.placeBookingGrants.rows.set(grant.id, { ...grant, acceptedAt: NOW });
    });
    const out = await respond(ctx, BOOKER_ADMIN, grant.id);
    // The CAS ran and lost (not_pending), then the re-read answered.
    expect(ctx.placeBookingGrants.accept).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ alreadyAnswered: true, grant: { status: "active" } });
    expect(ctx.actions("place_booking_grant.accepted")).toHaveLength(0);
  });
});
