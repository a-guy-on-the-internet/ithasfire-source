/**
 * getMyPage for a community moderator on a PLACE nobody owns (moderator
 * place page spec, FR-001..FR-004, D2/D4/D5): the editor read passes, and
 * its first-load template seed is a write like any other, under the claim
 * lock, re-checked, audited.
 */

import { describe, expect, it, vi } from "vitest";

import { fail } from "@th/errors";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { ENTITY_PAGE_COMMUNITY_UPDATED_ACTION } from "../entity-page-access";
import { getMyPage } from "../get-my-page";
import { getTemplateRevision, templateAppliedMarker } from "../page-templates";
import {
  HUMAN_A,
  HUMAN_B,
  NOW,
  OUTSIDER,
  PAGE_ID,
  PLACE_ID,
  makeHarness,
  pageRecord,
  type Harness,
} from "./page-draft-harness";

const MODERATOR = "human-moderator";

/**
 * The harness, plus the read-side repos getMyPage's PLACE summary uses, and
 * a template seed that adds the candidates the page lacks (the adapter's
 * contract, as get-my-page.test.ts fakes it).
 */
function setup(options: { unowned?: boolean; seeded?: boolean } = {}) {
  const h = makeHarness({ moderators: [MODERATOR], blocks: [] });
  if (options.unowned ?? true) {
    h.setPlace({
      orgIdsWithAccess: [],
      humanIdsWithAccess: [],
      verificationStatus: "UNVERIFIED",
    });
  }
  h.setPage(
    pageRecord({
      templateAppliedCategories: options.seeded
        ? [templateAppliedMarker("venue", getTemplateRevision("PLACE", "venue"))]
        : [],
    }),
  );
  let seq = 0;
  h.entityPages.applyTemplateSeed.mockImplementation(
    async (input: {
      pageId: string;
      blocks: { kind: string; data: unknown; visible: boolean }[];
    }) => {
      const existing = h.blocks();
      const created: PageBlockRecord[] = input.blocks.map((candidate, i) => ({
        id: `seeded-${seq++}`,
        pageId: input.pageId,
        kind: candidate.kind,
        orderIndex: existing.length + i,
        data: (candidate.data ?? {}) as Record<string, unknown>,
        visible: candidate.visible,
        section: "main",
      }));
      h.setBlocks([...existing, ...created]);
      return created;
    },
  );
  const places = {
    ...h.places,
    getVerifiedOwnershipForPlace: vi.fn(async () => null),
  };
  const repos = {
    ...(h.repos as unknown as Record<string, unknown>),
    places,
    announcements: {
      listByOrg: vi.fn(async () => ({ items: [], total: 0 })),
      listBySender: vi.fn(async () => ({ items: [], total: 0 })),
    },
    organizations: { getById: vi.fn(async () => null) },
    calendars: { countAvailabilityForPlace: vi.fn(async () => 1) },
    performerProfiles: { getByOwner: vi.fn(async () => null) },
    eventHumans: { listPerformancesByHuman: vi.fn(async () => []) },
    humanStats: { findByHumanId: vi.fn(async () => null) },
    placeVerificationRequests: {
      getActiveClaimForPlace: vi.fn(async () => null),
    },
  };
  const reportError = vi.fn();
  const deps = {
    repos,
    authz: h.authz,
    clock: h.clock,
    logger: h.logger,
    reportError,
  };
  return { h, deps, reportError };
}

function run(deps: unknown, actor: string) {
  return getMyPage(deps as never, {
    actorHumanId: actor,
    ownerType: "PLACE",
    ownerId: PLACE_ID,
  });
}

function communityAudits(h: Harness) {
  return h
    .audits()
    .filter((entry) => entry.action === ENTITY_PAGE_COMMUNITY_UPDATED_ACTION);
}

