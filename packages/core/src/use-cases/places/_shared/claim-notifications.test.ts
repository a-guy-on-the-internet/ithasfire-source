import { describe, expect, it, vi } from "vitest";

import type { CreateNotificationInput } from "@th/ports/repos/notifications";

import {
  notifyAdminsOfClaim,
  notifyClaimantOfDecision,
  notifyDisputantOfDecision,
  notifyOwnerOfDispute,
  notifyOwnerOfOwnershipTransfer,
  type ClaimNotificationDeps,
} from "./claim-notifications";

const PLACE_ID = "a2000000-0000-4000-8000-000000000002";
const REQUEST_ID = "a3000000-0000-4000-8000-000000000003";
const HUMAN_ID = "a6000000-0000-4000-8000-000000000006";
const ADMIN_ID = "a7000000-0000-4000-8000-000000000007";

function makeDeps(overrides?: Partial<ClaimNotificationDeps>) {
  const create = vi
    .fn<[CreateNotificationInput], Promise<{ id: string; createdAt: Date }>>()
    .mockResolvedValue({ id: "n1", createdAt: new Date() });
  const reportError = vi.fn();
  const warn = vi.fn();
  const deps = {
    repos: {
      notifications: { create },
      authz: {
        listHumanIdsByStaffRole: vi.fn().mockResolvedValue([ADMIN_ID]),
      },
    },
    logger: { warn } as unknown as ClaimNotificationDeps["logger"],
    reportError,
    ...overrides,
  } as unknown as ClaimNotificationDeps;
  return { deps, create, reportError, warn };
}

/** The one row a single-recipient loop wrote. */
function onlyRow(create: ReturnType<typeof makeDeps>["create"]) {
  expect(create).toHaveBeenCalledTimes(1);
  return create.mock.calls[0]![0];
}

/**
 * The stored English and everything else about each row is pinned exactly as
 * it was before the rows carried a template; the template and
 * metadata.variant are the only additions.
 */
