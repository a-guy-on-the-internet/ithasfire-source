import { describe, expect, it, vi } from "vitest";

import type { Dispute } from "@prisma/client";
import { makeDisputesRepo } from "../disputes";
import type { PrismaClientOrTx } from "../types";

const NOW = new Date("2026-05-15T12:00:00.000Z");

describe("makeDisputesRepo", () => {
  it("upserts disputes by Stripe dispute id and maps repo DTOs", async () => {
    const { prisma, upsert } = createPrisma();
    const repo = makeDisputesRepo(prisma);
    const row = buildDisputeRow({ orderId: "order-1", status: "OPEN" });
    upsert.mockResolvedValueOnce(row);

    const result = await repo.upsertFromStripe({
      stripeDisputeId: "dp_123",
      stripeChargeId: "ch_123",
      paymentIntentId: "pi_123",
      orderId: "order-1",
      ownerSubjectType: "ORGANIZATION",
      ownerSubjectId: "org-1",
      ownerOrgId: "org-1",
      amountCents: 5_000,
      currency: "usd",
      reason: "fraudulent",
      status: "OPEN",
      triageReason: null,
      linkedAt: NOW,
      evidenceDueBy: NOW,
      metadata: { stripeEventType: "charge.dispute.created" },
    });

    expect(upsert).toHaveBeenCalledWith({
      where: { stripeDisputeId: "dp_123" },
      create: expect.objectContaining({
        stripeDisputeId: "dp_123",
        stripeChargeId: "ch_123",
        paymentIntentId: "pi_123",
        orderId: "order-1",
        ownerSubjectType: "ORGANIZATION",
        ownerSubjectId: "org-1",
        ownerOrgId: "org-1",
        amountCents: 5_000,
        currency: "usd",
        status: "OPEN",
      }),
      update: expect.objectContaining({
        stripeChargeId: "ch_123",
        paymentIntentId: "pi_123",
        orderId: "order-1",
        ownerSubjectType: "ORGANIZATION",
        ownerSubjectId: "org-1",
        ownerOrgId: "org-1",
        amountCents: 5_000,
        currency: "usd",
        status: "OPEN",
      }),
    });
    expect(result).toMatchObject({
      id: row.id,
      stripeDisputeId: "dp_123",
      orderId: "order-1",
      status: "OPEN",
      metadata: row.metadata,
    });
  });

  it("does not clear existing optional links when omitted from an update", async () => {
    const { prisma, upsert } = createPrisma();
    const repo = makeDisputesRepo(prisma);
    upsert.mockResolvedValueOnce(buildDisputeRow({ status: "UNDER_REVIEW" }));

    await repo.upsertFromStripe({
      stripeDisputeId: "dp_123",
      amountCents: 5_000,
      currency: "usd",
      reason: "fraudulent",
      status: "UNDER_REVIEW",
    });

    expect(upsert.mock.calls[0]?.[0].update).toMatchObject({
      amountCents: 5_000,
      currency: "usd",
      reason: "fraudulent",
      status: "UNDER_REVIEW",
    });
    expect(upsert.mock.calls[0]?.[0].update.orderId).toBeUndefined();
    expect(upsert.mock.calls[0]?.[0].update.ownerSubjectType).toBeUndefined();
    expect(upsert.mock.calls[0]?.[0].update.ownerSubjectId).toBeUndefined();
  });

  it("finds disputes by Stripe dispute id", async () => {
    const { prisma, findUnique } = createPrisma();
    const repo = makeDisputesRepo(prisma);
    findUnique.mockResolvedValueOnce(buildDisputeRow({ status: "LOST" }));

    const result = await repo.findByStripeDisputeId("dp_123");

    expect(findUnique).toHaveBeenCalledWith({
      where: { stripeDisputeId: "dp_123" },
    });
    expect(result).toMatchObject({ stripeDisputeId: "dp_123", status: "LOST" });
  });

  it("groups the latest LOST membership-dispute date per owner, with the createdAt fallback", async () => {
    const { prisma, groupBy } = createPrisma();
    const repo = makeDisputesRepo(prisma);
    groupBy.mockResolvedValueOnce([
      {
        ownerOrgId: "org-1",
        ownerHumanId: null,
        _max: {
          closedAt: new Date("2026-05-01T00:00:00Z"),
          createdAt: new Date("2026-04-20T00:00:00Z"),
        },
      },
      {
        // Legacy shape: LOST rows whose close was never stamped.
        ownerOrgId: null,
        ownerHumanId: "human-1",
        _max: { closedAt: null, createdAt: new Date("2026-03-10T00:00:00Z") },
      },
      {
        // Unattributed dispute: cannot inform any owner's curve — dropped.
        ownerOrgId: null,
        ownerHumanId: null,
        _max: { closedAt: new Date("2026-05-01T00:00:00Z"), createdAt: NOW },
      },
    ]);

    const rows = await repo.latestLostMembershipDisputeAtByOwner();

    expect(groupBy).toHaveBeenCalledWith({
      by: ["ownerOrgId", "ownerHumanId"],
      where: { status: "LOST", order: { kind: "MEMBERSHIP" } },
      _max: { closedAt: true, createdAt: true },
    });
    expect(rows).toEqual([
      {
        ownerOrgId: "org-1",
        ownerHumanId: null,
        latestLostAt: new Date("2026-05-01T00:00:00Z"),
      },
      {
        ownerOrgId: null,
        ownerHumanId: "human-1",
        latestLostAt: new Date("2026-03-10T00:00:00Z"),
      },
    ]);
  });
});