describe("getMyPage: community moderator on a PLACE page", () => {
  it("opens an unowned place's editor and seeds the template under the claim lock, audited", async () => {
    const { h, deps, reportError } = setup();
    const result = await run(deps, MODERATOR);

    expect(result.page.id).toBe(PAGE_ID);
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(reportError).not.toHaveBeenCalled();
    expect(h.claimLocks()).toEqual([`claim:${PLACE_ID}`]);
    const seeded = h.blocks();
    expect(communityAudits(h)).toEqual([
      {
        entity: "entity_page",
        entityId: PAGE_ID,
        action: ENTITY_PAGE_COMMUNITY_UPDATED_ACTION,
        data: {
          actorHumanId: MODERATOR,
          placeId: PLACE_ID,
          pageId: PAGE_ID,
          op: "seedTemplate",
          fields: seeded.map((b) => `blocks.${b.id}`).sort(),
          from: null,
          to: {
            category: "venue",
            blocks: seeded.map((b) => ({ blockId: b.id, kind: b.kind })),
          },
        },
        at: NOW,
      },
    ]);
  });

  it("a page already seeded: no lock, no audit row (nothing written)", async () => {
    const { h, deps } = setup({ seeded: true });
    await run(deps, MODERATOR);
    expect(h.claimLocks()).toEqual([]);
    expect(h.audits()).toEqual([]);
  });

  it("is NOT refused by an organiser's live event at the place", async () => {
    const { h, deps } = setup();
    h.setOwnedLiveEventsAtPlace(true);
    await expect(run(deps, MODERATOR)).resolves.toMatchObject({
      page: { id: PAGE_ID },
    });
  });

  it("refuses PLACE_HAS_OWNER (OWNED) on an owned place", async () => {
    const { h, deps } = setup({ unowned: false });
    await expect(run(deps, MODERATOR)).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
      meta: { reason: "OWNED" },
    });
    expect(h.entityPages.applyTemplateSeed).not.toHaveBeenCalled();
  });

  it("refuses PLACE_HAS_OWNER (CLAIM_PENDING) while a claim is in review", async () => {
    const { h, deps } = setup();
    h.setOwnerships([{ id: "own-1", humanId: HUMAN_B, verified: false }]);
    await expect(run(deps, MODERATOR)).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
      meta: { reason: "CLAIM_PENDING" },
    });
  });

  it("refuses PLACE_ARCHIVED / PLACE_NOT_ACTIVE", async () => {
    const archived = setup();
    archived.h.setPlace({ status: "ARCHIVED" });
    await expect(run(archived.deps, MODERATOR)).rejects.toMatchObject({
      code: "PLACE_ARCHIVED",
    });
    const suspended = setup();
    suspended.h.setPlace({ status: "SUSPENDED" });
    await expect(run(suspended.deps, MODERATOR)).rejects.toMatchObject({
      code: "PLACE_NOT_ACTIVE",
    });
  });

  it("a claim landing before the seed's lock refuses the read and seeds nothing (D4), not a swallowed seed failure", async () => {
    const { h, deps, reportError } = setup();
    h.onClaimLock(() =>
      h.setOwnerships([{ id: "own-1", humanId: HUMAN_B, verified: true }]),
    );
    await expect(run(deps, MODERATOR)).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
      meta: { reason: "OWNED" },
    });
    expect(h.entityPages.applyTemplateSeed).not.toHaveBeenCalled();
    expect(h.blocks()).toEqual([]);
    expect(h.audits()).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a moderator's seed failure that is NOT a refusal (BLOCK_PINNED) is still swallowed and reported", async () => {
    const { h, deps, reportError } = setup();
    // `fail` throws: the seed's adapter call rejects with BLOCK_PINNED.
    h.entityPages.applyTemplateSeed.mockImplementationOnce(async () =>
      fail("BLOCK_PINNED", { meta: { kind: "track_record" } }),
    );
    const result = await run(deps, MODERATOR);
    expect(result.page.id).toBe(PAGE_ID);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "BLOCK_PINNED" }),
      expect.objectContaining({
        tags: { useCase: "getMyPage", step: "templateSeed" },
      }),
    );
    // The seed's transaction rolled back: no audit row.
    expect(h.audits()).toEqual([]);
  });

  it("refuses a non-staff outsider NOT_RESOURCE_OWNER", async () => {
    const { h, deps } = setup();
    await expect(run(deps, OUTSIDER)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
      meta: { entity: "place" },
    });
    expect(h.claimLocks()).toEqual([]);
  });

  it("the owner's first load seeds with no claim lock and no audit row", async () => {
    const { h, deps } = setup({ unowned: false });
    await run(deps, HUMAN_A);
    expect(h.entityPages.applyTemplateSeed).toHaveBeenCalledTimes(1);
    expect(h.claimLocks()).toEqual([]);
    expect(h.audits()).toEqual([]);
    expect(h.authz.hasStaffRole).not.toHaveBeenCalled();
  });

  it("refuses a moderator on a HUMAN page exactly as before (R3)", async () => {
    const { h, deps } = setup();
    await expect(
      getMyPage(deps as never, {
        actorHumanId: MODERATOR,
        ownerType: "HUMAN",
        ownerId: HUMAN_A,
      }),
    ).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
      meta: { entity: "page" },
    });
    expect(h.authz.hasStaffRole).not.toHaveBeenCalled();
  });
});