describe("claim notifications — stored rows", () => {
  it("notifyAdminsOfClaim (claim)", async () => {
    const { deps, create } = makeDeps();
    await notifyAdminsOfClaim(deps, {
      placeId: PLACE_ID,
      placeName: "The Corner Stage",
      requestId: REQUEST_ID,
      source: "OWNERSHIP_CLAIM",
    });
    expect(onlyRow(create)).toEqual({
      humanId: ADMIN_ID,
      title: "New place ownership claim",
      body: 'Someone claimed "The Corner Stage" and is awaiting review.',
      kind: "INFO",
      metadata: {
        placeId: PLACE_ID,
        requestId: REQUEST_ID,
        source: "OWNERSHIP_CLAIM",
        variant: "place.claim-received",
      },
      tags: ["place", "claim"],
      action: { label: "Review claim", route: "/admin/verifications" },
      template: {
        key: "place.claim-received",
        version: "1",
        variables: {
          placeId: PLACE_ID,
          placeName: "The Corner Stage",
          requestId: REQUEST_ID,
          source: "OWNERSHIP_CLAIM",
        },
      },
    });
  });

  it("notifyAdminsOfClaim (dispute)", async () => {
    const { deps, create } = makeDeps();
    await notifyAdminsOfClaim(deps, {
      placeId: PLACE_ID,
      placeName: "The Corner Stage",
      requestId: REQUEST_ID,
      source: "OWNERSHIP_DISPUTE",
    });
    const row = onlyRow(create);
    expect(row.title).toBe("New place ownership dispute");
    expect(row.body).toBe(
      'A dispute was filed against the verified owner of "The Corner Stage".',
    );
    expect(row.action).toEqual({
      label: "Review claim",
      route: "/admin/verifications",
    });
    expect(row.template?.key).toBe("place.claim-received");
  });

  it("notifyClaimantOfDecision (approved)", async () => {
    const { deps, create } = makeDeps();
    await notifyClaimantOfDecision(deps, {
      claimantHumanId: HUMAN_ID,
      placeId: PLACE_ID,
      placeName: "The Corner Stage",
      decision: "APPROVED",
      reviewerNotes: "ignored when approved",
    });
    expect(onlyRow(create)).toEqual({
      humanId: HUMAN_ID,
      title: "Place claim approved",
      body: 'Your claim on "The Corner Stage" was approved — you now own this place.',
      kind: "SUCCESS",
      metadata: {
        placeId: PLACE_ID,
        decision: "APPROVED",
        variant: "place.claim-decided",
      },
      tags: ["place", "claim"],
      action: { label: "View place", route: `/places/id/${PLACE_ID}` },
      template: {
        key: "place.claim-decided",
        version: "1",
        variables: {
          placeId: PLACE_ID,
          placeName: "The Corner Stage",
          decision: "APPROVED",
          reviewerNotes: "ignored when approved",
        },
      },
    });
  });

  it("notifyClaimantOfDecision (rejected, with a note)", async () => {
    const { deps, create } = makeDeps();
    await notifyClaimantOfDecision(deps, {
      claimantHumanId: HUMAN_ID,
      placeId: PLACE_ID,
      placeName: "The Corner Stage",
      decision: "REJECTED",
      reviewerNotes: "Proof didn't match.",
    });
    const row = onlyRow(create);
    expect(row.title).toBe("Place claim declined");
    expect(row.body).toBe(
      'Your claim on "The Corner Stage" was not approved. Reviewer note: Proof didn\'t match.',
    );
    expect(row.kind).toBe("INFO");
    expect(row.action).toEqual({
      label: "View place",
      route: `/places/id/${PLACE_ID}`,
    });
  });

  it("notifyClaimantOfDecision (rejected, no note)", async () => {
    const { deps, create } = makeDeps();
    await notifyClaimantOfDecision(deps, {
      claimantHumanId: HUMAN_ID,
      placeId: PLACE_ID,
      placeName: "The Corner Stage",
      decision: "REJECTED",
      reviewerNotes: null,
    });
    expect(onlyRow(create).body).toBe(
      'Your claim on "The Corner Stage" was not approved.',
    );
  });

  it("notifyDisputantOfDecision (approved)", async () => {
    const { deps, create } = makeDeps();
    await notifyDisputantOfDecision(deps, {
      disputantHumanId: HUMAN_ID,
      placeId: PLACE_ID,
      placeName: "The Corner Stage",
      decision: "APPROVED",
      reviewerNotes: null,
    });
    expect(onlyRow(create)).toEqual({
      humanId: HUMAN_ID,
      title: "Ownership dispute approved",
      body: 'Your ownership dispute on "The Corner Stage" was approved — you now own this place.',
      kind: "SUCCESS",
      metadata: {
        placeId: PLACE_ID,
        decision: "APPROVED",
        variant: "place.dispute-decided",
      },
      tags: ["place", "dispute"],
      action: { label: "View place", route: `/places/id/${PLACE_ID}` },
      template: {
        key: "place.dispute-decided",
        version: "1",
        variables: {
          placeId: PLACE_ID,
          placeName: "The Corner Stage",
          decision: "APPROVED",
          reviewerNotes: null,
        },
      },
    });
  });

  it("notifyDisputantOfDecision (rejected, with a note)", async () => {
    const { deps, create } = makeDeps();
    await notifyDisputantOfDecision(deps, {
      disputantHumanId: HUMAN_ID,
      placeId: PLACE_ID,
      placeName: "The Corner Stage",
      decision: "REJECTED",
      reviewerNotes: "Lease expired.",
    });
    const row = onlyRow(create);
    expect(row.title).toBe("Ownership dispute declined");
    expect(row.body).toBe(
      'Your ownership dispute on "The Corner Stage" was not approved. Reviewer note: Lease expired.',
    );
    expect(row.kind).toBe("INFO");
  });

  it("notifyOwnerOfOwnershipTransfer", async () => {
    const { deps, create } = makeDeps();
    await notifyOwnerOfOwnershipTransfer(deps, {
      ownerHumanId: HUMAN_ID,
      placeId: PLACE_ID,
      placeName: "The Corner Stage",
      requestId: REQUEST_ID,
    });
    expect(onlyRow(create)).toEqual({
      humanId: HUMAN_ID,
      title: "Place ownership transferred",
      body: 'Following an ownership dispute review, your ownership of "The Corner Stage" was transferred to another party.',
      kind: "WARNING",
      metadata: {
        placeId: PLACE_ID,
        requestId: REQUEST_ID,
        variant: "place.ownership-transferred",
      },
      tags: ["place", "dispute"],
      action: { label: "View place", route: `/places/id/${PLACE_ID}` },
      template: {
        key: "place.ownership-transferred",
        version: "1",
        variables: {
          placeId: PLACE_ID,
          placeName: "The Corner Stage",
          requestId: REQUEST_ID,
        },
      },
    });
  });

  it("notifyOwnerOfDispute", async () => {
    const { deps, create } = makeDeps();
    await notifyOwnerOfDispute(deps, {
      ownerHumanId: HUMAN_ID,
      placeId: PLACE_ID,
      placeName: "The Corner Stage",
      requestId: REQUEST_ID,
    });
    expect(onlyRow(create)).toEqual({
      humanId: HUMAN_ID,
      title: "Ownership dispute filed",
      body: 'Someone filed a dispute contesting your ownership of "The Corner Stage". A platform admin will review it.',
      kind: "WARNING",
      metadata: {
        placeId: PLACE_ID,
        requestId: REQUEST_ID,
        variant: "place.dispute-filed",
      },
      tags: ["place", "dispute"],
      action: { label: "View place", route: `/places/id/${PLACE_ID}` },
      template: {
        key: "place.dispute-filed",
        version: "1",
        variables: {
          placeId: PLACE_ID,
          placeName: "The Corner Stage",
          requestId: REQUEST_ID,
        },
      },
    });
  });
});

