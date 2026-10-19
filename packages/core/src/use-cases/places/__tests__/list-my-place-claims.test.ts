import { describe, expect, it, vi } from "vitest";

import {
  listMyPlaceClaims,
  type ListMyPlaceClaimsDeps,
} from "../list-my-place-claims";
import type { ClaimantPlaceClaimItem } from "@th/types/repos/place-verification";

const BASE_DATE = new Date("2026-07-01T00:00:00.000Z");
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

function buildItem(
  overrides: Partial<ClaimantPlaceClaimItem> = {},
): ClaimantPlaceClaimItem {
  return {
    requestId: REQUEST_ID,
    placeId: PLACE_ID,
    placeName: "The Basement East",
    // A venue's ONE routable slug: the flat `EntityPage.slug`.
    placePageSlug: "the-basement-east-a1b2c3d4",
    placePageVisibility: "PUBLIC",
    source: "OWNERSHIP_CLAIM",
    status: "PENDING",
    ownerType: "HUMAN",
    ownerId: ACTOR_ID,
    createdAt: BASE_DATE,
    reviewedAt: null,
    reviewerNotes: null,
    ...overrides,
  };
}

function buildDeps(
  overrides: {
    items?: ClaimantPlaceClaimItem[];
    nextCursor?: string | null;
  } = {},
) {
  const listByClaimant = vi.fn(async () => ({
    items: overrides.items ?? [buildItem()],
    nextCursor: "nextCursor" in overrides ? overrides.nextCursor! : "cursor-2",
  }));

  const deps: ListMyPlaceClaimsDeps = {
    repos: {
      placeVerificationRequests: { listByClaimant },
    } as unknown as ListMyPlaceClaimsDeps["repos"],
  };

  return { deps, listByClaimant };
}

