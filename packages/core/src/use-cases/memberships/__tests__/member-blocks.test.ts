import { describe, expect, it, vi } from "vitest";

import type { MembershipRecord } from "@th/ports/repos/memberships";
import type { MembershipTierRecord } from "@th/ports/repos/membership-tiers";
import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import {
  listMemberBlocks,
  type ListMemberBlocksDeps,
} from "../list-member-blocks";

/**
 * listMemberBlocks — the ONLY read path for `section == "memberships"` page
 * blocks. getPublicPage drops non-main sections unconditionally (they must
 * never enter the anonymously-cacheable page payload), so this gate is what
 * stands between member-only content and everyone else: no benefit-granting
 * membership at THIS owner ⇒ empty list (never an error — the Membership tab
 * treats empty as "pitch only").
 */

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ID = "22222222-2222-4222-8222-222222222222";
const TIER_ID = "33333333-3333-4333-8333-333333333333";
const MEMBER_ID = "44444444-4444-4444-8444-444444444444";
const HUMAN_OWNER_ID = "55555555-5555-4555-8555-555555555555";
const PAGE_ID = "page-1";
const NOW = new Date("2026-08-10T12:00:00.000Z");

const MAIN_BLOCK: PageBlockRecord = {
  id: "b-main",
  pageId: PAGE_ID,
  kind: "about",
  orderIndex: 0,
  data: { content: "public copy" },
  visible: true,
  section: "main",
};

const MEMBER_BLOCK: PageBlockRecord = {
  id: "b-members",
  pageId: PAGE_ID,
  kind: "links",
  orderIndex: 1,
  data: { content: "MEMBER_ONLY_DISCORD_INVITE" },
  visible: true,
  section: "memberships",
};

const HIDDEN_MEMBER_BLOCK: PageBlockRecord = {
  id: "b-members-hidden",
  pageId: PAGE_ID,
  kind: "about",
  orderIndex: 2,
  data: { content: "draft member copy" },
  visible: false,
  section: "memberships",
};