describe("makeDisputesRepo.countOpenByOwners", () => {
  it("returns [] without querying when both owner lists are empty", async () => {
    const { prisma, groupBy } = createPrisma();
    const repo = makeDisputesRepo(prisma);
    await expect(
      repo.countOpenByOwners({ orgIds: [], humanIds: [] }),
    ).resolves.toEqual([]);
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("groups OPEN/UNDER_REVIEW disputes by owner, scoped to the requested ids", async () => {
    const { prisma, groupBy } = createPrisma();
    const repo = makeDisputesRepo(prisma);
    groupBy.mockResolvedValueOnce([
      { ownerOrgId: "org-1", ownerHumanId: null, _count: { _all: 2 } },
      { ownerOrgId: null, ownerHumanId: "human-1", _count: { _all: 1 } },
      // Unattributed row: dropped rather than reported as a phantom owner.
      { ownerOrgId: null, ownerHumanId: null, _count: { _all: 5 } },
    ]);

    const rows = await repo.countOpenByOwners({
      orgIds: ["org-1"],
      humanIds: ["human-1"],
    });

    expect(groupBy).toHaveBeenCalledWith({
      by: ["ownerOrgId", "ownerHumanId"],
      where: {
        status: { in: ["OPEN", "UNDER_REVIEW"] },
        OR: [
          { ownerOrgId: { in: ["org-1"] } },
          { ownerHumanId: { in: ["human-1"] } },
        ],
      },
      _count: { _all: true },
    });
    expect(rows).toEqual([
      { ownerOrgId: "org-1", ownerHumanId: null, openDisputeCount: 2 },
      { ownerOrgId: null, ownerHumanId: "human-1", openDisputeCount: 1 },
    ]);
  });

  it("omits the empty owner arm from the OR", async () => {
    const { prisma, groupBy } = createPrisma();
    const repo = makeDisputesRepo(prisma);
    groupBy.mockResolvedValueOnce([]);
    await repo.countOpenByOwners({ orgIds: ["org-1"], humanIds: [] });
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: ["OPEN", "UNDER_REVIEW"] },
          OR: [{ ownerOrgId: { in: ["org-1"] } }],
        },
      }),
    );
  });
});

function createPrisma() {
  const findUnique = vi.fn();
  const upsert = vi.fn();
  const groupBy = vi.fn();
  const prisma = {
    dispute: { findUnique, upsert, groupBy },
  } as unknown as PrismaClientOrTx;

  return { prisma, findUnique, upsert, groupBy };
}

function buildDisputeRow(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: "dispute-1",
    stripeDisputeId: "dp_123",
    stripeChargeId: "ch_123",
    paymentIntentId: "pi_123",
    orderId: "order-1",
    ownerSubjectType: "ORGANIZATION",
    ownerSubjectId: "org-1",
    ownerOrgId: "org-1",
    ownerHumanId: null,
    amountCents: 5_000,
    currency: "usd",
    reason: "fraudulent",
    status: "OPEN",
    triageReason: null,
    linkedAt: NOW,
    evidenceDueBy: NOW,
    fundsWithdrawnAt: null,
    closedAt: null,
    outcome: null,
    metadata: { stripeEventType: "charge.dispute.created" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}
