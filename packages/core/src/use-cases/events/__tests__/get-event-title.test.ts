import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { OrgMembership, OrgRole } from "@th/ports/repos/authz";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { getEventTitle, type GetEventTitleDeps } from "../get-event-title";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = "aaaa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ID = "bbbb0000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORG_ID = "cccc0000-cccc-4ccc-8ccc-cccccccccccc";
const EVENT_ID = "dddd0000-dddd-4ddd-8ddd-dddddddddddd";

const ORG_EVENT: EventRecord = {
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: OTHER_ID,
  stewardship: "OWNED",
  title: "Org Night Out",
  status: "PUBLISHED",
  visibility: "PUBLIC",
  gateType: "NONE",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2025-06-01T20:00:00Z"),
  endsAt: new Date("2025-06-01T23:00:00Z"),
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  addressText: "123 Main St",
  countryCode: "US",
  region: "CA",
  locality: "Los Angeles",
  postalCode: "90001",
  lat: 34.05,
  lng: -118.25,
  slug: "org-night-out",
  shortId: "ono1",
  regionCode: "us-ca",
  publishedAt: new Date("2025-05-01T00:00:00Z"),
  agreementPrimaryId: "eeee0000-eeee-4eee-8eee-eeeeeeeeeeee",
  agreementResaleId: null,
  defaultLocale: "en-US",
  listingPriority: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  placeLayoutId: null,
  currency: null,
  createdAt: new Date("2025-04-01T00:00:00Z"),
  updatedAt: new Date("2025-05-01T00:00:00Z"),
};

const HUMAN_EVENT: EventRecord = {
  ...ORG_EVENT,
  orgId: null,
  humanId: ACTOR_ID,
  title: "Solo Show",
};

/** Ownerless by DB constraint: orgId AND humanId both null. */
const COMMUNITY_EVENT: EventRecord = {
  ...ORG_EVENT,
  orgId: null,
  humanId: null,
  stewardship: "COMMUNITY",
  title: "Open Mic at the Park",
  slug: "open-mic-at-the-park",
};

// ─────────────────────────────────────────────────────────────────────────────
// Deps factory
// ─────────────────────────────────────────────────────────────────────────────

