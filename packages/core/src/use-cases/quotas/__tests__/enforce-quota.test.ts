import { describe, expect, it, vi } from "vitest";
import type { TxRepos } from "@th/ports/repos";
import { QUOTA_UNLIMITED } from "@th/types/repos/resource-quotas";
import { enforceQuota, incrementResourceUsage } from "../enforce-quota";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeTxRepos(overrides?: {
  limitValue?: bigint;
  currentUsage?: bigint;
  hasPending?: boolean;
}) {
  const rq = {
    getEffectiveQuota: vi.fn(async () => ({
      kind: "ORGS_OWNED" as const,
      limitValue: overrides?.limitValue ?? 3n,
      currentUsage: overrides?.currentUsage ?? 0n,
      isOverride: false,
    })),
    hasPendingExpansionRequest: vi.fn(
      async () => overrides?.hasPending ?? false,
    ),
    incrementUsage: vi.fn(async (input: any) => ({
      id: "usage-1",
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      kind: input.kind,
      currentUsage: (overrides?.currentUsage ?? 0n) + input.delta,
      updatedAt: new Date(),
      createdAt: new Date(),
    })),
  };

  return { resourceQuotas: rq } as unknown as TxRepos;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("enforceQuota", () => {
  it("passes when usage is below limit", async () => {
    const tx = makeTxRepos({ limitValue: 5n, currentUsage: 2n });
    await expect(
      enforceQuota(tx, {
        subjectType: "HUMAN",
        subjectId: "h1",
        kind: "ORGS_OWNED",
      }),
    ).resolves.toBeUndefined();
  });

  it("passes when usage is exactly at limit minus delta", async () => {
    const tx = makeTxRepos({ limitValue: 3n, currentUsage: 2n });
    await expect(
      enforceQuota(tx, {
        subjectType: "HUMAN",
        subjectId: "h1",
        kind: "ORGS_OWNED",
        delta: 1n,
      }),
    ).resolves.toBeUndefined();
  });

  it("throws quota_exceeded when usage + delta > limit", async () => {
    const tx = makeTxRepos({ limitValue: 3n, currentUsage: 3n });
    await expect(
      enforceQuota(tx, {
        subjectType: "HUMAN",
        subjectId: "h1",
        kind: "ORGS_OWNED",
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "quota_exceeded",
      meta: {
        kind: "ORGS_OWNED",
        subjectType: "HUMAN",
        subjectId: "h1",
        limitValue: "3",
        currentUsage: "3",
        hasPendingExpansionRequest: false,
      },
    });
  });

  it("throws quota_exceeded with hasPendingExpansionRequest=true when pending", async () => {
    const tx = makeTxRepos({
      limitValue: 3n,
      currentUsage: 3n,
      hasPending: true,
    });
    await expect(
      enforceQuota(tx, {
        subjectType: "HUMAN",
        subjectId: "h1",
        kind: "ORGS_OWNED",
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "quota_exceeded",
      meta: {
        hasPendingExpansionRequest: true,
      },
    });
  });

  it("uses delta=1n by default", async () => {
    const tx = makeTxRepos({ limitValue: 3n, currentUsage: 2n });
    // Should pass: 2 + 1 = 3 which is not > 3
    await expect(
      enforceQuota(tx, {
        subjectType: "HUMAN",
        subjectId: "h1",
        kind: "ORGS_OWNED",
      }),
    ).resolves.toBeUndefined();
  });

  it("respects custom delta for byte-based quotas", async () => {
    const tx = makeTxRepos({
      limitValue: 1_073_741_824n, // 1 GiB
      currentUsage: 1_073_000_000n,
    });
    // Adding 100 bytes should still fit (1_073_000_100 <= 1_073_741_824)
    await expect(
      enforceQuota(tx, {
        subjectType: "ORG",
        subjectId: "org1",
        kind: "STORAGE_BYTES_ORG",
        delta: 100n,
      }),
    ).resolves.toBeUndefined();

    // Adding 800_000 bytes should still fit (1_073_800_000 > 1_073_741_824)
    // Actually 1_073_000_000 + 800_000 = 1_073_800_000 > 1_073_741_824, so should exceed
    await expect(
      enforceQuota(tx, {
        subjectType: "ORG",
        subjectId: "org1",
        kind: "STORAGE_BYTES_ORG",
        delta: 800_000n,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "quota_exceeded",
    });
  });

  it("skips enforcement when limitValue is QUOTA_UNLIMITED", async () => {
    const tx = makeTxRepos({
      limitValue: QUOTA_UNLIMITED,
      currentUsage: 999_999n,
    });
    await expect(
      enforceQuota(tx, {
        subjectType: "ORG",
        subjectId: "org1",
        kind: "EVENTS_PER_ORG",
      }),
    ).resolves.toBeUndefined();

    // getEffectiveQuota is still called to resolve the quota …
    expect(tx.resourceQuotas.getEffectiveQuota).toHaveBeenCalled();
    // … but hasPendingExpansionRequest should never be checked
    expect(tx.resourceQuotas.hasPendingExpansionRequest).not.toHaveBeenCalled();
  });
});

describe("incrementResourceUsage", () => {
  it("delegates to tx.resourceQuotas.incrementUsage", async () => {
    const tx = makeTxRepos();
    await incrementResourceUsage(tx, {
      subjectType: "ORG",
      subjectId: "org1",
      kind: "EVENTS_PER_ORG",
    });

    expect(tx.resourceQuotas.incrementUsage).toHaveBeenCalledWith({
      subjectType: "ORG",
      subjectId: "org1",
      kind: "EVENTS_PER_ORG",
      delta: 1n,
    });
  });

  it("passes custom delta", async () => {
    const tx = makeTxRepos();
    await incrementResourceUsage(tx, {
      subjectType: "ORG",
      subjectId: "org1",
      kind: "STORAGE_BYTES_ORG",
      delta: 5_000_000n,
    });

    expect(tx.resourceQuotas.incrementUsage).toHaveBeenCalledWith({
      subjectType: "ORG",
      subjectId: "org1",
      kind: "STORAGE_BYTES_ORG",
      delta: 5_000_000n,
    });
  });

  it("supports negative delta for decrement", async () => {
    const tx = makeTxRepos({ currentUsage: 5n });
    await incrementResourceUsage(tx, {
      subjectType: "ORG",
      subjectId: "org1",
      kind: "EVENTS_PER_ORG",
      delta: -1n,
    });

    expect(tx.resourceQuotas.incrementUsage).toHaveBeenCalledWith({
      subjectType: "ORG",
      subjectId: "org1",
      kind: "EVENTS_PER_ORG",
      delta: -1n,
    });
  });
});
