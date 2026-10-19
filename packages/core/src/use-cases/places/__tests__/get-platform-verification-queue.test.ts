import { describe, expect, it, vi } from "vitest";

import { getPlatformVerificationQueue } from "../get-platform-verification-queue";
import type { GetPlatformVerificationQueueDeps } from "../get-platform-verification-queue";
import type { VerificationQueueItem } from "@th/types/repos/place-verification";

const BASE_DATE = new Date("2024-02-01T00:00:00.000Z");
const DEFAULT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const DEFAULT_PLACE_ID = "33333333-3333-4333-8333-333333333333";
const DEFAULT_ORG_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_SUBMITTER_ID = "55555555-5555-4555-8555-555555555555";

function buildQueueItem(
  overrides: {
    place?: Partial<VerificationQueueItem["place"]>;
    request?: Partial<VerificationQueueItem["request"]>;
    ownerCount?: number;
    documentCount?: number;
  } = {},
): VerificationQueueItem {
  return {
    request: {
      id: DEFAULT_REQUEST_ID,
      placeId: DEFAULT_PLACE_ID,
      orgId: DEFAULT_ORG_ID,
      submittedById: DEFAULT_SUBMITTER_ID,
      status: "PENDING",
      source: "ORG_SUBMISSION",
      claimantHumanId: null,
      claimOwnerType: null,
      claimOwnerId: null,
      ownershipId: null,
      reviewerNotes: null,
      reviewerHumanId: null,
      reviewedAt: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      createdAt: BASE_DATE,
      updatedAt: BASE_DATE,
      ...overrides.request,
    },
    place: {
      id: DEFAULT_PLACE_ID,
      name: "The Basement",
      slug: "the-basement",
      formattedAddress: "1604 8th Ave S, Nashville, TN",
      city: "Nashville",
      region: "TN",
      countryCode: "US",
      capacity: 250,
      website: "https://thebasementnashville.com",
      phone: "+1-615-555-0100",
      ...overrides.place,
    },
    submitter: { humanId: DEFAULT_SUBMITTER_ID, displayName: "Jane Owner" },
    reviewer: null,
    acknowledger: null,
    documentCount: overrides.documentCount ?? 2,
    ownerCount: overrides.ownerCount ?? 1,
  };
}

function buildDeps(
  overrides: {
    items?: VerificationQueueItem[];
    total?: number;
    staffAllowed?: boolean;
  } = {},
) {
  const items = overrides.items ?? [buildQueueItem()];
  const total = overrides.total ?? items.length;

  const requestsRepo = {
    listQueue: vi.fn(async () => ({ items, total })),
    getQueueStats: vi.fn(async () => ({
      pending: 1,
      inReview: 0,
      reviewedThisMonth: 3,
      oldestPendingAgeMs: 1000,
    })),
  };

  const authz = {
    hasStaffRole: vi.fn(async () => ({
      allowed: overrides.staffAllowed ?? true,
      roles: overrides.staffAllowed === false ? [] : ["ADMIN"],
    })),
  };

  const deps: GetPlatformVerificationQueueDeps = {
    repos: { placeVerificationRequests: requestsRepo } as any,
    authz: authz as any,
  };

  return { deps, requestsRepo, authz };
}

describe("getPlatformVerificationQueue", () => {
  it("surfaces owner/contact context on each queue item", async () => {
    const { deps } = buildDeps();

    const result = await getPlatformVerificationQueue(deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
    });

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.ownerCount).toBe(1);
    expect(item.placeWebsite).toBe("https://thebasementnashville.com");
    expect(item.placePhone).toBe("+1-615-555-0100");
    // Existing fields remain intact.
    expect(item.placeName).toBe("The Basement");
    expect(item.documentCount).toBe(2);
  });

  it("passes through null contact fields and zero owner count", async () => {
    const { deps } = buildDeps({
      items: [
        buildQueueItem({
          place: { website: null, phone: null },
          ownerCount: 0,
        }),
      ],
    });

    const result = await getPlatformVerificationQueue(deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
    });

    const item = result.items[0];
    expect(item.placeWebsite).toBeNull();
    expect(item.placePhone).toBeNull();
    expect(item.ownerCount).toBe(0);
  });

  it("flows an OWNERSHIP_CLAIM row with orgId:null through .parse() and maps claim fields", async () => {
    // Regression: a HUMAN ownership claim has orgId:null (+ claim provenance).
    // The output schema previously required a non-null orgId and crashed .parse().
    const CLAIMANT = "77777777-7777-4777-8777-777777777777";
    const { deps } = buildDeps({
      items: [
        buildQueueItem({
          request: {
            orgId: null,
            source: "OWNERSHIP_CLAIM",
            claimantHumanId: CLAIMANT,
            claimOwnerType: "HUMAN",
            claimOwnerId: CLAIMANT,
            ownershipId: "88888888-8888-4888-8888-888888888888",
          },
        }),
      ],
    });

    const result = await getPlatformVerificationQueue(deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
    });

    const item = result.items[0];
    expect(item.source).toBe("OWNERSHIP_CLAIM");
    expect(item.orgId).toBeNull();
    expect(item.claimantHumanId).toBe(CLAIMANT);
    expect(item.claimOwnerType).toBe("HUMAN");
  });

  it("throws STAFF_ONLY when the actor lacks a staff role", async () => {
    const { deps, requestsRepo } = buildDeps({ staffAllowed: false });

    await expect(
      getPlatformVerificationQueue(deps, { actorHumanId: DEFAULT_ACTOR_ID }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(requestsRepo.listQueue).not.toHaveBeenCalled();
  });
});