function createDeps() {
  const getById = vi.fn<[eventId: string], Promise<EventRecord | null>>();
  const getOrgMembership = vi.fn<
    [params: { orgId: string; humanId: string }],
    Promise<OrgMembership | null>
  >();

  const getHumanDelegation = vi.fn<
    [params: { principalId: string; delegateId: string }],
    Promise<OrgMembership | null>
  >(async () => null);
  const getHuman = vi.fn(async (id: string) => ({ id, name: "Pat Principal" }));

  const repos = {
    events: { getById },
    authz: { getOrgMembership, getHumanDelegation },
    humans: { getById: getHuman },
  } as unknown as Repos;

  // Platform staff roles the actor holds; empty = a plain user.
  const staffRoles: { current: string[] } = { current: [] };
  const hasStaffRole = vi.fn(
    async (params: { actorHumanId: string; requiredRoles: string[] }) => ({
      allowed: params.requiredRoles.some((r) => staffRoles.current.includes(r)),
    }),
  );

  const logger = createTestLogger();
  const deps = {
    repos,
    authz: { hasStaffRole },
    logger,
  } as unknown as GetEventTitleDeps;

  return {
    deps,
    getById,
    getOrgMembership,
    getHumanDelegation,
    getHuman,
    hasStaffRole,
    staffRoles,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("getEventTitle", () => {
  let ctx: ReturnType<typeof createDeps>;

  beforeEach(() => {
    ctx = createDeps();
  });

  it("returns the title for an org event when actor is a member", async () => {
    ctx.getById.mockResolvedValue(ORG_EVENT);
    ctx.getOrgMembership.mockResolvedValue({
      orgId: ORG_ID,
      humanId: ACTOR_ID,
      role: "EDITOR" as OrgRole,
    });

    const result = await getEventTitle(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result).toEqual({
      eventId: EVENT_ID,
      title: "Org Night Out",
      status: "PUBLISHED",
      slug: "org-night-out",
      stewardship: "OWNED",
      ownerOrgId: ORG_ID,
      ownerHumanId: null,
      ownerHumanName: null,
      viewerCanEdit: true,
      // An org EDITOR edits and publishes but cannot take the event down.
      viewerCanManage: false,
      viewerCanManagePayouts: true,
    });
    expect(ctx.getById).toHaveBeenCalledWith(EVENT_ID);
    expect(ctx.getOrgMembership).toHaveBeenCalledWith({
      orgId: ORG_ID,
      humanId: ACTOR_ID,
    });
  });

  it("returns the title for a human-owned event when actor is the owner", async () => {
    ctx.getById.mockResolvedValue(HUMAN_EVENT);

    const result = await getEventTitle(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result).toEqual({
      eventId: EVENT_ID,
      title: "Solo Show",
      status: "PUBLISHED",
      slug: "org-night-out",
      stewardship: "OWNED",
      ownerOrgId: null,
      ownerHumanId: ACTOR_ID,
      // Only resolved for a delegate — the owner already knows their name.
      ownerHumanName: null,
      viewerCanEdit: true,
      viewerCanManage: true,
      viewerCanManagePayouts: true,
    });
    expect(ctx.getOrgMembership).not.toHaveBeenCalled();
    expect(ctx.getHuman).not.toHaveBeenCalled();
  });

  it("returns the public slug (drives the admin rail's View event link)", async () => {
    ctx.getById.mockResolvedValue({ ...HUMAN_EVENT, slug: "a/deep/slug" });

    const result = await getEventTitle(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.slug).toBe("a/deep/slug");
  });

  it("returns a null slug for an event that has never been assigned one", async () => {
    ctx.getById.mockResolvedValue({ ...HUMAN_EVENT, slug: null });

    const result = await getEventTitle(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.slug).toBeNull();
  });

  it("returns the record's status verbatim (drives the admin rail chip)", async () => {
    ctx.getById.mockResolvedValue({ ...HUMAN_EVENT, status: "DRAFT" });

    const result = await getEventTitle(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.status).toBe("DRAFT");
  });

  it("allows every org role", async () => {
    const roles: OrgRole[] = [
      "OWNER",
      "ADMIN",
      "EDITOR",
      "FINANCE",
      "SCANNER",
      "VIEWER",
    ];

    for (const role of roles) {
      ctx.getById.mockResolvedValue(ORG_EVENT);
      ctx.getOrgMembership.mockResolvedValue({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
        role,
      });

      const result = await getEventTitle(ctx.deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
      });

      expect(result.title).toBe("Org Night Out");
    }
  });

  it("an org VIEWER reads the title but cannot edit or route payouts", async () => {
    ctx.getById.mockResolvedValue(ORG_EVENT);
    ctx.getOrgMembership.mockResolvedValue({
      orgId: ORG_ID,
      humanId: ACTOR_ID,
      role: "VIEWER",
    });

    await expect(
      getEventTitle(ctx.deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID }),
    ).resolves.toMatchObject({
      viewerCanEdit: false,
      viewerCanManage: false,
      viewerCanManagePayouts: false,
    });
  });

  // viewerCanManage mirrors the takedown use cases (unpublish / cancel /
  // regenerate a published slug): ORG_ADMIN_ROLES on the org arm.
  it.each([
    ["OWNER", true],
    ["ADMIN", true],
    ["EDITOR", false],
    ["FINANCE", false],
    ["SCANNER", false],
    ["VIEWER", false],
  ] as const)("an org %s gets viewerCanManage=%s", async (role, expected) => {
    ctx.getById.mockResolvedValue(ORG_EVENT);
    ctx.getOrgMembership.mockResolvedValue({
      orgId: ORG_ID,
      humanId: ACTOR_ID,
      role,
    });

    const result = await getEventTitle(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.viewerCanManage).toBe(expected);
  });

  // Owner ruling 2026-09-28. The delegate arm asks the org arm's role set (any
  // role) to READ the title; editing needs an edit role; payout routing is
  // the owner's alone. The owner's name rides along for the admin shell's
  // "Managing <name>'s event" banner.
  describe("a delegate of the human owner", () => {
    const delegateEvent = { ...HUMAN_EVENT, humanId: OTHER_ID };

    it.each([
      ["OWNER", true],
      ["ADMIN", true],
      ["EDITOR", false],
    ] as const)(
      "a %s delegate can edit, cannot route payouts, gets the owner's name, and viewerCanManage=%s",
      async (role, canManage) => {
        ctx.getById.mockResolvedValue(delegateEvent);
        ctx.getHumanDelegation.mockResolvedValue({
          orgId: OTHER_ID,
          humanId: ACTOR_ID,
          role,
        });

        await expect(
          getEventTitle(ctx.deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID }),
        ).resolves.toMatchObject({
          ownerHumanId: OTHER_ID,
          ownerHumanName: "Pat Principal",
          viewerCanEdit: true,
          viewerCanManage: canManage,
          viewerCanManagePayouts: false,
        });
      },
    );

    it.each(["VIEWER", "FINANCE", "SCANNER"] as const)(
      "a %s delegate reads the title (like an org %s) but cannot edit",
      async (role) => {
        ctx.getById.mockResolvedValue(delegateEvent);
        ctx.getHumanDelegation.mockResolvedValue({
          orgId: OTHER_ID,
          humanId: ACTOR_ID,
          role,
        });

        await expect(
          getEventTitle(ctx.deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID }),
        ).resolves.toMatchObject({
          viewerCanEdit: false,
          viewerCanManage: false,
          viewerCanManagePayouts: false,
        });
      },
    );

    it("a stranger is refused", async () => {
      ctx.getById.mockResolvedValue(delegateEvent);

      await expect(
        getEventTitle(ctx.deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    });
  });

  describe("an ownerless COMMUNITY listing", () => {
    it("a COMMUNITY_MODERATOR reads it and may edit, but not manage or route payouts", async () => {
      ctx.getById.mockResolvedValue(COMMUNITY_EVENT);
      ctx.staffRoles.current = ["COMMUNITY_MODERATOR"];

      const result = await getEventTitle(ctx.deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
      });

      expect(result).toEqual({
        eventId: EVENT_ID,
        title: "Open Mic at the Park",
        status: "PUBLISHED",
        slug: "open-mic-at-the-park",
        stewardship: "COMMUNITY",
        ownerOrgId: null,
        ownerHumanId: null,
        ownerHumanName: null,
        viewerCanEdit: true,
        viewerCanManage: false,
        viewerCanManagePayouts: false,
      });
      expect(ctx.hasStaffRole).toHaveBeenCalledWith({
        actorHumanId: ACTOR_ID,
        requiredRoles: ["COMMUNITY_MODERATOR", "ADMIN"],
      });
      // No owner arm runs for an ownerless row.
      expect(ctx.getOrgMembership).not.toHaveBeenCalled();
      expect(ctx.getHumanDelegation).not.toHaveBeenCalled();
      expect(ctx.getHuman).not.toHaveBeenCalled();
    });

    it("a platform ADMIN reads it with the same flags", async () => {
      ctx.getById.mockResolvedValue({ ...COMMUNITY_EVENT, status: "DRAFT" });
      ctx.staffRoles.current = ["ADMIN"];

      const result = await getEventTitle(ctx.deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
      });

      expect(result).toMatchObject({
        status: "DRAFT",
        stewardship: "COMMUNITY",
        ownerOrgId: null,
        ownerHumanId: null,
        viewerCanEdit: true,
        viewerCanManage: false,
        viewerCanManagePayouts: false,
      });
    });

    it("a plain user gets the same refusal as before the moderator arm", async () => {
      ctx.getById.mockResolvedValue(COMMUNITY_EVENT);

      await expect(
        getEventTitle(ctx.deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID }),
      ).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
        meta: { entity: "event" },
      });
    });

    it("an unrelated staff role (not a moderation role) is refused", async () => {
      ctx.getById.mockResolvedValue(COMMUNITY_EVENT);
      ctx.staffRoles.current = ["SUPPORT"];

      await expect(
        getEventTitle(ctx.deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    });
  });

  describe("a community moderator on an OWNED event", () => {
    beforeEach(() => {
      ctx.staffRoles.current = ["COMMUNITY_MODERATOR", "ADMIN"];
    });

    it("is refused on an org event they are not a member of", async () => {
      ctx.getById.mockResolvedValue({ ...ORG_EVENT, stewardship: "OWNED" });
      ctx.getOrgMembership.mockResolvedValue(null);

      await expect(
        getEventTitle(ctx.deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(ctx.hasStaffRole).not.toHaveBeenCalled();
    });

    it("is refused on someone else's personal event", async () => {
      ctx.getById.mockResolvedValue({ ...HUMAN_EVENT, stewardship: "OWNED" });

      await expect(
        getEventTitle(ctx.deps, { actorHumanId: OTHER_ID, eventId: EVENT_ID }),
      ).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
        meta: { entity: "event" },
      });
      expect(ctx.hasStaffRole).not.toHaveBeenCalled();
    });
  });

  it("throws not_found when event does not exist", async () => {
    ctx.getById.mockResolvedValue(null);

    await expect(
      getEventTitle(ctx.deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("throws forbidden when actor is not an org member", async () => {
    ctx.getById.mockResolvedValue(ORG_EVENT);
    ctx.getOrgMembership.mockResolvedValue(null);

    await expect(
      getEventTitle(ctx.deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("throws forbidden when actor does not own a human event", async () => {
    ctx.getById.mockResolvedValue(HUMAN_EVENT);

    await expect(
      getEventTitle(ctx.deps, { actorHumanId: OTHER_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("throws invalid_input on malformed input", async () => {
    await expect(
      getEventTitle(ctx.deps, {
        actorHumanId: "not-a-uuid",
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("returns null title when event has no title", async () => {
    ctx.getById.mockResolvedValue({
      ...HUMAN_EVENT,
      title: null as unknown as string,
    });

    const result = await getEventTitle(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.title).toBeNull();
  });
});