describe("claim notifications — template not stored", () => {
  it("still writes the English row, warns and reports (guarded)", async () => {
    const { deps, create, reportError, warn } = makeDeps();
    reportError.mockImplementation(() => {
      throw new Error("reporter down");
    });
    await notifyOwnerOfDispute(deps, {
      ownerHumanId: HUMAN_ID,
      placeId: PLACE_ID,
      // Pushes the serialized payload past IN_APP_TEMPLATE_MAX_CHARS.
      placeName: "x".repeat(20_000),
      requestId: REQUEST_ID,
    });
    const row = onlyRow(create);
    expect(row.title).toBe("Ownership dispute filed");
    expect(row.template).toBeUndefined();
    expect(row.metadata?.variant).toBe("place.dispute-filed");
    expect(warn).toHaveBeenCalledWith(
      "comms.direct_in_app.template_skipped",
      expect.objectContaining({
        variant: "place.dispute-filed",
        reason: "oversized",
      }),
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { variant: "place.dispute-filed", reason: "oversized" },
    });
  });
});

describe("claim notifications — best effort", () => {
  it("a failed write is swallowed, warned and reported", async () => {
    const { deps, create, reportError, warn } = makeDeps();
    const boom = new Error("db down");
    create.mockRejectedValueOnce(boom);
    await expect(
      notifyClaimantOfDecision(deps, {
        claimantHumanId: HUMAN_ID,
        placeId: PLACE_ID,
        placeName: "The Corner Stage",
        decision: "APPROVED",
        reviewerNotes: null,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "claim.in_app_failed",
      expect.objectContaining({ humanId: HUMAN_ID }),
    );
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "places.claimNotifications" },
      extra: { humanId: HUMAN_ID },
    });
  });

  it("a payload the variant rejects never fails the caller", async () => {
    const { deps, create, reportError } = makeDeps();
    await expect(
      notifyClaimantOfDecision(deps, {
        claimantHumanId: HUMAN_ID,
        placeId: PLACE_ID,
        placeName: "The Corner Stage",
        decision: "MAYBE" as unknown as "APPROVED",
        reviewerNotes: null,
      }),
    ).resolves.toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