function buildTier(
  overrides: Partial<MembershipTierRecord> = {},
): MembershipTierRecord {
  return {
    id: TIER_ID,
    ownerOrgId: ORG_ID,
    ownerHumanId: null,
    name: "Sustaining Member",
    description: null,
    priceCents: 1000,
    currency: "usd",
    interval: "MONTH",
    stripeProductId: "prod_1",
    stripePriceId: "price_1",
    status: "ACTIVE",
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function buildMembership(
  overrides: Partial<MembershipRecord> = {},
): MembershipRecord {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    tierId: TIER_ID,
    memberHumanId: MEMBER_ID,
    stripeSubscriptionId: "sub_1",
    stripeCustomerId: "cus_1",
    status: "active",
    taxJurisdictionId: null,
    billingPostalCode: null,
    billingCountryCode: null,
    currentPeriodStart: NOW,
    currentPeriodEnd: new Date("2026-09-10T12:00:00.000Z"),
    cancelAtPeriodEnd: false,
    canceledAt: null,
    startedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeDeps(
  options: {
    /** Rows in the store; listForMember filters by the statuses it is PASSED. */
    memberships?: MembershipRecord[];
    tier?: MembershipTierRecord | null;
    page?: { id: string; visibility: string } | null;
    blocks?: PageBlockRecord[];
  } = {},
) {
  const rows = options.memberships ?? [buildMembership()];
  // Honours the statuses filter like the real repo — a stub that returns
  // everything would make the past_due assertion below worthless.
  const listForMember = vi.fn(
    async (input: { memberHumanId: string; statuses?: string[] }) =>
      rows.filter(
        (row) =>
          row.memberHumanId === input.memberHumanId &&
          (!input.statuses || input.statuses.includes(row.status)),
      ),
  );
  const findById = vi.fn(async (id: string) => {
    const tier = options.tier === undefined ? buildTier() : options.tier;
    return tier && tier.id === id ? tier : null;
  });
  const getByOwner = vi.fn(async () =>
    options.page === undefined
      ? { id: PAGE_ID, visibility: "PUBLIC" }
      : options.page,
  );
  const listBlocks = vi.fn(
    async () =>
      options.blocks ?? [MAIN_BLOCK, MEMBER_BLOCK, HIDDEN_MEMBER_BLOCK],
  );

  const deps = {
    repos: {
      memberships: { listForMember },
      membershipTiers: { findById },
      entityPages: { getByOwner, listBlocks },
    },
  } as unknown as ListMemberBlocksDeps;

  return { deps, listForMember, findById, getByOwner, listBlocks };
}

function baseInput() {
  return {
    actorHumanId: MEMBER_ID,
    ownerType: "ORGANIZATION" as const,
    ownerId: ORG_ID,
  };
}

describe("listMemberBlocks", () => {
  it("returns ONLY the visible memberships-section blocks for an active member", async () => {
    const { deps, listForMember, getByOwner } = makeDeps();

    const result = await listMemberBlocks(deps, baseInput());

    expect(result.blocks.map((b) => b.id)).toEqual(["b-members"]);
    // Main-section blocks belong to the public page, not this endpoint; a
    // hidden member block is a draft and stays hidden.
    expect(result.blocks.some((b) => b.id === "b-main")).toBe(false);
    expect(result.blocks.some((b) => b.id === "b-members-hidden")).toBe(false);
    // The repo filter carries the benefit-granting statuses — the DB never
    // even returns a lapsed row.
    expect(listForMember).toHaveBeenCalledWith({
      memberHumanId: MEMBER_ID,
      statuses: ["active", "trialing"],
    });
    expect(getByOwner).toHaveBeenCalledWith("ORGANIZATION", ORG_ID);
  });

  it("returns EMPTY (not an error) for a viewer with no memberships — and never reads the blocks", async () => {
    const { deps, listBlocks, getByOwner } = makeDeps({ memberships: [] });

    const result = await listMemberBlocks(deps, baseInput());

    expect(result).toEqual({ blocks: [] });
    expect(getByOwner).not.toHaveBeenCalled();
    expect(listBlocks).not.toHaveBeenCalled();
  });

  it("a past_due membership unlocks NOTHING — a failing card earns no member content", async () => {
    const { deps, listBlocks } = makeDeps({
      memberships: [buildMembership({ status: "past_due" })],
    });

    const result = await listMemberBlocks(deps, baseInput());

    expect(result).toEqual({ blocks: [] });
    expect(listBlocks).not.toHaveBeenCalled();
  });

  it("a canceled membership unlocks NOTHING", async () => {
    const { deps } = makeDeps({
      memberships: [buildMembership({ status: "canceled" })],
    });

    await expect(listMemberBlocks(deps, baseInput())).resolves.toEqual({
      blocks: [],
    });
  });

  it("a membership at a DIFFERENT owner does not unlock this owner's blocks", async () => {
    // Active membership on a tier owned by OTHER_ORG_ID; request is for ORG_ID.
    const { deps, listBlocks } = makeDeps({
      tier: buildTier({ ownerOrgId: OTHER_ORG_ID }),
    });

    const result = await listMemberBlocks(deps, baseInput());

    expect(result).toEqual({ blocks: [] });
    expect(listBlocks).not.toHaveBeenCalled();
  });

  it("matches HUMAN owners on ownerHumanId, never ownerOrgId", async () => {
    const { deps } = makeDeps({
      tier: buildTier({ ownerOrgId: null, ownerHumanId: HUMAN_OWNER_ID }),
    });

    // Same id presented as the WRONG owner type unlocks nothing…
    await expect(
      listMemberBlocks(deps, {
        actorHumanId: MEMBER_ID,
        ownerType: "ORGANIZATION",
        ownerId: HUMAN_OWNER_ID,
      }),
    ).resolves.toEqual({ blocks: [] });

    // …while the correct HUMAN owner does.
    const result = await listMemberBlocks(deps, {
      actorHumanId: MEMBER_ID,
      ownerType: "HUMAN",
      ownerId: HUMAN_OWNER_ID,
    });
    expect(result.blocks.map((b) => b.id)).toEqual(["b-members"]);
  });

  it("returns EMPTY when the owner has no page, or a PRIVATE one", async () => {
    const noPage = makeDeps({ page: null });
    await expect(listMemberBlocks(noPage.deps, baseInput())).resolves.toEqual({
      blocks: [],
    });

    const privatePage = makeDeps({
      page: { id: PAGE_ID, visibility: "PRIVATE" },
    });
    await expect(
      listMemberBlocks(privatePage.deps, baseInput()),
    ).resolves.toEqual({ blocks: [] });
    expect(privatePage.listBlocks).not.toHaveBeenCalled();
  });

  it("rejects invalid input (strict schema)", async () => {
    const { deps } = makeDeps();

    await expect(
      listMemberBlocks(deps, { ...baseInput(), extra: "nope" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      listMemberBlocks(deps, { ...baseInput(), ownerType: "PLACE" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