describe("listMyPlaceClaims", () => {
  it("queries listByClaimant with the actor's id + cursor/limit", async () => {
    const { deps, listByClaimant } = buildDeps();

    await listMyPlaceClaims(deps, {
      actorHumanId: ACTOR_ID,
      cursor: "cursor-1",
      limit: 5,
    });

    expect(listByClaimant).toHaveBeenCalledWith({
      claimantHumanId: ACTOR_ID,
      cursor: "cursor-1",
      limit: 5,
    });
  });

  it("defaults limit to 20 and cursor to null when omitted", async () => {
    const { deps, listByClaimant } = buildDeps();

    await listMyPlaceClaims(deps, { actorHumanId: ACTOR_ID });

    expect(listByClaimant).toHaveBeenCalledWith({
      claimantHumanId: ACTOR_ID,
      cursor: null,
      limit: 20,
    });
  });

  it("rejects input missing an actorHumanId", async () => {
    const { deps, listByClaimant } = buildDeps();

    await expect(listMyPlaceClaims(deps, {})).rejects.toThrow();
    expect(listByClaimant).not.toHaveBeenCalled();
  });

  it("rejects unknown input keys (client-supplied claimant id is impossible)", async () => {
    const { deps, listByClaimant } = buildDeps();

    await expect(
      listMyPlaceClaims(deps, {
        actorHumanId: ACTOR_ID,
        claimantHumanId: "99999999-9999-4999-8999-999999999999",
      }),
    ).rejects.toThrow();
    expect(listByClaimant).not.toHaveBeenCalled();
  });

  it("maps rows to the output contract (claims + disputes, all statuses) and passes through nextCursor", async () => {
    // Inject admin-identity extras a buggy repo could leak: the use case's
    // explicit field mapping (+ strict output parse) must DROP them. Without
    // this injection the leak assertions below would only re-assert the
    // fixture's own shape.
    const pendingClaim = {
      ...buildItem({
        requestId: "00000000-0000-4000-8000-0000000000b1",
        status: "PENDING",
      }),
      reviewerHumanId: "admin-1",
      acknowledgedBy: "admin-2",
    } as unknown as ClaimantPlaceClaimItem;
    const approvedDispute = {
      ...buildItem({
        requestId: "00000000-0000-4000-8000-0000000000b2",
        source: "OWNERSHIP_DISPUTE",
        status: "APPROVED",
        ownerType: "ORGANIZATION",
        ownerId: "22222222-2222-4222-8222-222222222222",
        reviewedAt: new Date("2026-07-02T00:00:00.000Z"),
        reviewerNotes: "Ownership documents verified",
      }),
      reviewerHumanId: "admin-1",
    } as unknown as ClaimantPlaceClaimItem;
    const rejectedClaim = buildItem({
      requestId: "00000000-0000-4000-8000-0000000000b3",
      status: "REJECTED",
      reviewedAt: new Date("2026-07-03T00:00:00.000Z"),
      reviewerNotes: "Insufficient proof",
      placePageSlug: null,
      placePageVisibility: null,
    });

    const { deps } = buildDeps({
      items: [pendingClaim, approvedDispute, rejectedClaim],
      nextCursor: "cursor-9",
    });

    const result = await listMyPlaceClaims(deps, { actorHumanId: ACTOR_ID });

    expect(result.nextCursor).toBe("cursor-9");
    expect(result.items).toHaveLength(3);

    expect(result.items[0]).toEqual({
      requestId: pendingClaim.requestId,
      placeId: PLACE_ID,
      placeName: "The Basement East",
      placePageSlug: "the-basement-east-a1b2c3d4",
      source: "OWNERSHIP_CLAIM",
      status: "PENDING",
      ownerType: "HUMAN",
      ownerId: ACTOR_ID,
      createdAt: BASE_DATE,
      reviewedAt: null,
      reviewerNotes: null,
    });

    expect(result.items[1]).toMatchObject({
      source: "OWNERSHIP_DISPUTE",
      status: "APPROVED",
      ownerType: "ORGANIZATION",
      reviewedAt: approvedDispute.reviewedAt,
      reviewerNotes: "Ownership documents verified",
    });

    expect(result.items[2]).toMatchObject({
      status: "REJECTED",
      // A venue with no entity page has NO public URL; the UI must fall back
      // to `/places/id/{placeId}` rather than emit `/p/<directory key>`.
      placePageSlug: null,
      reviewerNotes: "Insufficient proof",
    });

    // Admin identity is never leaked in the claimant-facing contract, even
    // when the repo row carries it (injected above).
    expect(result.items[0]).not.toHaveProperty("reviewerHumanId");
    expect(result.items[0]).not.toHaveProperty("acknowledgedBy");
    expect(result.items[1]).not.toHaveProperty("reviewerHumanId");
  });

  it("passes through a null nextCursor on the last page", async () => {
    const { deps } = buildDeps({ nextCursor: null });

    const result = await listMyPlaceClaims(deps, { actorHumanId: ACTOR_ID });

    expect(result.nextCursor).toBeNull();
  });

  // The claims list links each venue to `/p/{slug}`, which resolves ONLY on
  // `EntityPage.slug`. It used to carry a second `placeSlug` field holding
  // `Place.slug` — the multi-segment directory key — and linked THAT, so every
  // row pointed at a 404. The column is deprecated and the field is gone.
  it("carries the entity-page slug, and no second slug to link off by mistake", async () => {
    const { deps } = buildDeps({
      items: [
        {
          ...buildItem({
            placePageSlug: "the-chapel-0f1e2d3c",
            placePageVisibility: "PUBLIC",
          }),
          // A stale repo row still carrying the directory key. It must not
          // survive the projection.
          placeSlug: "us/ca/the-chapel--0f1e2d3c4b",
        } as unknown as ClaimantPlaceClaimItem,
      ],
    });

    const result = await listMyPlaceClaims(deps, { actorHumanId: ACTOR_ID });

    expect(result.items[0]!.placePageSlug).toBe("the-chapel-0f1e2d3c");
    expect(result.items[0]).not.toHaveProperty("placeSlug");
    // `/p/[slug]` is a single non-catch-all segment — a `/` here is proof a
    // directory key leaked back into the link.
    expect(result.items[0]!.placePageSlug).not.toContain("/");
  });
  // ── EntityPage.visibility ────────────────────────────────────────────────
  //
  // This list is the claimant's OWN authenticated view and IS the link, so the
  // gate here is deliberately looser than the sitemap's: UNLISTED ("only
  // people with the link can open it") is exactly what this surface is, and is
  // kept. PRIVATE keeps its slug in the database while `/p/{slug}` 404s for
  // everyone, so it must degrade to the `/places/id/{placeId}` fallback.
  it("KEEPS an UNLISTED venue page — this list is the link that level is for", async () => {
    const { deps } = buildDeps({
      items: [
        buildItem({
          placePageSlug: "the-chapel-0f1e2d3c",
          placePageVisibility: "UNLISTED",
        }),
      ],
    });

    const result = await listMyPlaceClaims(deps, { actorHumanId: ACTOR_ID });

    expect(result.items[0]!.placePageSlug).toBe("the-chapel-0f1e2d3c");
  });

  it("DROPS a PRIVATE venue page's slug — it resolves to a 404 for everyone", async () => {
    const { deps } = buildDeps({
      items: [
        buildItem({
          // The slug still exists on the row; that is the trap.
          placePageSlug: "the-chapel-0f1e2d3c",
          placePageVisibility: "PRIVATE",
        }),
      ],
    });

    const result = await listMyPlaceClaims(deps, { actorHumanId: ACTOR_ID });

    expect(result.items[0]!.placePageSlug).toBeNull();
    // And never a substitute — the directory key is not a URL either.
    expect(JSON.stringify(result.items[0])).not.toContain(
      "the-chapel-0f1e2d3c",
    );
  });
});
